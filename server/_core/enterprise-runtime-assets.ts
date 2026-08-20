import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";
import AdmZip from "adm-zip";
import type { RuntimeAgentBinding } from "../../drizzle/schema";
import { getClawByAdoptId } from "../db/claw";
import {
  buildEnterpriseRuntimeBinding,
  getRuntimeAgentBinding,
  listReadyRuntimeAgentBindings,
  markRuntimeAgentAssetsDirty,
  markRuntimeAgentAssetsPublished,
  updateRuntimeAgentBindingStatus,
  upsertRuntimeAgentBinding,
} from "../db/runtime-agent-bindings";
import { recordAuditBestEffort, auditRequest } from "./audit-events";
import { APP_ROOT, resolveRuntimeWorkspaceByIds } from "./helpers";
import { authorizeAndBindInternalRuntimeRequest } from "./internal-runtime-request";
import { resolveExistingWorkspacePath } from "./file-path-security";
import { logError, logInfo, logWarn } from "./observability/logger";

export const ENTERPRISE_RUNTIME_ASSET_AUDIENCE = "urn:ea:runtime-assets";
export const ENTERPRISE_RUNTIME_ATTACHMENT_AUDIENCE = "urn:ea:runtime-attachments";
const BUNDLE_FORMAT_VERSION = 1;
const MAX_BUNDLE_FILES = 512;
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const MAX_BUNDLE_FILE_BYTES = 8 * 1024 * 1024;
const ROOT_FILES = [
  "IDENTITY.md",
  "USER.md",
  ".linggan-role-scope.json",
  ".linggan-managed-skills.json",
] as const;
const FORBIDDEN_FILE_NAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
]);

export type EnterpriseRuntimeAssetFile = {
  path: string;
  size: number;
  sha256: string;
};

export type EnterpriseRuntimeAssetManifest = {
  formatVersion: 1;
  adoptionId: string;
  agentId: string;
  roleTemplate: string;
  bindingId: string;
  workspaceKey: string;
  fingerprint: string;
  createdAt: string;
  files: EnterpriseRuntimeAssetFile[];
};

export type EnterpriseRuntimeAssetBundle = {
  fingerprint: string;
  bundlePath: string;
  manifest: EnterpriseRuntimeAssetManifest;
};

type BundleFile = EnterpriseRuntimeAssetFile & { content: Buffer };

const publishLocks = new Map<string, Promise<unknown>>();
const freshnessChecks = new Map<string, { expiresAt: number; promise: Promise<RuntimeAgentBinding | null> }>();

function assetsRoot(): string {
  return path.resolve(
    process.env.EA_ENTERPRISE_RUNTIME_ASSET_DIR
      || path.join(APP_ROOT, "data", "enterprise-runtime-assets"),
  );
}

