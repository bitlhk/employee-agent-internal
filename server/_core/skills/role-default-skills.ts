import { existsSync, statSync } from "fs";
import path from "path";
import type { Skill, SkillRegistryResult } from "../../../shared/types/skill";
import { resolveEffectiveRoleAssets } from "../../db/role-assets";
import { resolveRuntimeWorkspaceByIds } from "../helpers";
import { skillRegistry } from "./skill-registry";
import { roleSkillPreferences } from "./role-skill-preferences";
import { parseSkillSourceDirectory } from "./skill-source";
import { skillSourceDirsForRuntime } from "./skill-store";

type MergeRoleDefaultSkillsInput = {
  adoptId: string;
  defaultSkillIds: string[];
  disabledDefaultSkillIds?: string[];
  registeredSkills: Skill[];
  runtimeWorkspaceDir: string;
  skillSourceDirs?: string[];
  now?: Date;
};

function uniqueSkillIds(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean))).sort();
}

function runtimeSkillMetadata(runtimePath: string, skillId: string): {
  displayName: string;
  description?: string;
  version?: string;
  warnings?: string[];
} {
  try {
    const parsed = parseSkillSourceDirectory(runtimePath, skillId);
    return {
      displayName: parsed.displayName || skillId,
      description: parsed.description || undefined,
      version: String(parsed.manifest?.version || "") || undefined,
      warnings: parsed.warnings.length ? parsed.warnings : undefined,
    };
  } catch {
    return { displayName: skillId };
  }
}

export function mergeRoleDefaultSkills(input: MergeRoleDefaultSkillsInput): Skill[] {
  const defaultSkillIds = uniqueSkillIds(input.defaultSkillIds);
  const defaultSet = new Set(defaultSkillIds);
  const disabledSet = new Set(uniqueSkillIds(input.disabledDefaultSkillIds || []));
  const registeredById = new Map(input.registeredSkills.map((skill) => [skill.id, skill]));
  const now = (input.now || new Date()).toISOString();

  const defaults = defaultSkillIds.map((skillId): Skill => {
    const existing = registeredById.get(skillId);
    const runtimePath = path.join(input.runtimeWorkspaceDir, "skills", skillId);
    const runtimeExists = existsSync(path.join(runtimePath, "SKILL.md"));
    const sourcePath = (input.skillSourceDirs || [])
      .map((sourceDir) => path.join(sourceDir, skillId))
      .find((candidate) => existsSync(path.join(candidate, "SKILL.md")));
    const metadataPath = runtimeExists ? runtimePath : sourcePath;
    const metadata = metadataPath
      ? runtimeSkillMetadata(metadataPath, skillId)
      : {
          displayName: existing?.source.displayName || skillId,
          description: existing?.source.description,
          version: existing?.source.version,
          warnings: existing?.scan?.warnings,
        };
    let modifiedAt = now;
    let runtimeMtimeMs: number | undefined;
    try {
      const stats = statSync(runtimePath);
      runtimeMtimeMs = stats.mtimeMs;
      modifiedAt = stats.mtime.toISOString();
    } catch {}

    return {
      id: skillId,
      adoptId: input.adoptId,
      source: {
        ...existing?.source,
        kind: "role_default",
        skillId,
        sourcePath: existing?.source.sourcePath || sourcePath,
        displayName: metadata.displayName,
        description: metadata.description,
        version: metadata.version,
      },
      state: disabledSet.has(skillId) ? "disabled" : runtimeExists ? "ready" : "source_missing",
      enabled: !disabledSet.has(skillId) && runtimeExists,
      review: existing?.review || { state: "none" },
      sync: {
        ...existing?.sync,
        runtimePath,
        runtimeMtimeMs,
        lastSyncedAt: modifiedAt,
        reason: disabledSet.has(skillId)
          ? "岗位预置技能已由用户停用"
          : runtimeExists
            ? "岗位预置技能，可停用但不可删除"
            : "岗位预置技能尚未同步到运行时",
      },
      scan: metadata.warnings
        ? { warnings: metadata.warnings, scannedAt: modifiedAt }
        : existing?.scan,
      capabilities: existing?.capabilities || [],
      examples: existing?.examples || [],
      createdAt: existing?.createdAt || modifiedAt,
      updatedAt: modifiedAt,
    };
  });

  const userManaged = input.registeredSkills.filter((skill) =>
    !defaultSet.has(skill.id) && skill.source.kind !== "role_default"
  );
  return [...defaults, ...userManaged];
}

export async function listSkillsWithRoleDefaults(input: {
  adoptId: string;
  agentId: string;
  roleTemplate: string;
}): Promise<SkillRegistryResult<Skill[]>> {
  const listed = await skillRegistry.listSkills(input.adoptId);
  if (!listed.ok) return listed;
  const effectiveAssets = await resolveEffectiveRoleAssets(input.roleTemplate);
  const skillSourceDirs = skillSourceDirsForRuntime();
  return {
    ok: true,
    value: mergeRoleDefaultSkills({
      adoptId: input.adoptId,
      defaultSkillIds: effectiveAssets.skills.default,
      disabledDefaultSkillIds: roleSkillPreferences.getDisabledDefaultSkillIds(input.adoptId),
      registeredSkills: listed.value,
      runtimeWorkspaceDir: resolveRuntimeWorkspaceByIds(input.adoptId, input.agentId),
      skillSourceDirs,
    }),
  };
}
