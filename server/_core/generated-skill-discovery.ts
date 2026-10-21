import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import path from "path";
import type { SkillSource } from "../../shared/types/skill";
import { createBoundedAsyncCache } from "./bounded-async-cache";
import { OPENCLAW_HOME, readSessionEpoch, resolveRuntimeWorkspaceByIds } from "./helpers";
import { generatedSkillDiscoveryExcludedRoots, shouldDiscoverGeneratedRuntimeSkill, } from "./skills/skill-discovery";
import { skillRegistry } from "./skills/skill-registry";
import { parseSkillSourceDirectory } from "./skills/skill-source";
import { skillSourceDirsForRuntime, skillStoreRuntimeImportedDir } from "./skills/skill-store";

export function skillSourceCacheDir(adoptId: string, skillId: string): string {
  return skillStoreRuntimeImportedDir(adoptId, skillId);
}

export type GeneratedSkillDiscoveryResult = {
  discovered: number;
  installed: Array<{ skillId: string; displayName: string }>;
  skipped: Array<{ skillId: string; reason: string }>;
};

export const configuredSkillDiscoveryTtl = Number(
  process.env.EA_SKILL_DISCOVERY_CACHE_TTL_MS || 30_000,
);

export const generatedSkillDiscoveryCache = createBoundedAsyncCache<GeneratedSkillDiscoveryResult>({
  ttlMs: Number.isFinite(configuredSkillDiscoveryTtl)
    ? Math.min(300_000, Math.max(1_000, configuredSkillDiscoveryTtl))
    : 30_000,
  maxEntries: 2_000,
});

export async function discoverGeneratedRuntimeSkillsUncached(
  adoptId: string,
  runtimeAgentId: string,
  onlySkillId?: string
): Promise<GeneratedSkillDiscoveryResult> {
  const runtimeSkillsRoot = path.join(
    resolveRuntimeWorkspaceByIds(adoptId, runtimeAgentId),
    "skills"
  );
  if (!existsSync(runtimeSkillsRoot))
    return { discovered: 0, installed: [], skipped: [] };

  const listed = await skillRegistry.listSkills(adoptId);
  const registered = new Set(
    listed.ok ? listed.value.map(item => item.id) : []
  );
  const installed: Array<{ skillId: string; displayName: string }> = [];
  const skipped: Array<{ skillId: string; reason: string }> = [];
  const excludedRoots = generatedSkillDiscoveryExcludedRoots(OPENCLAW_HOME, skillSourceDirsForRuntime());

  for (const entry of readdirSync(runtimeSkillsRoot, { withFileTypes: true })) {
    const sourceDir = path.join(runtimeSkillsRoot, entry.name);
    const discoverable = shouldDiscoverGeneratedRuntimeSkill(sourceDir, excludedRoots);
    if (!discoverable.ok) {
      if (existsSync(path.join(sourceDir, "SKILL.md"))) {
        skipped.push({ skillId: entry.name, reason: discoverable.reason });
      }
      continue;
    }
    if (!existsSync(path.join(sourceDir, "SKILL.md"))) continue;
    if (onlySkillId && entry.name !== onlySkillId) continue;

    try {
      const parsed = parseSkillSourceDirectory(sourceDir, entry.name);
      if (
        onlySkillId &&
        parsed.skillId !== onlySkillId &&
        entry.name !== onlySkillId
      )
        continue;
      if (registered.has(parsed.skillId)) {
        skipped.push({ skillId: parsed.skillId, reason: "already_registered" });
        continue;
      }

      const sourceCache = skillSourceCacheDir(adoptId, parsed.skillId);
      rmSync(sourceCache, { recursive: true, force: true });
      mkdirSync(path.dirname(sourceCache), { recursive: true });
      cpSync(sourceDir, sourceCache, { recursive: true });
      const st = statSync(sourceCache);
      if (!st.isDirectory()) {
        skipped.push({ skillId: parsed.skillId, reason: "source_copy_failed" });
        continue;
      }

      const source: SkillSource = {
        kind: "runtime_imported",
        skillId: parsed.skillId,
        displayName: parsed.displayName || parsed.skillId,
        description: parsed.description || "运行时导入的个人技能",
        sourcePath: sourceCache,
        version: String(parsed.manifest?.version || ""),
      };
      const result = await skillRegistry.install(adoptId, source);
      if (!result.ok) {
        skipped.push({ skillId: parsed.skillId, reason: result.error.detail });
        continue;
      }
      await skillRegistry.updateScan(adoptId, parsed.skillId, {
        warnings: parsed.warnings,
        scannedAt: new Date().toISOString(),
      });
      registered.add(parsed.skillId);
      installed.push({
        skillId: parsed.skillId,
        displayName: source.displayName,
      });
    } catch (e: any) {
      skipped.push({ skillId: entry.name, reason: String(e?.message || e) });
    }
  }

  return { discovered: installed.length, installed, skipped };
}

export async function discoverGeneratedRuntimeSkills(
  adoptId: string,
  runtimeAgentId: string,
  onlySkillId?: string,
): Promise<GeneratedSkillDiscoveryResult> {
  const prefix = `${adoptId}\u0000${runtimeAgentId}\u0000`;
  if (onlySkillId) {
    generatedSkillDiscoveryCache.invalidatePrefix(prefix);
    return discoverGeneratedRuntimeSkillsUncached(adoptId, runtimeAgentId, onlySkillId);
  }
  const key = `${prefix}${readSessionEpoch(adoptId)}`;
  return generatedSkillDiscoveryCache.getOrLoad(
    key,
    () => discoverGeneratedRuntimeSkillsUncached(adoptId, runtimeAgentId),
  );
}