function safeSegment(value: string, label: string): string {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(normalized)) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/gu, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe runtime asset path: ${value}`);
  }
  return normalized;
}

function normalizeAttachmentPath(value: string): string {
  const normalized = normalizeRelativePath(value);
  if (!normalized.startsWith("prompt_attachment/")) {
    throw new Error("Runtime attachment path is outside prompt_attachment");
  }
  return normalized;
}

function assertAssetFileAllowed(relativePath: string): void {
  const baseName = path.posix.basename(relativePath).toLowerCase();
  if (FORBIDDEN_FILE_NAMES.has(baseName) || baseName.endsWith(".pem") || baseName.endsWith(".key")) {
    throw new Error(`Runtime asset bundle cannot contain credential-like file: ${relativePath}`);
  }
}

function collectDirectoryFiles(rootDir: string, relativeRoot: string, output: BundleFile[]): void {
  const absoluteRoot = path.resolve(rootDir);
  const walk = (directory: string, relativeDirectory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRelativePath(
        relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
      );
      const stats = lstatSync(absolutePath);
      if (stats.isSymbolicLink()) throw new Error(`Runtime asset bundle cannot contain symlink: ${relativePath}`);
      if (stats.isDirectory()) {
        walk(absolutePath, relativePath);
        continue;
      }
      if (!stats.isFile()) continue;
      const realPath = path.resolve(absolutePath);
      if (realPath !== absoluteRoot && !realPath.startsWith(`${absoluteRoot}${path.sep}`)) {
        throw new Error(`Runtime asset escaped source directory: ${relativePath}`);
      }
      assertAssetFileAllowed(relativePath);
      if (stats.size > MAX_BUNDLE_FILE_BYTES) throw new Error(`Runtime asset file is too large: ${relativePath}`);
      const content = readFileSync(absolutePath);
      output.push({ path: relativePath, size: content.length, sha256: sha256(content), content });
    }
  };
  walk(absoluteRoot, normalizeRelativePath(relativeRoot));
}

function collectWorkspaceAssets(workspaceDir: string): BundleFile[] {
  const workspace = path.resolve(workspaceDir);
  const files: BundleFile[] = [];
  for (const fileName of ROOT_FILES) {
    const filePath = path.join(workspace, fileName);
    if (!existsSync(filePath)) continue;
    const stats = lstatSync(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`Invalid managed runtime asset: ${fileName}`);
    const content = readFileSync(filePath);
    if (content.length > MAX_BUNDLE_FILE_BYTES) throw new Error(`Runtime asset file is too large: ${fileName}`);
    files.push({ path: fileName, size: content.length, sha256: sha256(content), content });
  }
  const skillsDir = path.join(workspace, "skills");
  if (existsSync(skillsDir)) collectDirectoryFiles(skillsDir, "skills", files);
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (!files.some((file) => file.path === ".linggan-role-scope.json")) {
    throw new Error("Role scope manifest is missing from the runtime workspace");
  }
  if (files.length > MAX_BUNDLE_FILES) throw new Error(`Runtime asset bundle contains too many files: ${files.length}`);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_BUNDLE_BYTES) throw new Error(`Runtime asset bundle is too large: ${totalBytes}`);
  return files;
}

function manifestFingerprint(input: {
  adoptionId: string;
  agentId: string;
  roleTemplate: string;
  bindingId: string;
  workspaceKey: string;
  files: BundleFile[];
}): string {
  return sha256(JSON.stringify({
    formatVersion: BUNDLE_FORMAT_VERSION,
    adoptionId: input.adoptionId,
    agentId: input.agentId,
    roleTemplate: input.roleTemplate,
    bindingId: input.bindingId,
    workspaceKey: input.workspaceKey,
    files: input.files.map(({ path: filePath, size, sha256: digest }) => ({ path: filePath, size, sha256: digest })),
  }));
}

export function buildEnterpriseRuntimeAssetBundle(input: {
  adoptionId: string;
  agentId: string;
  roleTemplate: string;
  workspaceDir: string;
  binding: Pick<RuntimeAgentBinding, "bindingId" | "workspaceKey"> | { bindingId: string; workspaceKey: string };
  outputRoot?: string;
  now?: Date;
}): EnterpriseRuntimeAssetBundle {
  const adoptionId = safeSegment(input.adoptionId, "adoptionId");
  const agentId = safeSegment(input.agentId, "agentId");
  const roleTemplate = safeSegment(input.roleTemplate, "roleTemplate");
  const bindingId = safeSegment(input.binding.bindingId, "bindingId");
  const workspaceKey = safeSegment(input.binding.workspaceKey, "workspaceKey");
  const files = collectWorkspaceAssets(input.workspaceDir);
  const fingerprint = manifestFingerprint({ adoptionId, agentId, roleTemplate, bindingId, workspaceKey, files });
  const manifest: EnterpriseRuntimeAssetManifest = {
    formatVersion: BUNDLE_FORMAT_VERSION,
    adoptionId,
    agentId,
    roleTemplate,
    bindingId,
    workspaceKey,
    fingerprint,
    createdAt: (input.now || new Date()).toISOString(),
    files: files.map(({ path: filePath, size, sha256: digest }) => ({ path: filePath, size, sha256: digest })),
  };
  const adoptionDir = path.join(path.resolve(input.outputRoot || assetsRoot()), adoptionId);
  mkdirSync(adoptionDir, { recursive: true });
  const bundlePath = path.join(adoptionDir, `${fingerprint}.zip`);
  if (!existsSync(bundlePath)) {
    const zip = new AdmZip();
    for (const file of files) zip.addFile(file.path, file.content);
    zip.addFile("asset-set.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
    const temporaryPath = `${bundlePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      zip.writeZip(temporaryPath);
      renameSync(temporaryPath, bundlePath);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }
  return { fingerprint, bundlePath, manifest };
}

