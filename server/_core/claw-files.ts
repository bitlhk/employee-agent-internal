/**
 * Files Capability router — unified IO-layer file CRUD across runtimes.
 * Per CODING_GUIDELINES rules 1-6 (entry-point dispatch / runtime-specific in *-files.ts / IO layer only).
 */
import express from "express";
import { createHash } from "crypto";
import path from "path";
import { existsSync, lstatSync, statSync, readdirSync, readFileSync, createReadStream, writeFileSync, unlinkSync, rmSync } from "fs";
import { isJiuwenClawAdoptId, requireClawOwner, resolveRuntimeWorkspace } from "./helpers";
import { auditActor, auditErrorMetadata, auditRequest, recordAuditBestEffort, recordAuditRequired } from "./audit-events";
import { resolveExistingWorkspacePath, resolveWorkspaceDeletePath, resolveWorkspaceWritePath } from "./file-path-security";
import { skillSourceDirsForRuntime, skillStoreAgentDir } from "./skills/skill-store";
import { decodeBase64Strict, scanUploadForMalware, validateUploadContent } from "./upload-security";

type LinggFileNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modifiedAt?: string;
};

type FilesProviderCapabilities = {
  supportsList: boolean;
  supportsRead: boolean;
  supportsDownload: boolean;
  supportsUpload: boolean;
  supportsDelete: boolean;
  maxUploadBytes: number;
};

const OPENCLAW_FILES_CAPABILITIES: FilesProviderCapabilities = {
  supportsList: true,
  supportsRead: true,
  supportsDownload: true,
  supportsUpload: true,
  supportsDelete: true,
  maxUploadBytes: 50 * 1024 * 1024,
};

const MAX_LIST_DEPTH = 4;
const MAX_FILES_PER_LIST = 2000;
const MAX_READ_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_FILES_PER_WORKSPACE = 2000;
const PROTECTED_ROOT_FILES = new Set([
  "AGENT.md",
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "MEMORY.md",
  "IDENTITY.md",
  "HEARTBEAT.md",
  "USER.md",
]);

// File type whitelist (defense against agent prompt-injection-via-uploaded-file)
const ALLOWED_EXTENSIONS = new Set([
  "md", "txt", "csv", "json", "yaml", "yml", "xml", "toml", "ini", "conf", "log",
  "pdf", "docx", "xls", "xlsx", "pptx",
  "png", "jpg", "jpeg", "gif", "svg", "webp",
  "html", "htm", "css",
  "zip", "tar", "gz",
]);
function safeFilename(name: string): string {
  // Strip path separators / dangerous chars / leading dots / collapse '..'
  return name
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\.\.+/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 200);
}

function getExt(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i < 0 ? "" : filename.slice(i + 1).toLowerCase();
}

function isAllowedUploadExtension(ext: string, subPath: string): boolean {
  return ALLOWED_EXTENSIONS.has(ext);
}

function uploadLimitFor(_ext: string, _subPath: string): number {
  return MAX_UPLOAD_BYTES;
}

function runtimeName(adoptId: string): "openclaw" | "jiuwenclaw" {
  if (isJiuwenClawAdoptId(adoptId)) return "jiuwenclaw";
  return "openclaw";
}

function runtimeWorkspace(claw: any, adoptId: string): string {
  return resolveRuntimeWorkspace(claw, adoptId);
}

function fileSha256(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex");
}

function auditFileMetadata(args: {
  path: string;
  filename?: string;
  ext?: string;
  size?: number | null;
  sha256?: string | null;
  operation: string;
  uploadLimitBytes?: number;
  deleted?: string;
}) {
  return {
    path: args.path,
    filename: args.filename || path.posix.basename(args.path),
    ext: args.ext || getExt(args.filename || args.path),
    sizeBytes: args.size ?? null,
    sha256: args.sha256 || null,
    operation: args.operation,
    uploadLimitBytes: args.uploadLimitBytes,
    deleted: args.deleted,
  };
}

