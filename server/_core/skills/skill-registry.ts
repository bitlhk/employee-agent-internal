import path from "path";
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import type {
  ReconcileReport,
  ReconcileItem,
  Skill,
  SkillRegistry,
  SkillRegistryError,
  SkillRegistryResult,
  SkillRegistryReconcileOptions,
  SkillScanInfo,
  SkillSource,
} from "../../../shared/types/skill";
import { APP_ROOT, OPENCLAW_HOME, bumpSessionEpoch, clearAgentSessionsCache, resolveRuntimeAgentId, isJiuwenClawAdoptId, jiuwenClawWorkspaceDir } from "../helpers";
import { skillInstaller, type SkillInstaller } from "./skill-installer";
import { parseSkillSourceDirectory } from "./skill-source";
import { skillSourceDirsForRuntime, skillStoreAgentDir, skillStoreMarketplaceInstallDir } from "./skill-store";

type RegistryOptions = {
  appRoot?: string;
  openclawHome?: string;
  now?: () => Date;
  resolveRuntimeAgentId?: (adoptId: string) => Promise<string>;
  installer?: SkillInstaller;
};

type FileSummary = {
  exists: boolean;
  isDirectory?: boolean;
  mtimeMs?: number;
  sizeBytes?: number;
};

type OpenClawAgentEntry = {
  id?: string;
  workspace?: string;
  skills?: string[];
  [key: string]: unknown;
};

type OpenClawConfig = {
  agents?: {
    list?: OpenClawAgentEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

function err<T>(kind: SkillRegistryError["kind"], detail: string): SkillRegistryResult<T> {
  return { ok: false, error: { kind, detail } as SkillRegistryError };
}

function ok<T>(value: T): SkillRegistryResult<T> {
  return { ok: true, value };
}

function normalizeOpenclawHome(raw: string): string {
  return path.basename(raw) === ".openclaw" ? raw : path.join(raw, ".openclaw");
}

function iso(now: () => Date): string {
  return now().toISOString();
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback;
    const raw = String(readFileSync(filePath, "utf-8") || "").trim();
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function readOpenClawConfig(filePath: string): OpenClawConfig | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(String(readFileSync(filePath, "utf-8") || "{}")) as OpenClawConfig;
  } catch {
    return null;
  }
}

function findOpenClawAgentEntry(config: OpenClawConfig | null, adoptId: string, runtimeAgentId: string): OpenClawAgentEntry | null {
  const list = Array.isArray(config?.agents?.list) ? config!.agents!.list! : [];
  const candidates = new Set([runtimeAgentId, adoptId, `trial_${adoptId}`].filter(Boolean));
  return list.find((entry) => candidates.has(String(entry?.id || ""))) || null;
}

function resolveWorkspacePath(openclawHome: string, workspace: string): string {
  const value = String(workspace || "").trim();
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.join(openclawHome, value);
}

function writeOpenClawConfigAtomic(filePath: string, config: OpenClawConfig): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const backup = `${filePath}.bak-skill-sync-${Date.now()}`;
  if (existsSync(filePath)) copyFileSync(filePath, backup);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), "utf-8");
  renameSync(tmp, filePath);
}

function summarizePath(filePath?: string): FileSummary {
  if (!filePath || !existsSync(filePath)) return { exists: false };
  const st = statSync(filePath);
  if (!st.isDirectory()) {
    return { exists: true, isDirectory: false, mtimeMs: st.mtimeMs, sizeBytes: st.size };
  }
  let maxMtimeMs = st.mtimeMs;
  let sizeBytes = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      const s = statSync(p);
      maxMtimeMs = Math.max(maxMtimeMs, s.mtimeMs);
      if (entry.isDirectory()) walk(p);
      else sizeBytes += s.size;
    }
  };
  walk(filePath);
  return { exists: true, isDirectory: true, mtimeMs: maxMtimeMs, sizeBytes };
}

function sourceIsZip(sourcePath?: string): boolean {
  return !!sourcePath && path.extname(sourcePath).toLowerCase() === ".zip";
}