function withPublishLock<T>(adoptionId: string, action: () => Promise<T>): Promise<T> {
  const previous = publishLocks.get(adoptionId) || Promise.resolve();
  const current = previous.catch(() => undefined).then(action);
  publishLocks.set(adoptionId, current);
  return current.finally(() => {
    if (publishLocks.get(adoptionId) === current) publishLocks.delete(adoptionId);
  });
}

function autoBindingEnabled(): boolean {
  const configured = String(process.env.EA_ENTERPRISE_RUNTIME_AUTO_BIND_ENABLED || "").trim().toLowerCase();
  if (configured) return configured === "true";
  return String(process.env.EA_ENTERPRISE_RUNTIME_ENABLED || "").trim().toLowerCase() === "true";
}

function eventDrivenAssetsEnabled(): boolean {
  return String(process.env.EA_ENTERPRISE_RUNTIME_EVENT_DRIVEN_ASSETS || "true").trim().toLowerCase() !== "false";
}

export function enterpriseRuntimeAssetsDirty(binding: Pick<
  RuntimeAgentBinding,
  "desiredAssetRevision" | "publishedAssetRevision"
>): boolean {
  const desired = Math.max(1, Number(binding.desiredAssetRevision || 1));
  const published = Math.max(1, Number(binding.publishedAssetRevision || 1));
  return desired > published;
}

function readyBundleIsReusable(binding: RuntimeAgentBinding | null): binding is RuntimeAgentBinding {
  return Boolean(
    binding
    && binding.status === "ready"
    && String(binding.assetSetFingerprint || "").trim()
    && !enterpriseRuntimeAssetsDirty(binding)
    && enterpriseRuntimeAssetBundleExists(binding),
  );
}

export async function ensureEnterpriseRuntimeBindingForAdoption(
  adoptionId: string,
  options: { forceVerify?: boolean } = {},
): Promise<RuntimeAgentBinding | null> {
  if (!autoBindingEnabled()) return null;
  return withPublishLock(adoptionId, async () => {
    const previous = await getRuntimeAgentBinding(adoptionId).catch(() => null);
    if (eventDrivenAssetsEnabled() && !options.forceVerify && readyBundleIsReusable(previous)) {
      return previous;
    }
    const adoption = await getClawByAdoptId(adoptionId);
    if (!adoption || !["active", "expiring"].includes(String(adoption.status || ""))) return null;
    const targetRevision = Math.max(1, Number(previous?.desiredAssetRevision || 1));
    const draft = buildEnterpriseRuntimeBinding({
      adoptionId: adoption.adoptId,
      agentId: adoption.agentId,
      roleTemplate: adoption.roleTemplate,
      runtimeProfile: "enterprise",
    });
    try {
      const bundle = buildEnterpriseRuntimeAssetBundle({
        adoptionId: adoption.adoptId,
        agentId: adoption.agentId,
        roleTemplate: adoption.roleTemplate,
        workspaceDir: resolveRuntimeWorkspaceByIds(adoption.adoptId, adoption.agentId),
        binding: draft,
      });
      if (
        previous
        && previous.status === "ready"
        && previous.runtimeBotId === draft.runtimeBotId
        && previous.assetSetFingerprint === bundle.fingerprint
        && enterpriseRuntimeAssetBundleExists(previous)
      ) {
        if (enterpriseRuntimeAssetsDirty(previous)) {
          return await markRuntimeAgentAssetsPublished({
            adoptionId,
            publishedAssetRevision: targetRevision,
          }) || previous;
        }
        return previous;
      }
      const binding = await upsertRuntimeAgentBinding(
        { ...draft, assetSetFingerprint: bundle.fingerprint },
        { status: "ready", publishedAssetRevision: targetRevision },
      );
      await recordAuditBestEffort({
        action: "runtime.enterprise.asset_publish_succeeded",
        result: "success",
        targetType: "agent",
        targetId: adoptionId,
        targetName: adoption.agentId,
        agentInstanceId: adoptionId,
        runtimeType: "jiuwenswarm",
        runtimeAgentId: adoption.agentId,
        metadata: {
          bindingId: binding.bindingId,
          workspaceKey: binding.workspaceKey,
          assetSetFingerprint: bundle.fingerprint,
          fileCount: bundle.manifest.files.length,
        },
      });
      return binding;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const canRetainPrevious = Boolean(
        previous
        && previous.status === "ready"
        && previous.runtimeBotId === draft.runtimeBotId
        && enterpriseRuntimeAssetBundleExists(previous),
      );
      if (!canRetainPrevious) {
        await upsertRuntimeAgentBinding(draft).catch(() => null);
        await updateRuntimeAgentBindingStatus({
          adoptionId,
          status: "degraded",
          lastError: message.slice(0, 1000),
        });
      }
      await recordAuditBestEffort({
        action: "runtime.enterprise.asset_publish_failed",
        result: "failed",
        severity: "high",
        targetType: "agent",
        targetId: adoptionId,
        targetName: adoption.agentId,
        agentInstanceId: adoptionId,
        runtimeType: "jiuwenswarm",
        runtimeAgentId: adoption.agentId,
          metadata: {
            error: message.slice(0, 500),
            retainedPreviousReadyBundle: canRetainPrevious,
          },
        });
      return canRetainPrevious ? previous : null;
    }
  });
}

