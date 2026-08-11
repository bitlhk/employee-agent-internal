import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Express, Request } from "express";
import type { SkillSource } from "../../../../shared/types/skill";
import { getClawByAdoptId } from "../../../db";
import {
  OPENCLAW_BASE_HOME,
  clearAgentSessionsCache,
  isJiuwenClawAdoptId,
  openClawAgentDir,
  requireClawOwner,
  resolveRuntimeWorkspaceByIds,
} from "../../helpers";
import { refreshJiuwenRuntimeCapabilities } from "../../jiuwenswarm-runtime-refresh";
import { logError } from "../../observability/logger";
import { scanUploadForMalware } from "../../upload-security";
import { skillInstaller } from "../skill-installer";
import {
  appendSkillPackageIndexRow,
  mutateSkillPackageIndex,
  readSkillPackageIndex,
  removeSkillPackageIndexRows,
  type SkillPackageIndexRow,
} from "../skill-package-index";
import { skillRegistry } from "../skill-registry";
import { MAX_SKILL_PACKAGE_BYTES, parseSkillPackageBuffer } from "../skill-source";
import { remapLegacySkillMarketPath, skillStoreUploadedDir } from "../skill-store";
import { runSkillWork, WorkQueueFullError } from "../skill-work-queues";

const execFileAsync = promisify(execFile);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function decodeParam(value: unknown): string {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function registryErrorStatus(kind?: string): number {
  if (kind === "not_found") return 404;
  if (kind === "permission_denied") return 403;
  if (kind === "validation_failed") return 400;
  return 500;
}

function errorStatus(error: unknown, fallback: number): number {
  if (error instanceof WorkQueueFullError) return 503;
  if (!error || typeof error !== "object" || !("statusCode" in error)) return fallback;
  const value = Number(error.statusCode);
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : fallback;
}

function applyQueueRetryHeader(res: import("express").Response, error: unknown): void {
  if (error instanceof WorkQueueFullError) {
    res.setHeader("Retry-After", String(error.retryAfterSeconds));
  }
}

function skillUploadMaxBytes(): number {
  const configured = Number.parseInt(String(process.env.EA_SKILL_UPLOAD_MAX_BYTES || ""), 10);
  if (!Number.isFinite(configured) || configured < 1024) return MAX_SKILL_PACKAGE_BYTES;
  return Math.min(configured, MAX_SKILL_PACKAGE_BYTES);
}

async function readSkillPackagePayload(req: Request): Promise<{
  adoptId: string;
  filename: string;
  fileBuf: Buffer;
  displayName: string;
  description: string;
}> {
  const body = record(req.body);
  const adoptId = String(body.adoptId || req.query.adoptId || "").trim();
  const filename = decodeParam(
    body.filename || req.query.filename || req.header("x-skill-filename") || "",
  ).trim();
  const displayName = String(body.displayName || req.query.displayName || "").trim();
  const description = String(body.description || req.query.description || "").trim();
  const contentBase64 = String(body.contentBase64 || "").trim();
  if (contentBase64) {
    return {
      adoptId,
      filename,
      fileBuf: Buffer.from(contentBase64, "base64"),
      displayName,
      description,
    };
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > skillUploadMaxBytes()) {
      const error = new Error(`file too large (max ${Math.floor(skillUploadMaxBytes() / 1024 / 1024)}MB)`) as Error & { statusCode: number };
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  return {
    adoptId,
    filename,
    fileBuf: Buffer.concat(chunks),
    displayName,
    description,
  };
}

function validatePackageInput(input: { filename: string; fileBuf: Buffer }): string | null {
  if (!/\.(zip|skill)$/i.test(input.filename)) return "only .zip or .skill allowed";
  if (input.fileBuf.length <= 0) return "file content required";
  if (input.fileBuf.length > skillUploadMaxBytes()) {
    return `file too large (max ${Math.floor(skillUploadMaxBytes() / 1024 / 1024)}MB)`;
  }
  return null;
}

export function registerSkillPackageRoutes(app: Express): void {
  app.post("/api/claw/skill-package/inspect", async (req, res) => {
    try {
      const payload = await readSkillPackagePayload(req);
      if (!payload.adoptId) {
        res.status(400).json({ error: "adoptId required" });
        return;
      }
      const claw = await requireClawOwner(req, res, payload.adoptId);
      if (!claw) return;
      const invalid = validatePackageInput(payload);
      if (invalid) {
        res.status(400).json({ error: invalid });
        return;
      }
      const parsed = await runSkillWork("scan", () => parseSkillPackageBuffer(payload.fileBuf, payload.filename));
      res.json({
        ok: true,
        skill: {
          skillId: parsed.skillId,
          displayName: parsed.displayName,
          description: parsed.description,
          manifest: parsed.manifest,
          mdMeta: parsed.mdMeta,
          totalBytes: parsed.totalBytes,
          warnings: parsed.warnings,
        },
      });
    } catch (error) {
      logError("skill_package.inspect_failed", error);
      applyQueueRetryHeader(res, error);
      res.status(errorStatus(error, 400)).json({
        error: error instanceof WorkQueueFullError ? "当前技能检查请求较多，请稍后重试" : error instanceof Error ? error.message : "inspect skill package failed",
        code: error instanceof WorkQueueFullError ? error.code : undefined,
      });
    }
  });

  app.post("/api/claw/skill-package/upload", async (req, res) => {
    try {
      const payload = await readSkillPackagePayload(req);
      if (!payload.adoptId) {
        res.status(400).json({ error: "adoptId required" });
        return;
      }
      const claw = await requireClawOwner(req, res, payload.adoptId);
      if (!claw) return;
      const invalid = validatePackageInput(payload);
      if (invalid) {
        res.status(400).json({ error: invalid });
        return;
      }
      const parsed = await runSkillWork("scan", async () => {
        const malwareScan = await scanUploadForMalware(payload.fileBuf);
        if (!malwareScan.ok) {
          const error = new Error(malwareScan.error || "malware scan failed") as Error & { statusCode: number; code: string };
          error.statusCode = 400;
          error.code = "file_malware_scan_failed";
          throw error;
        }
        return parseSkillPackageBuffer(payload.fileBuf, payload.filename);
      });
      const displayName = payload.displayName || parsed.displayName;
      if (!displayName || displayName.length < 2) {
        res.status(400).json({ error: "displayName must be at least 2 characters" });
        return;
      }
      const displayDescription = payload.description || parsed.description;
      const safeName = payload.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const sourceDir = skillStoreUploadedDir(payload.adoptId, parsed.skillId);
      const temporaryZip = path.join("/tmp", `skill-upload-${randomUUID()}.zip`);
      const sha256 = createHash("sha256").update(payload.fileBuf).digest("hex");
      const indexRow: SkillPackageIndexRow = {
        adoptId: payload.adoptId,
        filename: safeName,
        path: sourceDir,
        sha256,
        size: payload.fileBuf.length,
        manifest: parsed.manifest || {},
        mdMeta: parsed.mdMeta || {},
        displayName,
        displayDescription,
        installedSkillId: parsed.skillId,
        installedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      const source: SkillSource = {
        kind: "uploaded",
        skillId: parsed.skillId,
        displayName,
        description: displayDescription,
        sourcePath: sourceDir,
        version: String(parsed.manifest?.version || ""),
      };
      const { installed, reconciled } = await runSkillWork("install", async () => {
        writeFileSync(temporaryZip, payload.fileBuf);
        try {
          await skillInstaller.installFromSource(temporaryZip, sourceDir);
          await appendSkillPackageIndexRow(indexRow);
          const installedResult = await skillRegistry.install(payload.adoptId, source);
          if (!installedResult.ok) {
            const failure = new Error(installedResult.error.detail) as Error & { statusCode: number; code: string };
            failure.statusCode = registryErrorStatus(installedResult.error.kind);
            failure.code = installedResult.error.kind;
            throw failure;
          }
          await skillRegistry.updateScan(payload.adoptId, parsed.skillId, {
            warnings: parsed.warnings,
            scannedAt: new Date().toISOString(),
          });
          const reconciledResult = await skillRegistry.reconcile(payload.adoptId, { skillId: parsed.skillId });
          if (!reconciledResult.ok) {
            const failure = new Error(reconciledResult.error.detail) as Error & { statusCode: number; code: string };
            failure.statusCode = registryErrorStatus(reconciledResult.error.kind);
            failure.code = reconciledResult.error.kind;
            throw failure;
          }
          return { installed: installedResult, reconciled: reconciledResult };
        } catch (error) {
          await removeSkillPackageIndexRows(payload.adoptId, { sha256 }).catch(() => []);
          throw error;
        } finally {
          try { rmSync(temporaryZip, { force: true }); } catch {}
        }
      });

      res.json({
        ok: true,
        file: { filename: safeName, sha256, size: payload.fileBuf.length },
        item: installed.value,
        report: reconciled.value,
        manifest: parsed.manifest || {},
        warnings: parsed.warnings,
      });
    } catch (error) {
      logError("skill_package.upload_failed", error);
      applyQueueRetryHeader(res, error);
      res.status(errorStatus(error, 500)).json({
        error: error instanceof WorkQueueFullError ? "当前技能上传请求较多，请稍后重试" : error instanceof Error ? error.message : "skill package upload failed",
        code: error instanceof WorkQueueFullError ? error.code : (error as { code?: string })?.code,
      });
    }
  });

  app.get("/api/claw/skill-package/mine", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) {
        res.status(400).json({ error: "adoptId required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      res.json({ items: readSkillPackageIndex().filter((row) => String(row.adoptId || "") === adoptId) });
    } catch (error) {
      logError("skill_package.list_failed", error);
      res.status(500).json({ error: "list mine packages failed" });
    }
  });

  app.post("/api/claw/skill-package/delete", async (req, res) => {
    try {
      const body = record(req.body);
      const adoptId = String(body.adoptId || "").trim();
      const filename = String(body.filename || "").trim();
      const skillId = String(body.skillId || "").trim();
      const sha256 = String(body.sha256 || "").trim();
      if (!adoptId) {
        res.status(400).json({ error: "adoptId required" });
        return;
      }
      const adoption = await requireClawOwner(req, res, adoptId);
      if (!adoption) return;
      const found = readSkillPackageIndex().find((row) => (
        String(row.adoptId || "") === adoptId
        && ((filename && String(row.filename || "") === filename)
          || (skillId && String(row.installedSkillId || "") === skillId)
          || (sha256 && String(row.sha256 || "") === sha256))
      ));
      if (!found) {
        res.status(404).json({ error: "package not found" });
        return;
      }

      await removeSkillPackageIndexRows(adoptId, {
        filename,
        skillId: skillId || String(found.installedSkillId || ""),
        sha256,
        sourcePath: String(found.path || ""),
      });
      const packagePath = remapLegacySkillMarketPath(String(found.path || "").trim());
      const installedSkillId = String(found.installedSkillId || "").trim();
      let registryRefreshed = false;
      if (installedSkillId) {
        const destroyed = await skillRegistry.destroy(adoptId, installedSkillId);
        if (!destroyed.ok && destroyed.error.kind !== "not_found") {
          res.status(registryErrorStatus(destroyed.error.kind)).json({
            error: destroyed.error.detail,
            kind: destroyed.error.kind,
          });
          return;
        }
        registryRefreshed = destroyed.ok;
      }
      if (packagePath && existsSync(packagePath)) rmSync(packagePath, { force: true });

      if (installedSkillId) {
        const stored = await getClawByAdoptId(adoptId).catch(() => null);
        if (stored?.agentId) {
          const trialAgentId = `trial_${adoptId}`;
          const runtimeAgentId = existsSync(openClawAgentDir(trialAgentId)) ? trialAgentId : stored.agentId;
          const skillsBase = `${resolveRuntimeWorkspaceByIds(adoptId, runtimeAgentId)}/skills`;
          const exactDirectory = `${skillsBase}/${installedSkillId}`;
          if (existsSync(exactDirectory)) {
            rmSync(exactDirectory, { recursive: true, force: true });
          } else if (existsSync(skillsBase)) {
            for (const candidate of readdirSync(skillsBase).filter((entry) => entry.includes(installedSkillId) || installedSkillId.includes(entry))) {
              rmSync(`${skillsBase}/${candidate}`, { recursive: true, force: true });
            }
          }
        }
      }

      if (installedSkillId) {
        const trialAgentId = `trial_${adoptId}`;
        const runtimeAgentId = existsSync(openClawAgentDir(trialAgentId))
          ? trialAgentId
          : String(adoption.agentId || "");
        if (runtimeAgentId) clearAgentSessionsCache(runtimeAgentId, OPENCLAW_BASE_HOME);
      }
      if (isJiuwenClawAdoptId(adoptId) && !registryRefreshed) {
        await refreshJiuwenRuntimeCapabilities(adoptId);
      }
      res.json({ ok: true });
    } catch (error) {
      logError("skill_package.delete_failed", error);
      res.status(500).json({ error: "delete package failed" });
    }
  });

  app.post("/api/claw/skill-package/install", async (req, res) => {
    try {
      const body = record(req.body);
      const adoptId = String(body.adoptId || "").trim();
      const filename = String(body.filename || "").trim();
      if (!adoptId || !filename) {
        res.status(400).json({ error: "adoptId and filename required" });
        return;
      }
      const adoption = await requireClawOwner(req, res, adoptId);
      if (!adoption) return;
      let rows = readSkillPackageIndex();
      const found = rows.find((row) => String(row.adoptId || "") === adoptId && String(row.filename || "") === filename);
      if (!found) {
        res.status(404).json({ error: "package not found" });
        return;
      }
      const zipPath = String(found.path || "").trim();
      if (!zipPath || !existsSync(zipPath)) {
        res.status(404).json({ error: "package file missing" });
        return;
      }

      const trialAgentId = `trial_${adoptId}`;
      const runtimeAgentId = existsSync(openClawAgentDir(trialAgentId))
        ? trialAgentId
        : String(adoption.agentId || "");
      const probe = `import zipfile, json, re
with zipfile.ZipFile(${JSON.stringify(zipPath)}, 'r') as z:
 names=[n for n in z.namelist() if n and not n.endswith('/')]
 tops=list({n.split('/')[0] for n in names if '/' in n})
 if len(tops)==1:
  sid=tops[0].lower().strip()
 else:
  raw=${JSON.stringify(filename.replace(/\.zip$/i, ""))}
  sid=re.sub(r'^[0-9]+-','',raw).lower()
 sid=re.sub(r'[^a-z0-9-]+','-',sid).strip('-')[:48] or 'uploaded-skill'
 print(json.dumps({'skillId':sid}))`;
      const probePath = `/tmp/claw_probe_${randomUUID()}.py`;
      writeFileSync(probePath, probe, "utf-8");
      let probeRaw = "";
      try {
        const result = await runSkillWork("scan", () => execFileAsync("python3", [probePath], {
          encoding: "utf-8",
          timeout: 5_000,
          maxBuffer: 256 * 1024,
        }));
        probeRaw = result.stdout;
      } finally {
        try { rmSync(probePath, { force: true }); } catch {}
      }
      const probeResult = record(JSON.parse(probeRaw.trim()));
      const installedSkillId = String(probeResult.skillId || "uploaded-skill");
      const skillDirectory = `${resolveRuntimeWorkspaceByIds(adoptId, runtimeAgentId)}/skills/${installedSkillId}`;

      const install = `import zipfile, os, json
zip_path=${JSON.stringify(zipPath)}
dst=${JSON.stringify(skillDirectory)}
os.makedirs(dst, exist_ok=True)
with zipfile.ZipFile(zip_path, 'r') as z:
 names=[n for n in z.namelist() if n and not n.endswith('/')]
 for n in names:
  if n.startswith('/') or '..' in n:
   raise Exception('path traversal')
 prefix=''
 top={n.split('/')[0] for n in names if '/' in n}
 if len(top)==1:
  only=list(top)[0]
  if all(n.startswith(only + '/') for n in names):
   prefix=only + '/'
 for n in names:
  m=n[len(prefix):] if prefix and n.startswith(prefix) else n
  if not m:
   continue
  out=os.path.join(dst,m)
  os.makedirs(os.path.dirname(out), exist_ok=True)
  with z.open(n) as src, open(out,'wb') as fw:
   fw.write(src.read())
print(json.dumps({'ok':True}))`;
      const installPath = `/tmp/claw_install_${randomUUID()}.py`;
      writeFileSync(installPath, install, "utf-8");
      try {
        await runSkillWork("install", () => execFileAsync("python3", [installPath], {
          encoding: "utf-8",
          timeout: 12_000,
          maxBuffer: 256 * 1024,
        }));
      } finally {
        try { rmSync(installPath, { force: true }); } catch {}
      }

      const skillMarkdownPath = `${skillDirectory}/SKILL.md`;
      if (!existsSync(skillMarkdownPath)) {
        const title = String(found.displayName || found.manifest?.name || installedSkillId).trim();
        const description = String(found.displayDescription || found.manifest?.description || "uploaded skill")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 180);
        writeFileSync(
          skillMarkdownPath,
          `---\nname: ${installedSkillId}\ndescription: "${description.replace(/"/g, "'")}"\n---\n\n# ${title}\n\n${description}\n`,
          "utf-8",
        );
      }

      await mutateSkillPackageIndex((currentRows) => ({
        rows: currentRows.map((row) => (
          String(row.adoptId || "") === adoptId && String(row.filename || "") === filename
            ? { ...row, installedSkillId, installedAt: new Date().toISOString() }
            : row
        )),
        value: undefined,
      }));
      clearAgentSessionsCache(runtimeAgentId, OPENCLAW_BASE_HOME);
      if (isJiuwenClawAdoptId(adoptId)) {
        await refreshJiuwenRuntimeCapabilities(adoptId);
      }
      res.json({ ok: true, skillId: installedSkillId, path: skillDirectory });
    } catch (error) {
      logError("skill_package.legacy_install_failed", error);
      applyQueueRetryHeader(res, error);
      res.status(errorStatus(error, 500)).json({
        error: error instanceof WorkQueueFullError ? "当前技能安装请求较多，请稍后重试" : "install package failed",
        code: error instanceof WorkQueueFullError ? error.code : undefined,
      });
    }
  });
}