async function recordFileAudit(args: {
  req: express.Request;
  claw: any;
  adoptId: string;
  action: "file.uploaded" | "file.read" | "file.downloaded" | "file.deleted" | "file.delete.denied" | "file.upload.denied";
  result?: "success" | "failed" | "denied" | "warning";
  severity?: "info" | "low" | "medium" | "high" | "critical";
  path: string;
  filename?: string;
  ext?: string;
  size?: number | null;
  sha256?: string | null;
  runtime?: string;
  errorCode?: string | null;
  policyCode?: string | null;
  metadata?: Record<string, unknown>;
  required?: boolean;
}) {
  const runtime = args.runtime || runtimeName(args.adoptId);
  const input = {
    action: args.action,
    result: args.result || "success",
    severity: args.severity || "info",
    ...auditActor({
      id: args.claw?.userId,
      name: args.claw?.userName,
      email: args.claw?.userEmail,
      role: args.claw?.permissionProfile,
      groupId: args.claw?.userGroupId,
    }),
    ...auditRequest(args.req),
    targetType: "file",
    targetId: args.path,
    targetName: args.filename || path.posix.basename(args.path),
    resourceType: "workspace_file",
    resourceId: args.sha256 || args.path,
    resourceName: args.path,
    agentInstanceId: args.adoptId,
    runtimeType: runtime,
    runtimeAgentId: args.claw?.agentId ? String(args.claw.agentId) : null,
    errorCode: args.errorCode || null,
    policyCode: args.policyCode || null,
    metadata: {
      ...auditFileMetadata({
        path: args.path,
        filename: args.filename,
        ext: args.ext,
        size: args.size,
        sha256: args.sha256,
        operation: args.action,
      }),
      ...args.metadata,
    },
  };
  if (args.required) await recordAuditRequired(input);
  else await recordAuditBestEffort(input);
}

function approvedSkillRoots(adoptId: string): string[] {
  return [
    ...skillSourceDirsForRuntime(),
    skillStoreAgentDir(adoptId),
    "/usr/lib/node_modules/openclaw/skills",
  ];
}

function isProtectedRootFile(relPath: string): boolean {
  const normalized = path.posix.normalize(String(relPath || "").replace(/\\/g, "/"));
  return !normalized.includes("/") && PROTECTED_ROOT_FILES.has(normalized);
}

function isManagedSkillsPath(relPath: string): boolean {
  const normalized = path.posix.normalize(String(relPath || "").replace(/\\/g, "/")).replace(/^\/+/, "");
  return normalized === "skills" || normalized.startsWith("skills/");
}

function openclawListFiles(workspace: string, subPath: string = "", adoptId = ""): LinggFileNode[] {
  if (!existsSync(workspace)) return [];
  const allowedRoots = isManagedSkillsPath(subPath) ? approvedSkillRoots(adoptId) : [];
  const startAbs = resolveExistingWorkspacePath(workspace, subPath, allowedRoots);
  if (!startAbs) return [];
  const out: LinggFileNode[] = [];
  function walk(absPath: string, relPath: string, depth: number) {
    if (depth > MAX_LIST_DEPTH || out.length >= MAX_FILES_PER_LIST) return;
    let entries: string[];
    try { entries = readdirSync(absPath); } catch { return; }
    for (const name of entries) {
      if (out.length >= MAX_FILES_PER_LIST) break;
      if (name.startsWith(".")) continue;
      const childRel = relPath ? `${relPath}/${name}` : name;
      const childReal = resolveExistingWorkspacePath(
        workspace,
        childRel,
        isManagedSkillsPath(childRel) ? approvedSkillRoots(adoptId) : [],
      );
      if (!childReal) continue;
      let st;
      try { st = statSync(childReal); } catch { continue; }
      out.push({
        name, path: childRel,
        type: st.isDirectory() ? "directory" : "file",
        size: st.isDirectory() ? undefined : Number(st.size),
        modifiedAt: st.mtime.toISOString(),
      });
      if (st.isDirectory()) walk(childReal, childRel, depth + 1);
    }
  }
  walk(startAbs, subPath, 0);
  return out;
}

