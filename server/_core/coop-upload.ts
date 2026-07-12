/**
 * coop-upload.ts — 协作 session 文件上传/下载
 *
 * - 上传：POST /api/coop/upload  body { sessionId, requestId, filename, contentBase64 }
 *   * 权限：登录 user 必须是 session 成员（targetUserId）或 creator_user_id
 *   * 安全：sanitize 文件名 + 大小限制 50MB + 路径不可逃逸
 *   * 存储：/root/linggan-platform/data/coop-uploads/{sessionId}/{requestId}/{ts}-{safeName}
 *   * 返回：{ ok: true, name, url, size }
 *
 * - 下载：GET /api/coop/file?sessionId=X&requestId=Y&file=Z
 *   * 权限同上（任何 session 成员都能看附件，发起人也能）
 *   * Stream 给客户端，attachment 模式触发浏览器下载
 */
import express from "express";
import { existsSync, statSync, createReadStream } from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { resolveRequesterUserId } from "./helpers";
import {
  createCoopFileFromBuffer,
  getCoopFileForDownload,
  safeCoopFilename,
} from "../db/coop-files";
import { decodeBase64Strict, scanUploadForMalware, validateUploadContent } from "./upload-security";

const APP_ROOT = process.env.APP_ROOT || process.cwd();
const COOP_UPLOAD_DIR = `${APP_ROOT}/data/coop-uploads`;
const MAX_BYTES = 50 * 1024 * 1024; // 50MB
const ALLOWED_EXTENSIONS = new Set([
  "md", "txt", "csv", "json", "yaml", "yml", "xml", "toml", "ini", "conf", "log",
  "pdf", "docx", "xls", "xlsx", "pptx", "png", "jpg", "jpeg", "gif", "svg", "webp",
  "html", "htm", "css", "zip", "tar", "gz", "mp3", "wav", "m4a", "aac", "webm", "ogg", "mp4",
]);

// 校验当前 user 是否可查看该协作 session，且 requestId 属于该 session。
async function userCanAccessCoop(userId: number, sessionId: string, requestId: number): Promise<boolean> {
  const { getDb } = await import("../db");
  const { clawCollabRequests } = await import("../../drizzle/schema");
  // Dynamic import keeps this standalone Express route decoupled from DB helper load order.
  const { canViewCoopSession } = await import("../db/coop-identity");
  const db = await getDb();
  if (!db) return false;

  const access = await canViewCoopSession(userId, sessionId);
  if (!access.ok) return false;

  const reqRows = await db
    .select({ sessionId: clawCollabRequests.sessionId })
    .from(clawCollabRequests)
    .where(eq(clawCollabRequests.id, requestId))
    .limit(1);
  return reqRows[0]?.sessionId === sessionId;
}