export async function refreshEnterpriseRuntimeAssetsIfBound(adoptionId: string): Promise<RuntimeAgentBinding | null> {
  const binding = await getRuntimeAgentBinding(adoptionId).catch(() => null);
  if (!binding || binding.status === "disabled") return null;
  freshnessChecks.delete(adoptionId);
  if (eventDrivenAssetsEnabled()) await markRuntimeAgentAssetsDirty(adoptionId);
  return ensureEnterpriseRuntimeBindingForAdoption(adoptionId);
}

function freshnessTtlMs(): number {
  const configured = Number(process.env.EA_ENTERPRISE_RUNTIME_ASSET_SELF_HEAL_TTL_MS || 10_000);
  return Number.isFinite(configured) && configured >= 1_000 && configured <= 300_000
    ? configured
    : 10_000;
}

export function ensureEnterpriseRuntimeAssetsCurrent(adoptionId: string): Promise<RuntimeAgentBinding | null> {
  if (eventDrivenAssetsEnabled()) return ensureEnterpriseRuntimeBindingForAdoption(adoptionId);
  const now = Date.now();
  const cached = freshnessChecks.get(adoptionId);
  if (cached && cached.expiresAt > now) return cached.promise;
  const promise = ensureEnterpriseRuntimeBindingForAdoption(adoptionId);
  freshnessChecks.set(adoptionId, { expiresAt: now + freshnessTtlMs(), promise });
  promise.catch(() => freshnessChecks.delete(adoptionId));
  return promise;
}

function selfHealIntervalMs(): number {
  const configured = Number(process.env.EA_ENTERPRISE_RUNTIME_ASSET_SELF_HEAL_INTERVAL_MS || 300_000);
  return Number.isFinite(configured) && configured >= 60_000 && configured <= 86_400_000
    ? configured
    : 300_000;
}

export async function runEnterpriseRuntimeAssetSelfHeal(): Promise<{ checked: number; failed: number }> {
  if (!autoBindingEnabled() || !eventDrivenAssetsEnabled()) return { checked: 0, failed: 0 };
  const bindings = await listReadyRuntimeAgentBindings();
  let checked = 0;
  let failed = 0;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < bindings.length) {
      const binding = bindings[cursor++];
      checked += 1;
      const current = await ensureEnterpriseRuntimeBindingForAdoption(binding.adoptionId, { forceVerify: true })
        .catch(() => null);
      if (!current) failed += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, bindings.length) }, () => worker()));
  return { checked, failed };
}

export function startEnterpriseRuntimeAssetSelfHeal(): () => void {
  if (!autoBindingEnabled() || !eventDrivenAssetsEnabled()) return () => {};
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const summary = await runEnterpriseRuntimeAssetSelfHeal();
      if (summary.checked > 0) {
        const fields = { checked: summary.checked, failed: summary.failed };
        if (summary.failed > 0) logWarn("runtime_assets.self_heal_partial", fields);
        else logInfo("runtime_assets.self_heal_completed", fields);
      }
    } catch (error) {
      logError("runtime_assets.self_heal_failed", error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), selfHealIntervalMs());
  timer.unref();
  return () => clearInterval(timer);
}