function pathInside(child: string, parent: string): boolean {
  const normalizedChild = path.resolve(child);
  const normalizedParent = path.resolve(parent);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${path.sep}`);
}

function isAgentScopedSkillSource(adoptId: string, sourcePath?: string): boolean {
  if (!sourcePath) return false;
  return pathInside(sourcePath, skillStoreAgentDir(adoptId));
}


function readSkillRuntimeName(runtimePath: string | undefined, fallback: string): string {
  try {
    if (!runtimePath) return fallback;
    const manifestPath = path.join(runtimePath, "SKILL.md");
    if (!existsSync(manifestPath)) return fallback;
    const text = String(readFileSync(manifestPath, "utf-8") || "");
    const match = text.match(/(?:^|\n)\s*name\s*:\s*['"]?([^'"\n]+)['"]?/i);
    return String(match?.[1] || fallback).trim() || fallback;
  } catch {
    return fallback;
  }
}

function compareVersionString(a?: string, b?: string): number {
  const left = String(a || "").trim();
  const right = String(b || "").trim();
  if (!left || !right || left === right) return 0;
  const l = left.split(/[.+_-]/).map((x) => Number.parseInt(x, 10));
  const r = right.split(/[.+_-]/).map((x) => Number.parseInt(x, 10));
  const n = Math.max(l.length, r.length);
  for (let i = 0; i < n; i++) {
    const li = Number.isFinite(l[i]) ? l[i] : 0;
    const ri = Number.isFinite(r[i]) ? r[i] : 0;
    if (li !== ri) return li > ri ? 1 : -1;
  }
  return left.localeCompare(right);
}

function normalizeSkillDisplayName(value?: string): string {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function runtimeIsStale(source: FileSummary, runtime: FileSummary, sourcePath?: string): boolean {
  if (!source.exists || !runtime.exists) return false;
  // Legacy uploaded skills can keep their durable source as a zip/package file
  // while OpenClaw executes the extracted runtime directory. File size cannot be
  // compared with extracted folder size; use mtime-only refresh for zip sources.
  if (source.isDirectory === false && !sourceIsZip(sourcePath)) return false;
  if (sourceIsZip(sourcePath)) {
    return source.mtimeMs !== undefined && runtime.mtimeMs !== undefined && source.mtimeMs > runtime.mtimeMs + 1000;
  }
  if (source.sizeBytes !== undefined && runtime.sizeBytes !== undefined && source.sizeBytes !== runtime.sizeBytes) return true;
  if (source.mtimeMs !== undefined && runtime.mtimeMs !== undefined && source.mtimeMs > runtime.mtimeMs + 1000) return true;
  return false;
}

export class FileSkillRegistry implements SkillRegistry {
  private readonly appRoot: string;
  private readonly openclawHome: string;
  private readonly now: () => Date;
  private readonly resolveRuntimeAgentIdOverride?: (adoptId: string) => Promise<string>;
  private readonly installer: SkillInstaller;

  constructor(options: RegistryOptions = {}) {
    this.appRoot = options.appRoot || APP_ROOT;
    this.openclawHome = normalizeOpenclawHome(options.openclawHome || OPENCLAW_HOME);
    this.now = options.now || (() => new Date());
    this.resolveRuntimeAgentIdOverride = options.resolveRuntimeAgentId;
    this.installer = options.installer || skillInstaller;
  }

  private registryPath(): string {
    return path.join(this.appRoot, "data", "skill-registry.json");
  }

  private loadRegistry(): Skill[] {
    const rows = readJsonFile<Skill[]>(this.registryPath(), []);
    return Array.isArray(rows) ? rows : [];
  }

  private saveRegistry(rows: Skill[]): void {
    writeJsonFile(this.registryPath(), rows);
  }

  private async runtimeAgentId(adoptId: string): Promise<string> {
    if (this.resolveRuntimeAgentIdOverride) return this.resolveRuntimeAgentIdOverride(adoptId);
    const { getClawByAdoptId } = await import("../../db");
    const claw = await getClawByAdoptId(adoptId).catch(() => null);
    if (!claw?.agentId) return `trial_${adoptId}`;
    return resolveRuntimeAgentId(adoptId, claw.agentId);
  }

  private openclawJsonPath(): string {
    return path.join(this.openclawHome, "openclaw.json");
  }

  private async runtimeRoot(adoptId: string): Promise<string> {
    const runtimeAgentId = await this.runtimeAgentId(adoptId);
    // jiuwenswarm (lgj-*) 用户的技能在 jiuwenswarm workspace，不在 .openclaw 下。
    // Keep reviewed marketplace and personal package installs on the same storage layout.
    // （resolveRuntimeWorkspaceByIds）保持一致，否则卸载/启停/同步会操作孤儿目录。
    if (isJiuwenClawAdoptId(adoptId)) {
      return path.join(jiuwenClawWorkspaceDir(adoptId, runtimeAgentId), "skills");
    }
    const config = readOpenClawConfig(this.openclawJsonPath());
    const agentEntry = findOpenClawAgentEntry(config, adoptId, runtimeAgentId);
    const workspace = resolveWorkspacePath(this.openclawHome, String(agentEntry?.workspace || ""));
    if (workspace) return path.join(workspace, "skills");
    return path.join(this.openclawHome, "workspace-" + runtimeAgentId, "skills");
  }

  private async runtimePath(adoptId: string, skillId: string): Promise<string> {
    return path.join(await this.runtimeRoot(adoptId), skillId);
  }

  private prepareInstallSource(adoptId: string, source: SkillSource): SkillSource {
    if (source.kind !== "marketplace") return source;
    if (!source.sourcePath || !existsSync(source.sourcePath)) {
      throw new Error("marketplace skill source is missing");
    }
    const agentSourcePath = skillStoreMarketplaceInstallDir(adoptId, source.skillId);
    if (path.resolve(source.sourcePath) === path.resolve(agentSourcePath)) return source;
    if (existsSync(agentSourcePath)) rmSync(agentSourcePath, { recursive: true, force: true });
    mkdirSync(path.dirname(agentSourcePath), { recursive: true });
    this.installer.installFromSource(source.sourcePath, agentSourcePath);
    return { ...source, sourcePath: agentSourcePath };
  }

  private async finalizeSkill(adoptId: string, skill: Skill): Promise<Skill> {
    const runtimePath = skill.sync.runtimePath || await this.runtimePath(adoptId, skill.id);
    const source = summarizePath(skill.source.sourcePath);
    const runtime = summarizePath(runtimePath);
    return {
      ...skill,
      sync: {
        ...skill.sync,
        runtimePath,
        sourceMtimeMs: source.mtimeMs,
        sourceSizeBytes: source.sizeBytes,
        runtimeMtimeMs: runtime.mtimeMs,
        runtimeSizeBytes: runtime.sizeBytes,
      },
    };
  }

  async listSkills(adoptId: string): Promise<SkillRegistryResult<Skill[]>> {
    const rows = this.loadRegistry().filter((x) => x.adoptId === adoptId);
    const out: Skill[] = [];
    for (const skill of rows) out.push(await this.finalizeSkill(adoptId, skill));
    return ok(out);
  }

  async reconcile(adoptId: string, options: SkillRegistryReconcileOptions = {}): Promise<SkillRegistryResult<ReconcileReport>> {
    const startedAt = iso(this.now);
    let rows = this.loadRegistry();
    const nextRows: Skill[] = [];
    const items: ReconcileItem[] = [];
    let scanned = 0;
    let changed = 0;
    let failed = 0;

    for (const skill of rows) {
      if (skill.adoptId !== adoptId) {
        nextRows.push(skill);
        continue;
      }
      if (options.skillId && skill.id !== options.skillId) {
        nextRows.push(skill);
        continue;
      }
      scanned++;
      const before = skill.state;
      const runtimePath = skill.sync.runtimePath || await this.runtimePath(adoptId, skill.id);
      const source = summarizePath(skill.source.sourcePath);
      const runtime = summarizePath(runtimePath);
      let action: ReconcileItem["action"] = "none";
      let after = skill.state;
      let reason: string | undefined;
      let keep = true;

      try {
        if (!source.exists && runtime.exists) {
          rmSync(runtimePath, { recursive: true, force: true });
          action = "deleted_runtime_copy";
          after = "source_missing";
          reason = "source folder is missing; runtime copy removed";
        } else if (!source.exists && !runtime.exists) {
          action = "removed_registry_entry";
          after = "source_missing";
          reason = "source and runtime copy are both missing";
          keep = false;
        } else if (source.exists && !runtime.exists) {
          if (!skill.source.sourcePath || !this.installer.canInstall(skill.source.sourcePath)) {
            action = "reported_error";
            after = "sync_failed";
            reason = "source is not a directory; installer support required";
            failed++;
          } else {
            this.installer.installFromSource(skill.source.sourcePath, runtimePath);
            action = "copied_to_runtime";
            after = skill.enabled ? "ready" : "disabled";
          }
        } else if (source.exists && runtime.exists && runtimeIsStale(source, runtime, skill.source.sourcePath)) {
          if (!skill.source.sourcePath || !this.installer.canInstall(skill.source.sourcePath)) {
            action = "reported_error";
            after = "sync_failed";
            reason = "source is not a directory; installer support required";
            failed++;
          } else {
            this.installer.installFromSource(skill.source.sourcePath, runtimePath);
            action = "refreshed_runtime";
            after = skill.enabled ? "ready" : "disabled";
          }
        } else {
          after = skill.enabled ? "ready" : "disabled";
        }
      } catch (e: any) {
        action = "reported_error";
        after = "sync_failed";
        reason = String(e?.message || e);
        failed++;
      }

      if (action !== "none" || before !== after) changed++;
      items.push({ skillId: skill.id, sourceKind: skill.source.kind, before, after, action, reason });

      if (keep) {
        const source2 = summarizePath(skill.source.sourcePath);
        const runtime2 = summarizePath(runtimePath);
        nextRows.push({
          ...skill,
          state: after,
          sync: {
            ...skill.sync,
            runtimePath,
            lastSyncedAt: ["copied_to_runtime", "refreshed_runtime"].includes(action) ? iso(this.now) : skill.sync.lastSyncedAt,
            sourceMtimeMs: source2.mtimeMs,
            sourceSizeBytes: source2.sizeBytes,
            runtimeMtimeMs: runtime2.mtimeMs,
            runtimeSizeBytes: runtime2.sizeBytes,
            reason,
          },
          updatedAt: iso(this.now),
        });
      }
    }

    if (changed > 0) {
      this.saveRegistry(nextRows);
      await this.invalidateRuntime(adoptId);
    }
    return ok({ adoptId, startedAt, finishedAt: iso(this.now), scanned, changed, failed, items });
  }

  async install(adoptId: string, source: SkillSource): Promise<SkillRegistryResult<Skill>> {
    const rows = this.loadRegistry();
    const now = iso(this.now);
    const existing = rows.find((x) => x.adoptId === adoptId && x.id === source.skillId);
    const versionCompare = compareVersionString(source.version, existing?.source.version);
    if (existing?.source.kind === "marketplace" && source.kind === "marketplace" && versionCompare < 0) {
      console.warn("[SKILL-REGISTRY][VERSION-DOWNGRADE] marketplace source version is older than installed version; keeping installed copy", {
        adoptId,
        skillId: source.skillId,
        installedVersion: existing.source.version,
        sourceVersion: source.version,
      });
      return ok(await this.finalizeSkill(adoptId, existing));
    }
    if (existing?.source.kind === "marketplace" && source.kind === "marketplace" && versionCompare > 0) {
      const runtimePath = existing.sync.runtimePath || await this.runtimePath(adoptId, source.skillId);
      if (existsSync(runtimePath)) rmSync(runtimePath, { recursive: true, force: true });
    }
    let preparedSource = source;
    try {
      preparedSource = this.prepareInstallSource(adoptId, source);
    } catch (e: any) {
      return err("source_missing", String(e?.message || e));
    }
    const skill: Skill = {
      id: preparedSource.skillId,
      adoptId,
      source: preparedSource,
      state: "syncing",
      enabled: true,
      review: { state: "none" },
      sync: { runtimePath: await this.runtimePath(adoptId, preparedSource.skillId) },
      scan: existing?.scan,
      capabilities: [],
      examples: [],
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    const next = rows.filter((x) => !(x.adoptId === adoptId && x.id === preparedSource.skillId));
    next.push(skill);
    this.saveRegistry(next);
    const report = await this.reconcile(adoptId, { skillId: preparedSource.skillId });
    if (!report.ok) {
      this.saveRegistry(rows);
      return report as SkillRegistryResult<Skill>;
    }
    const listed = await this.listSkills(adoptId);
    if (!listed.ok) {
      this.saveRegistry(rows);
      return listed;
    }
    const out = listed.value.find((x) => x.id === preparedSource.skillId);
    if (!out) {
      this.saveRegistry(rows);
      return err("sync_failed", "skill was not found after install");
    }
    return ok(out);
  }

  async updateScan(adoptId: string, skillId: string, scan: SkillScanInfo): Promise<SkillRegistryResult<Skill>> {
    const rows = this.loadRegistry();
    const skill = rows.find((x) => x.adoptId === adoptId && x.id === skillId);
    if (!skill) return err("not_found", "skill not found");
    const nextSkill = { ...skill, scan, updatedAt: iso(this.now) };
    this.saveRegistry(rows.map((x) => x === skill ? nextSkill : x));
    return ok(nextSkill);
  }

  async uninstall(adoptId: string, skillId: string): Promise<SkillRegistryResult<void>> {
    const rows = this.loadRegistry();
    const skill = rows.find((x) => x.adoptId === adoptId && x.id === skillId);
    if (!skill) return err("not_found", "skill not found");
    if (skill.source.kind === "role_default") {
      return err("permission_denied", "role default skills are controlled by the role configuration");
    }
    const runtimePath = skill.sync.runtimePath || await this.runtimePath(adoptId, skillId);
    if (existsSync(runtimePath)) rmSync(runtimePath, { recursive: true, force: true });
    if (skill.source.kind === "marketplace" && isAgentScopedSkillSource(adoptId, skill.source.sourcePath) && existsSync(skill.source.sourcePath!)) {
      rmSync(skill.source.sourcePath!, { recursive: true, force: true });
    }
    const next = skill.source.kind === "marketplace"
      ? rows.filter((x) => x !== skill)
      : rows.map((x) => x === skill ? { ...x, enabled: false, state: "disabled" as const, updatedAt: iso(this.now) } : x);
    this.saveRegistry(next);
    await this.invalidateRuntime(adoptId);
    return ok(undefined);
  }

  async destroy(adoptId: string, skillId: string): Promise<SkillRegistryResult<void>> {
    const rows = this.loadRegistry();
    const skill = rows.find((x) => x.adoptId === adoptId && x.id === skillId);
    if (!skill) return err("not_found", "skill not found");
    if (!["uploaded", "generated", "runtime_imported"].includes(skill.source.kind)) {
      return err("permission_denied", "only uploaded, generated or runtime-imported skills can be destroyed");
    }
    await this.removeRuntimeSkillCopies(adoptId, skill);
    if (skill.source.sourcePath && existsSync(skill.source.sourcePath)) rmSync(skill.source.sourcePath, { recursive: true, force: true });
    this.saveRegistry(rows.filter((x) => x !== skill));
    await this.invalidateRuntime(adoptId);
    return ok(undefined);
  }

  private async removeRuntimeSkillCopies(adoptId: string, skill: Skill): Promise<void> {
    const runtimePath = skill.sync.runtimePath || await this.runtimePath(adoptId, skill.id);
    if (existsSync(runtimePath)) rmSync(runtimePath, { recursive: true, force: true });

    const root = await this.runtimeRoot(adoptId);
    if (!existsSync(root)) return;

    const expectedDisplayName = normalizeSkillDisplayName(skill.source.displayName);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name);
      if (candidate === runtimePath || !existsSync(path.join(candidate, "SKILL.md"))) continue;

      let shouldRemove = entry.name === skill.id;
      try {
        const parsed = parseSkillSourceDirectory(candidate, entry.name);
        const parsedDisplayName = normalizeSkillDisplayName(parsed.displayName);
        shouldRemove = shouldRemove
          || parsed.skillId === skill.id
          || (["generated", "runtime_imported"].includes(skill.source.kind) && !!expectedDisplayName && parsedDisplayName === expectedDisplayName);
      } catch {
        // Ignore unreadable sibling directories; destroy should stay best-effort
        // beyond the canonical registry/runtime paths.
      }
      if (shouldRemove) rmSync(candidate, { recursive: true, force: true });
    }
  }

  async setEnabled(adoptId: string, skillId: string, enabled: boolean): Promise<SkillRegistryResult<Skill>> {
    if (!enabled) {
      const rows = this.loadRegistry();
      const skill = rows.find((x) => x.adoptId === adoptId && x.id === skillId);
      if (!skill) return err("not_found", "skill not found");
      if (skill.source.kind === "role_default") {
        return err("permission_denied", "role default skills are controlled by the role configuration");
      }
      const runtimePath = skill.sync.runtimePath || await this.runtimePath(adoptId, skillId);
      if (existsSync(runtimePath)) rmSync(runtimePath, { recursive: true, force: true });
      const nextSkill = { ...skill, enabled: false, state: "disabled" as const, sync: { ...skill.sync, runtimePath }, updatedAt: iso(this.now) };
      this.saveRegistry(rows.map((x) => x === skill ? nextSkill : x));
      await this.invalidateRuntime(adoptId);
      return ok(await this.finalizeSkill(adoptId, nextSkill));
    }
    const rows = this.loadRegistry();
    const skill = rows.find((x) => x.adoptId === adoptId && x.id === skillId);
    if (!skill) return err("not_found", "skill not found");
    this.saveRegistry(rows.map((x) => x === skill ? { ...x, enabled: true, state: "syncing" as const, updatedAt: iso(this.now) } : x));
    const report = await this.reconcile(adoptId, { skillId });
    if (!report.ok) return report as SkillRegistryResult<Skill>;
    const listed = await this.listSkills(adoptId);
    if (!listed.ok) return listed;
    const out = listed.value.find((x) => x.id === skillId);
    return out ? ok(out) : err("sync_failed", "skill was not found after enable");
  }

  async rename(adoptId: string, skillId: string, displayName: string): Promise<SkillRegistryResult<Skill>> {
    const name = displayName.trim();
    if (!name) return err("validation_failed", "displayName is required");
    const rows = this.loadRegistry();
    const skill = rows.find((x) => x.adoptId === adoptId && x.id === skillId);
    if (!skill) return err("not_found", "skill not found");
    if (!["uploaded", "generated", "runtime_imported"].includes(skill.source.kind)) {
      return err("permission_denied", "only uploaded, generated or runtime-imported skills can be renamed");
    }
    const nextSkill = { ...skill, source: { ...skill.source, displayName: name }, updatedAt: iso(this.now) };
    this.saveRegistry(rows.map((x) => x === skill ? nextSkill : x));
    return ok(nextSkill);
  }

  private async syncOpenClawAgentSkillFilter(adoptId: string): Promise<void> {
    const runtimeAgentId = await this.runtimeAgentId(adoptId);
    const configPath = this.openclawJsonPath();
    const config = readOpenClawConfig(configPath);
    const agentEntry = findOpenClawAgentEntry(config, adoptId, runtimeAgentId);
    if (!config || !agentEntry) {
      console.warn("[SKILL-REGISTRY][AGENT-SKILLS-SYNC] agent entry not found; skip allowlist sync", { adoptId, runtimeAgentId });
      return;
    }

    const skills = await Promise.all(this.loadRegistry()
      .filter((skill) => skill.adoptId === adoptId && skill.enabled && skill.state === "ready")
      .map(async (skill) => readSkillRuntimeName(skill.sync.runtimePath || await this.runtimePath(adoptId, skill.id), skill.id)));
    const desired = Array.from(new Set(skills.filter(Boolean))).sort();
    const current = Array.isArray(agentEntry.skills)
      ? Array.from(new Set(agentEntry.skills.map((x) => String(x || "").trim()).filter(Boolean))).sort()
      : undefined;
    if (current && current.length === desired.length && current.every((id, i) => id === desired[i])) return;

    agentEntry.skills = desired;
    writeOpenClawConfigAtomic(configPath, config);
    console.log("[SKILL-REGISTRY][AGENT-SKILLS-SYNC] wrote OpenClaw agent skills allowlist; OpenClaw Gateway restart may be required", {
      adoptId,
      runtimeAgentId,
      count: desired.length,
      skills: desired,
    });
  }

  private async syncJiuwenSwarmWorkspaceSkills(adoptId: string): Promise<void> {
    const { getClawByAdoptId } = await import("../../db");
    const { resolveEffectiveRoleAssets } = await import("../../db");
    const { resolveAgentRoleTemplate } = await import("../role-templates");
    const { writeJiuwenSwarmRoleScopeManifest } = await import("../jiuwenswarm-role-scope");

    const claw = await getClawByAdoptId(adoptId).catch(() => null);
    const runtimeAgentId = await this.runtimeAgentId(adoptId);
    const roleTemplate = String((claw as any)?.roleTemplate || "general-assistant");
    const role = resolveAgentRoleTemplate(roleTemplate);
    const effectiveAssets = await resolveEffectiveRoleAssets(role.id);
    const activeSkillIds = this.loadRegistry()
      .filter((skill) => skill.adoptId === adoptId && skill.enabled && skill.state === "ready")
      .map((skill) => skill.id);

    const result = writeJiuwenSwarmRoleScopeManifest({
      workspaceDir: jiuwenClawWorkspaceDir(adoptId, runtimeAgentId),
      role,
      effectiveAssets,
      activeSkillIds,
      skillSourceDirs: skillSourceDirsForRuntime(),
    });

    const changed =
      Number(result.changed) +
      Number(result.identityChanged) +
      Number(result.userChanged) +
      result.linkedSharedSkills.length +
      result.removedSharedSkills.length;
    if (changed > 0) {
      console.log("[SKILL-REGISTRY][JIUWENSWARM-SKILLS-SYNC] reconciled workspace skills", {
        adoptId,
        runtimeAgentId,
        roleTemplate: role.id,
        changed,
        linkedSharedSkills: result.linkedSharedSkills,
        removedSharedSkills: result.removedSharedSkills,
        identityChanged: result.identityChanged,
        userChanged: result.userChanged,
      });
    }
  }

  private async invalidateRuntime(adoptId: string): Promise<void> {
    try {
      if (isJiuwenClawAdoptId(adoptId)) {
        await this.syncJiuwenSwarmWorkspaceSkills(adoptId);
      } else {
        await this.syncOpenClawAgentSkillFilter(adoptId);
      }
      const runtimeAgentId = await this.runtimeAgentId(adoptId);
      clearAgentSessionsCache(runtimeAgentId, this.openclawHome.replace(/\/\.openclaw$/, ""));
      bumpSessionEpoch(adoptId);
    } catch {
      // Best effort: registry mutations should not fail solely because cache
      // invalidation failed.
    }
  }
}

export const skillRegistry: SkillRegistry = new FileSkillRegistry();