export function registerCoopUploadRoutes(app: express.Express) {
  // ── 上传 ─────────────────────────────────────────────────
  app.post("/api/coop/upload", async (req, res) => {
    try {
      const userId = await resolveRequesterUserId(req, res);
      if (!userId) { res.status(401).json({ error: "请先登录" }); return; }

      const { sessionId, requestId, filename, contentBase64 } = (req.body || {}) as any;
      if (!sessionId || !requestId || !filename || !contentBase64) {
        res.status(400).json({ error: "sessionId/requestId/filename/contentBase64 必填" });
        return;
      }
      const sid = String(sessionId).trim().slice(0, 80);
      const rid = parseInt(String(requestId), 10);
      if (!sid.match(/^[a-zA-Z0-9_-]+$/) || !Number.isInteger(rid) || rid <= 0) {
        res.status(400).json({ error: "sessionId / requestId 格式不合法" });
        return;
      }

      // 权限校验
      const ok = await userCanAccessCoop(userId, sid, rid);
      if (!ok) { res.status(403).json({ error: "无权访问该协作 session" }); return; }

      // base64 解码 + size check
      const buf = decodeBase64Strict(String(contentBase64));
      if (!buf) {
        res.status(400).json({ error: "invalid base64" });
        return;
      }
      if (buf.length <= 0 || buf.length > MAX_BYTES) {
        res.status(400).json({ error: `文件大小必须在 1B - ${MAX_BYTES / 1024 / 1024}MB 之间，当前 ${buf.length}B` });
        return;
      }
      const safeName = safeCoopFilename(String(filename));
      const ext = path.extname(safeName).slice(1).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        res.status(400).json({ error: `file type .${ext || "unknown"} not allowed` });
        return;
      }
      const contentValidation = validateUploadContent(ext, buf);
      if (!contentValidation.ok) {
        res.status(400).json({ error: "file_content_not_allowed", message: contentValidation.error });
        return;
      }
      const malwareScan = scanUploadForMalware(buf);
      if (!malwareScan.ok) {
        res.status(400).json({ error: "file_malware_scan_failed", message: malwareScan.error });
        return;
      }

      const file = await createCoopFileFromBuffer({
        sessionId: sid,
        requestId: rid,
        ownerUserId: userId,
        name: safeName,
        content: buf,
        mime: String(req.body?.mime || "") || null,
        sourceType: "upload",
      });
      res.json({ ok: true, fileId: file.id, name: file.name, url: file.url, size: file.size });
    } catch (e: any) {
      console.error("[coop-upload] error:", e);
      res.status(500).json({ error: e?.message || "upload failed" });
    }
  });

  // ── 下载 ─────────────────────────────────────────────────
  app.get("/api/coop/file", async (req, res) => {
    try {
      const userId = await resolveRequesterUserId(req, res);
      if (!userId) { res.status(401).json({ error: "请先登录" }); return; }

      const sid = String(req.query.sessionId || "").trim().slice(0, 80);
      const rid = parseInt(String(req.query.requestId || "0"), 10);
      const file = String(req.query.file || "").trim();
      if (!sid.match(/^[a-zA-Z0-9_-]+$/) || !Number.isInteger(rid) || rid <= 0 || !file) {
        res.status(400).json({ error: "参数不合法" }); return;
      }
      // 严格防 path traversal：file 必须只包含 . _ - 字母数字 中文
      const safeFile = safeCoopFilename(file);
      if (safeFile !== file) { res.status(400).json({ error: "文件名不合法" }); return; }

      const ok = await userCanAccessCoop(userId, sid, rid);
      if (!ok) { res.status(403).json({ error: "无权访问该协作 session 的文件" }); return; }

      const fp = path.join(COOP_UPLOAD_DIR, sid, String(rid), safeFile);
      // 二次校验：resolve 后必须仍在 COOP_UPLOAD_DIR 下
      const resolved = path.resolve(fp);
      const expectedRoot = path.resolve(COOP_UPLOAD_DIR);
      if (!resolved.startsWith(expectedRoot + path.sep)) {
        res.status(400).json({ error: "路径越权" }); return;
      }
      if (!existsSync(resolved)) { res.status(404).json({ error: "文件不存在" }); return; }

      const stat = statSync(resolved);
      // 去掉 ts 前缀显示给用户：{ts}-{safeName} → {safeName}
      const display = safeFile.replace(/^\d+-/, "");
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", stat.size);
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(display)}`);
      createReadStream(resolved).pipe(res);
    } catch (e: any) {
      console.error("[coop-file] error:", e);
      res.status(500).json({ error: e?.message || "download failed" });
    }
  });

  // ── 新共享文件下载：GET /api/coop/files/:fileId ────────────────
  app.get("/api/coop/files/:fileId", async (req, res) => {
    try {
      const userId = await resolveRequesterUserId(req, res);
      if (!userId) { res.status(401).json({ error: "请先登录" }); return; }
      const fileId = Number(req.params.fileId || 0);
      if (!Number.isInteger(fileId) || fileId <= 0) {
        res.status(400).json({ error: "fileId 不合法" });
        return;
      }
      const found = await getCoopFileForDownload(fileId, userId);
      if (!found) {
        res.status(404).json({ error: "文件不存在或无权访问" });
        return;
      }
      const stat = statSync(found.absPath);
      res.setHeader("Content-Type", found.view.mime || "application/octet-stream");
      res.setHeader("Content-Length", stat.size);
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(found.view.name)}`);
      createReadStream(found.absPath).pipe(res);
    } catch (e: any) {
      console.error("[coop-file] shared download error:", e);
      res.status(500).json({ error: e?.message || "download failed" });
    }
  });
}
