import express from "express";
import { parseAdoptId, parseFileName, parseRelPath, parseTtl, sendError, handleRouteError } from "./schemas";
import { existsSync, statSync, readdirSync, createReadStream } from "fs";
import { spawnSync } from "child_process";
import {
  requireClawOwner, resolveRuntimeAgentId,
  openClawWorkspaceDir,
  resolveRuntimeWorkspace,
  resolveRuntimeWorkspaceByIds,
  generateFileToken,
  streamFileDownload,
  sanitizeRelPath,
} from "./helpers";

const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "img-src 'self' data: blob: http: https:",
  "style-src 'unsafe-inline'",
  "font-src data: http: https:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

function setHtmlPreviewHeaders(res: express.Response) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.removeHeader("X-Frame-Options");
  res.setHeader("Content-Security-Policy", HTML_PREVIEW_CSP);
}

export function registerDownloadRoutes(app: express.Express) {

  // ── Sandbox 文件下载 ──────────────────────────────────────────────
  // GET /api/claw/sandbox/files?adoptId=xxx
  // GET /api/claw/sandbox/files/download?adoptId=xxx&file=yyy.csv
  app.get("/api/claw/sandbox/files", async (req, res) => {
    try {
      const adoptId = parseAdoptId(req.query.adoptId);
      // 2026-04-18 fix: requireClawOwner 是 (req,res,adoptId) 形态，不是 express middleware。
      // 之前挂在 app.get 第二参数位置会导致 adoptId=next_fn，DB 查不到 → 路由永远 404。
      // 现在在 handler 里主动调用，顺便补上归属校验（原来只查存在、没校验 userId）。
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return; // 401/403/404 已由 requireClawOwner 发出

      const runtimeAgentId = resolveRuntimeAgentId(adoptId, String((claw as any).agentId || ""));
      const filesDir = `${openClawWorkspaceDir(runtimeAgentId)}/sandbox-files`;

      let files: Array<{ name: string; size: number; mtime: string }> = [];
      try {
        files = readdirSync(filesDir).map(f => {
          const st = statSync(`${filesDir}/${f}`);
          return { name: f, size: st.size, mtime: st.mtime.toISOString() };
        }).sort((a, b) => b.mtime.localeCompare(a.mtime));
      } catch {}
      return res.json({ files });
    } catch (e: any) {
      return handleRouteError(res, e);
    }
  });

  app.get("/api/claw/sandbox/files/download", async (req, res) => {
    try {
      const adoptId = parseAdoptId(req.query.adoptId);
      const fileName = parseFileName(req.query.file);

      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;

      const runtimeAgentId = resolveRuntimeAgentId(adoptId, String((claw as any).agentId || ""));
      const filePath = `${openClawWorkspaceDir(runtimeAgentId)}/sandbox-files/${fileName}`;

      if (!existsSync(filePath)) return sendError(res, "NOT_FOUND", "file not found");


      streamFileDownload(res, filePath, fileName);
    } catch (e: any) {
      return handleRouteError(res, e);
    }
  });

  // ── Workspace file download（技能产出文件，路径在 workspace 内）──────
  app.get("/api/claw/workspace/files/download", async (req, res) => {
    try {
      const adoptId = parseAdoptId(req.query.adoptId);
      const relPath = parseRelPath(req.query.path);

      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;

      const filePath = `${resolveRuntimeWorkspace(claw, adoptId)}/${relPath}`;

      if (!existsSync(filePath)) return res.status(404).json({ error: "file not found: " + filePath });

      const fileName = relPath.split("/").pop() || "download";

      // preview 模式：HTML 文件直接以 text/html 返回（用于预览渲染）
      const isPreview = req.query.preview === "1";
      const isHtml = /\.html?$/i.test(fileName);
      if (isPreview && isHtml) {
        setHtmlPreviewHeaders(res);
        const stream = createReadStream(filePath);
        stream.on("error", (_err: any) => {
          if (!res.headersSent) res.status(500).json({ error: "file read error" });
        });
        stream.pipe(res);
        return;
      }

      streamFileDownload(res, filePath, fileName);
    } catch (e: any) {
      return handleRouteError(res, e);
    }
  });

  // ── 文件下载 Token ──────────────────────────────────────────────────────


  // POST /api/claw/files/token  { adoptId, path, ttl? }
  // 验证 ownership 后生成短期 token，返回可直接下载的 URL（无需 session cookie）
  app.post("/api/claw/files/token", async (req, res) => {
    try {
      const body = req.body || {};
      const adoptId = parseAdoptId(body.adoptId);
      const filePath = parseRelPath(body.path, "path");

      const claw = await requireClawOwner(req, res, String(adoptId));
      if (!claw) return;

      // claw.adoptId 是 DB 中的权威值（含 lgc- 前缀），用它来 resolve runtimeAgentId
      const canonicalAdoptId = String((claw as any).adoptId || adoptId);
      const runtimeAgentId = resolveRuntimeAgentId(canonicalAdoptId, String((claw as any).agentId || ""));
      const relPath = filePath;
      const absPath = `${resolveRuntimeWorkspaceByIds(canonicalAdoptId, runtimeAgentId)}/${relPath}`;

      if (!existsSync(absPath)) return res.status(404).json({ error: "file not found: " + absPath });

      const tokenTtl = parseTtl(body.ttl, parseInt(process.env.FILE_DOWNLOAD_TOKEN_TTL_SECONDS || "1800", 10));
      const token = generateFileToken(String(adoptId), runtimeAgentId, relPath, tokenTtl);
      const exp = Math.floor(Date.now() / 1000) + tokenTtl;

      return res.json({ token, url: `/api/claw/files/download?token=${encodeURIComponent(token)}`, exp, ttl: tokenTtl });
    } catch (e: any) {
      return handleRouteError(res, e);
    }
  });

  // GET /api/claw/files/download?token=xxx
  // 验证签名 token，不查 session，直接返回文件
  app.get("/api/claw/files/download", async (req, res, next) => {
    try {
      const rawToken = String(req.query.token || "");
      if (!rawToken) return next();

      const dotIdx = rawToken.lastIndexOf(".");
      if (dotIdx < 0) return sendError(res, "BAD_REQUEST", "invalid token format");
      const payload = rawToken.slice(0, dotIdx);
      const sig = rawToken.slice(dotIdx + 1);

      const { createHmac } = await import("crypto");
      // secret 必须和 helpers.ts:generateFileToken 对齐：FILE_TOKEN_SECRET 优先，回退 JWT_SECRET
      const secret = process.env.FILE_TOKEN_SECRET || process.env.JWT_SECRET || "";
      if (!secret) return sendError(res, "INTERNAL_ERROR", "file token secret not configured");
      const expectedSig = createHmac("sha256", secret).update(payload).digest("base64url");
      if (sig !== expectedSig) return sendError(res, "UNAUTHORIZED", "invalid token signature");

      let parsed: any;
      try {
        parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        return sendError(res, "BAD_REQUEST", "malformed token");
      }

      if (!parsed.exp || Math.floor(Date.now() / 1000) > parsed.exp) {
        return sendError(res, "UNAUTHORIZED", "token expired");
      }

      const relPath = sanitizeRelPath(String(parsed.path || "")) || "";
      const adoptId = String(parsed.adoptId || "");
      const filePath = `${resolveRuntimeWorkspaceByIds(adoptId, String(parsed.runtimeAgentId || ""))}/${relPath}`;

      if (!existsSync(filePath)) return sendError(res, "NOT_FOUND", "file not found");

      const fileName = relPath.split("/").pop() || "download";

      // preview 模式：HTML 文件直接以 text/html 返回（用于预览渲染）
      const isPreview = req.query.preview === "1";
      const isHtml = /\.html?$/i.test(fileName);
      if (isPreview && isHtml) {
        setHtmlPreviewHeaders(res);
        const stream = createReadStream(filePath);
        stream.on("error", (_err: any) => {
          if (!res.headersSent) res.status(500).json({ error: "file read error" });
        });
        stream.pipe(res);
        return;
      }

      streamFileDownload(res, filePath, fileName);
    } catch (e: any) {
      return handleRouteError(res, e);
    }
  });


  // ── Workspace 文件运行（在隔离沙箱中执行） ─────────────────────────
  // POST /api/claw/workspace/run  { adoptId, path }
  app.post("/api/claw/workspace/run", async (req, res) => {
    try {
      const body = req.body || {};
      const adoptId = parseAdoptId(body.adoptId);
      const relPath = parseRelPath(body.path, "path");

      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;

      const workspaceDir = resolveRuntimeWorkspace(claw, adoptId);
      const filePath = `${workspaceDir}/${relPath}`;

      if (!existsSync(filePath)) return sendError(res, "NOT_FOUND", "file not found");

      // 根据扩展名选择运行时
      const ext = relPath.split(".").pop()?.toLowerCase() || "";
      // 注：.ts 不支持——沙箱是 --network=none + --read-only，npx tsx 需要拉包/写缓存会失败
      const runtimeMap: Record<string, string[]> = {
        py:   ["python3", `/workspace/${relPath}`],
        js:   ["node",    `/workspace/${relPath}`],
        sh:   ["sh",      `/workspace/${relPath}`],
        bash: ["bash",    `/workspace/${relPath}`],
      };
      const runCmd = runtimeMap[ext];
      if (!runCmd) return sendError(res, "BAD_REQUEST", `不支持运行 .${ext} 文件`);

      // Docker 沙箱执行
      const image = ext === "py" ? "python:3.11-slim" : "node:20-slim";
      const timeoutMs = 15000;
      const dockerArgs = [
        "run", "--rm",
        "--network=none",
        "--read-only",
        "--tmpfs=/tmp:size=50m",
        "--memory=256m",
        "--cpus=0.5",
        "--pids-limit=50",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "-v", `${workspaceDir}:/workspace:ro`,
        "-w", "/workspace",
        image,
        ...runCmd,
      ];

      const result = spawnSync("docker", dockerArgs, {
        timeout: timeoutMs,
        encoding: "utf8",
        maxBuffer: 64 * 1024,
      });

      const stdout = (result.stdout || "").slice(0, 64 * 1024);
      const stderr = (result.stderr || "").slice(0, 64 * 1024);

      return res.json({
        ok: true,
        exitCode: result.status ?? 1,
        stdout,
        stderr,
        durationMs: 0,
        signal: result.signal || null,
      });
    } catch (e: any) {
      return handleRouteError(res, e);
    }
  });

}
