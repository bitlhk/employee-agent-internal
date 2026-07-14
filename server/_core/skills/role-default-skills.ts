import { existsSync, statSync } from "fs";
import path from "path";
import type { Skill, SkillRegistryResult } from "../../../shared/types/skill";
import { resolveEffectiveRoleAssets } from "../../db/role-assets";
import { resolveRuntimeWorkspaceByIds } from "../helpers";
import { skillRegistry } from "./skill-registry";
import { parseSkillSourceDirectory } from "./skill-source";

type MergeRoleDefaultSkillsInput = {
  adoptId: string;
  defaultSkillIds: string[];
  registeredSkills: Skill[];
  runtimeWorkspaceDir: string;
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
  const registeredById = new Map(input.registeredSkills.map((skill) => [skill.id, skill]));
  const now = (input.now || new Date()).toISOString();

  const defaults = defaultSkillIds.map((skillId): Skill => {
    const existing = registeredById.get(skillId);
    const runtimePath = path.join(input.runtimeWorkspaceDir, "skills", skillId);
    const runtimeExists = existsSync(path.join(runtimePath, "SKILL.md"));
    const metadata = runtimeExists
      ? runtimeSkillMetadata(runtimePath, skillId)
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
        displayName: metadata.displayName,
        description: metadata.description,
        version: metadata.version,
      },
      state: runtimeExists ? "ready" : "source_missing",
      enabled: true,
      review: existing?.review || { state: "none" },
      sync: {
        ...existing?.sync,
        runtimePath,
        runtimeMtimeMs,
        lastSyncedAt: modifiedAt,
        reason: runtimeExists ? "岗位默认技能，由岗位配置统一管理" : "岗位默认技能尚未同步到运行时",
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
  return {
    ok: true,
    value: mergeRoleDefaultSkills({
      adoptId: input.adoptId,
      defaultSkillIds: effectiveAssets.skills.default,
      registeredSkills: listed.value,
      runtimeWorkspaceDir: resolveRuntimeWorkspaceByIds(input.adoptId, input.agentId),
    }),
  };
}