export function clearEnterpriseRuntimeAssetFreshnessCache(adoptionId?: string): void {
  if (adoptionId) freshnessChecks.delete(adoptionId);
  else freshnessChecks.clear();
}

export function enterpriseRuntimeAssetBundlePath(binding: Pick<RuntimeAgentBinding, "adoptionId" | "assetSetFingerprint">): string | null {
  const fingerprint = String(binding.assetSetFingerprint || "").trim();
  if (!/^[a-f0-9]{64}$/u.test(fingerprint)) return null;
  const adoptionId = safeSegment(binding.adoptionId, "adoptionId");
  return path.join(assetsRoot(), adoptionId, `${fingerprint}.zip`);
}

export function enterpriseRuntimeAssetBundleExists(binding: Pick<RuntimeAgentBinding, "adoptionId" | "assetSetFingerprint">): boolean {
  const bundlePath = enterpriseRuntimeAssetBundlePath(binding);
  return Boolean(bundlePath && existsSync(bundlePath) && statSync(bundlePath).isFile());
}

export function registerEnterpriseRuntimeAssetRoutes(app: Express): void {
  app.get("/api/internal/runtime-assets/bundle", async (req: Request, res: Response) => {
    if (!await authorizeAndBindInternalRuntimeRequest(req, ENTERPRISE_RUNTIME_ASSET_AUDIENCE)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const adoptionId = String(req.headers["x-agent-adopt-id"] || "").trim();
    const agentId = String(req.headers["x-linggan-agent-id"] || "").trim();
    const binding = await getRuntimeAgentBinding(adoptionId).catch(() => null);
    const bundlePath = binding ? enterpriseRuntimeAssetBundlePath(binding) : null;
    if (!binding || binding.status !== "ready" || !bundlePath || !existsSync(bundlePath)) {
      await recordAuditBestEffort({
        action: "runtime.enterprise.asset_download_denied",
        result: "denied",
        severity: "high",
        targetType: "agent",
        targetId: adoptionId,
        targetName: agentId,
        agentInstanceId: adoptionId,
        ...auditRequest(req),
        metadata: { reason: "ready_asset_bundle_not_found" },
      });
      res.status(409).json({ error: "runtime_asset_bundle_not_ready" });
      return;
    }
    const expected = String(req.query.fingerprint || "").trim();
    if (expected && expected !== binding.assetSetFingerprint) {
      res.status(409).json({ error: "runtime_asset_bundle_changed" });
      return;
    }
    const stats = statSync(bundlePath);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Length", String(stats.size));
    res.setHeader("ETag", `\"${binding.assetSetFingerprint}\"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-EA-Asset-Fingerprint", String(binding.assetSetFingerprint));
    createReadStream(bundlePath).pipe(res);
  });

  app.get("/api/internal/runtime-assets/attachment", async (req: Request, res: Response) => {
    if (!await authorizeAndBindInternalRuntimeRequest(req, ENTERPRISE_RUNTIME_ATTACHMENT_AUDIENCE)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const adoptionId = String(req.headers["x-agent-adopt-id"] || "").trim();
    const agentId = String(req.headers["x-linggan-agent-id"] || "").trim();
    const adoption = await getClawByAdoptId(adoptionId).catch(() => null);
    const binding = await getRuntimeAgentBinding(adoptionId).catch(() => null);
    if (
      !adoption
      || !binding
      || binding.status !== "ready"
      || String(adoption.agentId || "") !== agentId
    ) {
      res.status(409).json({ error: "runtime_attachment_binding_not_ready" });
      return;
    }

    let relativePath: string;
    try {
      relativePath = normalizeAttachmentPath(String(req.query.path || ""));
    } catch {
      res.status(400).json({ error: "invalid_runtime_attachment_path" });
      return;
    }
    const workspaceDir = resolveRuntimeWorkspaceByIds(adoptionId, agentId);
    const filePath = resolveExistingWorkspacePath(workspaceDir, relativePath);
    if (!filePath) {
      res.status(404).json({ error: "runtime_attachment_not_found" });
      return;
    }
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size > 50 * 1024 * 1024) {
      res.status(413).json({ error: "runtime_attachment_exceeds_limit" });
      return;
    }
    const digest = sha256(readFileSync(filePath));
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(stats.size));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-EA-Attachment-SHA256", digest);
    createReadStream(filePath).pipe(res);
  });
}
