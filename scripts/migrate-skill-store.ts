import "dotenv/config";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "fs";
import path from "path";
import type { Skill } from "../shared/types/skill";
import { getClawByAdoptId, resolveEffectiveRoleAssets } from "../server/db";
import { resolveAgentRoleTemplate } from "../server/_core/role-templates";
import { skillRegistry } from "../server/_core/skills/skill-registry";
import {
  migrateLegacySkillMarketToStore,
  remapLegacySkillMarketPath,
  skillStoreAgentSourceDir,
  skillStoreMarketplaceInstallDir,
  skillStorePath,
  skillSourceDirsForRuntime,
} from "../server/_core/skills/skill-store";

const APP_ROOT = process.env.APP_ROOT || process.cwd();
const APPLY = process.argv.includes("--apply");
const RECONCILE = process.argv.includes("--reconcile");
const INCLUDE_LEGACY = process.argv.includes("--include-legacy");
const ADOPT_ID = process.argv.find((arg) => arg.startsWith("--adoptId="))?.split("=")[1]?.trim();

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback;
    const raw = String(readFileSync(filePath, "utf-8") || "").trim();
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const backup = `${filePath}.bak-skill-store-${Date.now()}`;
  if (existsSync(filePath)) cpSync(filePath, backup);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  renameSync(tmp, filePath);
  console.log(`[SKILL-STORE-MIGRATE] wrote ${filePath}; backup=${backup}`);
}

function pathUnderAnyRoot(filePath: string | undefined, roots: string[]): boolean {
  if (!filePath) return false;
  const candidates = [path.resolve(filePath)];
  try {
    if (existsSync(filePath)) candidates.push(realpathSync(filePath));
  } catch {}
  return candidates.some((candidate) => roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    let realRoot = resolvedRoot;
    try {
      if (existsSync(root)) realRoot = realpathSync(root);
    } catch {}
    return candidate === resolvedRoot
      || candidate.startsWith(`${resolvedRoot}${path.sep}`)
      || candidate === realRoot
      || candidate.startsWith(`${realRoot}${path.sep}`);
  }));
}

function realpathIfExists(filePath: string | undefined): string | undefined {
  try {
    if (!filePath || !existsSync(filePath)) return undefined;
    return realpathSync(filePath);
  } catch {
    return undefined;
  }
}

function remapSourcePath(rawPath: string | undefined): string | undefined {
  if (!rawPath) return rawPath;
  const direct = remapLegacySkillMarketPath(rawPath);
  if (direct !== rawPath) return direct;
  const real = realpathIfExists(rawPath);
  const remappedReal = real ? remapLegacySkillMarketPath(real) : real;
  if (remappedReal && remappedReal !== real && existsSync(remappedReal)) return remappedReal;
  return rawPath;
}

function copyDirIfNeeded(src: string, dst: string): boolean {
  if (!existsSync(src)) return false;
  if (path.resolve(src) === path.resolve(dst)) return false;
  if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
  mkdirSync(path.dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true, dereference: false });
  return true;
}

function legacyAgentSourcePath(kind: "uploaded" | "generated", adoptId: string, skillId: string): string {
  return skillStorePath(kind, adoptId, skillId);
}

function agentSourcePathFor(kind: Skill["source"]["kind"], adoptId: string, skillId: string): string | undefined {
  if (kind === "marketplace") return skillStoreMarketplaceInstallDir(adoptId, skillId);
  if (kind === "uploaded" || kind === "generated" || kind === "runtime_imported") {
    return skillStoreAgentSourceDir(adoptId, kind, skillId);
  }
  return undefined;
}

function linkedOrDirectUnderApprovedSource(filePath: string | undefined, approvedRoots: string[]): boolean {
  return pathUnderAnyRoot(filePath, approvedRoots) || pathUnderAnyRoot(realpathIfExists(filePath), approvedRoots);
}

async function defaultSkillsForAdopt(adoptId: string): Promise<Set<string>> {
  const claw = await getClawByAdoptId(adoptId).catch(() => null);
  const roleTemplate = String((claw as any)?.roleTemplate || "general-assistant");
  const role = resolveAgentRoleTemplate(roleTemplate);
  const effectiveAssets = await resolveEffectiveRoleAssets(role.id);
  return new Set(effectiveAssets.skills.default.map((skillId) => String(skillId || "").trim()).filter(Boolean));
}