export function registerFilesRoutes(app: express.Express) {

  app.get("/api/claw/files/capabilities", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      if (adoptId.startsWith("lgh-")) return res.status(410).json({ error: "HERMES_RUNTIME_ARCHIVED" });
      return res.json({ runtime: runtimeName(adoptId), capabilities: OPENCLAW_FILES_CAPABILITIES });
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message || "capabilities failed") });
    }
  });

  app.get("/api/claw/files/list", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const subPath = String(req.query.path || "").trim();
      if (adoptId.startsWith("lgh-")) return res.status(410).json({ error: "HERMES_RUNTIME_ARCHIVED" });
      const workspace = runtimeWorkspace(claw, adoptId);
      const files = openclawListFiles(workspace, subPath, adoptId);
      return res.json({ runtime: runtimeName(adoptId), capabilities: OPENCLAW_FILES_CAPABILITIES, files });
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message || "list failed") });
    }
  });

  app.get("/api/claw/files/read", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      const relPath = String(req.query.path || "").trim();
      if (!adoptId || !relPath) return res.status(400).json({ error: "adoptId and path required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      if (adoptId.startsWith("lgh-")) return res.status(410).json({ error: "HERMES_RUNTIME_ARCHIVED" });
      const workspace = runtimeWorkspace(claw, adoptId);
      const abs = resolveExistingWorkspacePath(workspace, relPath, isManagedSkillsPath(relPath) ? approvedSkillRoots(adoptId) : []);
      if (!abs || !existsSync(abs)) return res.status(404).json({ error: "file not found" });
      const st = statSync(abs);
      if (!st.isFile() || st.size > MAX_READ_BYTES) return res.status(413).json({ error: "not a file or too large" });
      const content = readFileSync(abs, "utf8");
      await recordFileAudit({
        req,
        claw,
        adoptId,
        action: "file.read",
        path: relPath,
        size: Number(st.size),
        runtime: runtimeName(adoptId),
        metadata: { readLimitBytes: MAX_READ_BYTES },
      });
      return res.json({ runtime: runtimeName(adoptId), path: relPath, content, size: Number(st.size), modifiedAt: st.mtime.toISOString() });
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message || "read failed") });
    }
  });

  app.get("/api/claw/files/download", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      const relPath = String(req.query.path || "").trim();
      if (!adoptId || !relPath) return res.status(400).json({ error: "adoptId and path required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      let absPath: string | null = null;
      if (adoptId.startsWith("lgh-")) return res.status(410).json({ error: "HERMES_RUNTIME_ARCHIVED" });
      const workspace = runtimeWorkspace(claw, adoptId);
      absPath = resolveExistingWorkspacePath(workspace, relPath, isManagedSkillsPath(relPath) ? approvedSkillRoots(adoptId) : []);
      if (absPath && (!existsSync(absPath) || !statSync(absPath).isFile())) absPath = null;
      if (!absPath) return res.status(404).json({ error: "file not found" });
      const filename = path.basename(absPath);
      const st = statSync(absPath);
      await recordFileAudit({
        req,
        claw,
        adoptId,
        action: "file.downloaded",
        path: relPath,
        filename,
        size: Number(st.size),
        runtime: runtimeName(adoptId),
        required: true,
      });
      res.setHeader("Content-Disposition", `attachment; filename=\"${encodeURIComponent(filename)}\"`);
      res.setHeader("Content-Type", "application/octet-stream");
      createReadStream(absPath).pipe(res);
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message || "download failed") });
    }
  });

  // POST upload — body { adoptId, path?, filename, contentBase64 }
  // 4 道安全限制: type 白名单 / 50MB / 200 文件 quota / filename sanitize
  app.post("/api/claw/files/upload", async (req, res) => {
    try {
      const body = (req.body || {}) as any;
      const adoptId = String(body.adoptId || "").trim();
      const subPath = String(body.path || "").trim();
      const filenameRaw = String(body.filename || "").trim();
      const contentBase64 = String(body.contentBase64 || "");
      if (!adoptId || !filenameRaw || !contentBase64) return res.status(400).json({ error: "adoptId, filename, contentBase64 required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const filename = safeFilename(filenameRaw);
      if (!filename) return res.status(400).json({ error: "invalid filename" });
      const ext = getExt(filename);
      if (!isAllowedUploadExtension(ext, subPath)) {
        await recordFileAudit({
          req,
          claw,
          adoptId,
          action: "file.upload.denied",
          result: "denied",
          severity: "medium",
          path: subPath ? `${subPath}/${filename}` : filename,
          filename,
          ext,
          runtime: runtimeName(adoptId),
          errorCode: "FILE_TYPE_NOT_ALLOWED",
          policyCode: "upload_extension_whitelist",
          metadata: { allowedExtensions: Array.from(ALLOWED_EXTENSIONS) },
        });
        return res.status(400).json({ error: `file type .${ext} not allowed` });
      }
      let buf: Buffer;
      const decoded = decodeBase64Strict(contentBase64);
      if (!decoded) return res.status(400).json({ error: "invalid base64" });
      buf = decoded;
      const maxUploadBytes = uploadLimitFor(ext, subPath);
      if (buf.length > maxUploadBytes) {
        await recordFileAudit({
          req,
          claw,
          adoptId,
          action: "file.upload.denied",
          result: "denied",
          severity: "medium",
          path: subPath ? `${subPath}/${filename}` : filename,
          filename,
          ext,
          size: buf.length,
          runtime: runtimeName(adoptId),
          errorCode: "FILE_TOO_LARGE",
          policyCode: "upload_size_limit",
          metadata: { uploadLimitBytes: maxUploadBytes },
        });
        return res.status(413).json({ error: `file too large: ${buf.length}` });
      }
      const contentValidation = validateUploadContent(ext, buf);
      if (!contentValidation.ok) {
        return res.status(400).json({ error: "file_content_not_allowed", message: contentValidation.error });
      }
      const malwareScan = scanUploadForMalware(buf);
      if (!malwareScan.ok) {
        return res.status(400).json({ error: "file_malware_scan_failed", message: malwareScan.error });
      }
      const sha256 = fileSha256(buf);
      if (adoptId.startsWith("lgh-")) return res.status(410).json({ error: "HERMES_RUNTIME_ARCHIVED" });
      const existingFiles: LinggFileNode[] = openclawListFiles(runtimeWorkspace(claw, adoptId), "", adoptId);
      const fileCount = existingFiles.filter(f => f.type === "file").length;
      if (fileCount >= MAX_FILES_PER_WORKSPACE) {
        await recordFileAudit({
          req,
          claw,
          adoptId,
          action: "file.upload.denied",
          result: "denied",
          severity: "medium",
          path: subPath ? `${subPath}/${filename}` : filename,
          filename,
          ext,
          size: buf.length,
          sha256,
          runtime: runtimeName(adoptId),
          errorCode: "WORKSPACE_FILE_QUOTA_EXCEEDED",
          policyCode: "workspace_file_quota",
          metadata: { fileCount, maxFilesPerWorkspace: MAX_FILES_PER_WORKSPACE },
        });
        return res.status(429).json({ error: `workspace file count >= ${MAX_FILES_PER_WORKSPACE}` });
      }
      const targetRel = subPath ? `${subPath}/${filename}` : filename;
      if (isManagedSkillsPath(targetRel)) {
        await recordFileAudit({
          req,
          claw,
          adoptId,
          action: "file.upload.denied",
          result: "denied",
          severity: "medium",
          path: targetRel,
          filename,
          ext,
          size: buf.length,
          sha256,
          runtime: runtimeName(adoptId),
          errorCode: "MANAGED_SKILLS_PATH",
          policyCode: "skills_managed_by_registry",
        });
        return res.status(409).json({ error: "skills_directory_is_managed", message: "技能目录由平台管理，请在“我的技能”页面上传或卸载技能。" });
      }
      const ws = runtimeWorkspace(claw, adoptId);
      const abs = resolveWorkspaceWritePath(ws, targetRel);
      if (!abs) {
        await recordFileAudit({
          req,
          claw,
          adoptId,
          action: "file.upload.denied",
          result: "denied",
          severity: "high",
          path: targetRel,
          filename,
          ext,
          size: buf.length,
          sha256,
          runtime: runtimeName(adoptId),
          errorCode: "PATH_NOT_ALLOWED",
          policyCode: "workspace_path_boundary",
        });
        return res.status(400).json({ error: "path_not_allowed" });
      }
      try {
        writeFileSync(abs, buf);
        await recordFileAudit({
          req,
          claw,
          adoptId,
          action: "file.uploaded",
          path: targetRel,
          filename,
          ext,
          size: buf.length,
          sha256,
          runtime: runtimeName(adoptId),
          metadata: { uploadLimitBytes: maxUploadBytes, sourcePath: subPath || null },
        });
        return res.json({ runtime: runtimeName(adoptId), ok: true, filename, path: targetRel, size: buf.length });
      } catch (e: any) {
        return res.status(500).json({ error: `write failed: ${e?.message || e}` });
      }
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message || "upload failed") });
    }
  });

  // DELETE file or directory — body { adoptId, path }
  // 目录递归删除；realpath + workspace-root 防护避免符号链接越界
  app.delete("/api/claw/files/delete", async (req, res) => {
    try {
      const body = (req.body || {}) as any;
      const adoptId = String(body.adoptId || "").trim();
      const relPath = String(body.path || "").trim();
      if (!adoptId || !relPath) return res.status(400).json({ error: "adoptId and path required" });
      const normalized = path.posix.normalize(relPath.replace(/\\/g, "/"));
      if (normalized === "" || normalized === "." || normalized === "/" || normalized === ".." || normalized.startsWith("../")) {
        return res.status(400).json({ error: "refuse to delete workspace root" });
      }
      if (isManagedSkillsPath(normalized)) {
        const claw = await requireClawOwner(req, res, adoptId);
        if (claw) {
          await recordFileAudit({
            req,
            claw,
            adoptId,
            action: "file.delete.denied",
            result: "denied",
            severity: "medium",
            path: normalized,
            runtime: runtimeName(adoptId),
            errorCode: "MANAGED_SKILLS_PATH",
            policyCode: "skills_managed_by_registry",
          });
        }
        return res.status(409).json({ error: "skills_directory_is_managed", message: "技能目录由平台管理，请在“我的技能”页面卸载或删除技能。" });
      }
      if (isProtectedRootFile(normalized)) {
        const claw = await requireClawOwner(req, res, adoptId);
        if (claw) {
          await recordFileAudit({
            req,
            claw,
            adoptId,
            action: "file.delete.denied",
            result: "denied",
            severity: "high",
            path: normalized,
            runtime: runtimeName(adoptId),
            errorCode: "PROTECTED_CORE_FILE",
            policyCode: "protected_root_file",
          });
        }
        return res.status(403).json({ error: "protected_core_file", message: "system files can be edited but not deleted" });
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      if (adoptId.startsWith("lgh-")) return res.status(410).json({ error: "HERMES_RUNTIME_ARCHIVED" });
      const ws = runtimeWorkspace(claw, adoptId);
      const abs = resolveWorkspaceDeletePath(ws, relPath);
      if (!abs || !existsSync(abs)) return res.status(404).json({ error: "file not found" });
      if (path.resolve(abs) === path.resolve(ws)) return res.status(400).json({ error: "refuse to delete workspace root" });
      const st = lstatSync(abs);
      try {
        if (st.isDirectory()) {
          rmSync(abs, { recursive: true, force: true });
          await recordFileAudit({
            req,
            claw,
            adoptId,
            action: "file.deleted",
            path: relPath,
            runtime: runtimeName(adoptId),
            metadata: { deleted: "directory" },
          });
          return res.json({ runtime: runtimeName(adoptId), ok: true, deleted: "directory" });
        }
        const size = Number(st.size);
        let sha256: string | null = null;
        if (!st.isSymbolicLink()) {
          try { sha256 = fileSha256(readFileSync(abs)); } catch {}
        }
        unlinkSync(abs);
        await recordFileAudit({
          req,
          claw,
          adoptId,
          action: "file.deleted",
          path: relPath,
          size,
          sha256,
          runtime: runtimeName(adoptId),
          metadata: { deleted: "file" },
        });
        return res.json({ runtime: runtimeName(adoptId), ok: true, deleted: "file" });
      } catch (e: any) {
        return res.status(500).json({ error: `delete failed: ${e?.message || e}` });
      }
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message || "delete failed") });
    }
  });
}