async function main() {
  const registryPath = path.join(APP_ROOT, "data", "skill-registry.json");
  const registry = readJson<Skill[]>(registryPath, []);
  const scoped = registry.filter((row) => {
    if (ADOPT_ID) return row.adoptId === ADOPT_ID;
    if (INCLUDE_LEGACY) return true;
    return String(row.adoptId || "").startsWith("lgj-");
  });
  const roleDefaultCache = new Map<string, Set<string>>();
  const now = new Date().toISOString();

  if (APPLY) {
    const migrated = migrateLegacySkillMarketToStore();
    console.log(`[SKILL-STORE-MIGRATE] copied legacy market skills: copied=${migrated.copied}, skipped=${migrated.skipped}`);
  }
  const approvedRoots = skillSourceDirsForRuntime();

  let changed = 0;
  let remapped = 0;
  let roleDefault = 0;
  let marketplace = 0;
  let privateCopied = 0;
  const touchedAdopts = new Set<string>();

  const next: Skill[] = [];
  for (const row of registry) {
    if (!scoped.includes(row)) {
      next.push(row);
      continue;
    }

    let nextRow = row;
    const sourcePath = row.source.sourcePath || "";
    const mappedPath = remapSourcePath(sourcePath);
    const sourceChanged = !!mappedPath && mappedPath !== sourcePath;

    if (!roleDefaultCache.has(row.adoptId)) {
      roleDefaultCache.set(row.adoptId, await defaultSkillsForAdopt(row.adoptId));
    }
    const defaults = roleDefaultCache.get(row.adoptId)!;
    const shouldBeRoleDefault =
      defaults.has(row.id) &&
      row.source.kind !== "role_default" &&
      linkedOrDirectUnderApprovedSource(mappedPath || sourcePath, approvedRoots);
    const generatedMarketSource =
      row.source.kind === "generated" &&
      linkedOrDirectUnderApprovedSource(mappedPath || sourcePath, approvedRoots);

    const nextKind = shouldBeRoleDefault
      ? "role_default"
      : generatedMarketSource
        ? "marketplace"
        : nextRow.source.kind;

    let nextSourcePath = mappedPath || nextRow.source.sourcePath;
    if (nextKind !== "role_default") {
      const agentSourcePath = agentSourcePathFor(nextKind, row.adoptId, row.id);
      const legacySource = nextKind === "uploaded" || nextKind === "generated"
        ? legacyAgentSourcePath(nextKind, row.adoptId, row.id)
        : "";
      const sourceCandidate = existsSync(nextSourcePath || "") ? nextSourcePath! : legacySource;
      if (agentSourcePath && sourceCandidate && existsSync(sourceCandidate) && path.resolve(sourceCandidate) !== path.resolve(agentSourcePath)) {
        if (APPLY && copyDirIfNeeded(sourceCandidate, agentSourcePath)) privateCopied++;
        nextSourcePath = agentSourcePath;
      } else if (agentSourcePath && nextSourcePath && path.resolve(nextSourcePath) === path.resolve(agentSourcePath)) {
        nextSourcePath = agentSourcePath;
      }
    }

    const privateSourceChanged = !!nextSourcePath && nextSourcePath !== nextRow.source.sourcePath;

    if (sourceChanged || shouldBeRoleDefault || generatedMarketSource || privateSourceChanged) {
      nextRow = {
        ...nextRow,
        source: {
          ...nextRow.source,
          kind: nextKind,
          sourcePath: nextSourcePath || nextRow.source.sourcePath,
        },
        state: "syncing",
        sync: {
          ...nextRow.sync,
          reason: "migrated to SKILL_STORE",
        },
        updatedAt: now,
      };
      changed++;
      touchedAdopts.add(row.adoptId);
      if (sourceChanged) remapped++;
      if (shouldBeRoleDefault) roleDefault++;
      if (!shouldBeRoleDefault && nextKind === "marketplace") marketplace++;
    }

    next.push(nextRow);
  }

  console.log(`[SKILL-STORE-MIGRATE] scanned=${scoped.length}, changed=${changed}, remappedPaths=${remapped}, roleDefault=${roleDefault}, marketplace=${marketplace}, privateCopied=${privateCopied}`);
  console.log(`[SKILL-STORE-MIGRATE] touchedAdopts=${Array.from(touchedAdopts).sort().join(", ") || "<none>"}`);
  if (!APPLY) {
    console.log("[SKILL-STORE-MIGRATE] dry-run only. Re-run with --apply to update registry. Add --include-legacy to include lgc-*.");
    return;
  }

  if (changed > 0) writeJsonAtomic(registryPath, next);
  if (RECONCILE) {
    for (const adoptId of Array.from(touchedAdopts).sort()) {
      const report = await skillRegistry.reconcile(adoptId);
      if (!report.ok) {
        console.error(`[SKILL-STORE-MIGRATE] reconcile failed adoptId=${adoptId}`, report.error);
        continue;
      }
      console.log(`[SKILL-STORE-MIGRATE] reconciled adoptId=${adoptId}, changed=${report.value.changed}, failed=${report.value.failed}`);
    }
  }
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error("[SKILL-STORE-MIGRATE] failed", error);
  process.exit(1);
});
