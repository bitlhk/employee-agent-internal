import type { Skill } from "../../../shared/types/skill";
import { resolveEffectiveRoleAssets } from "../../db";
import { getRoleRuntimeAdapter } from "../../routers/role-runtime-adapters";
import { isJiuwenClawAdoptId, resolveRuntimeAgentId } from "../helpers";
import { resolveAgentRoleTemplate } from "../role-templates";
import { listSkillsWithRoleDefaults } from "./role-default-skills";
import { roleSkillPreferences } from "./role-skill-preferences";
import { skillRegistry } from "./skill-registry";

export type SkillEnableResult =
  | { ok: true; item: Skill }
  | {
      ok: false;
      kind: "runtime_retired" | "not_found" | "registry_error" | "sync_failed";
      detail: string;
    };

export async function setAgentSkillEnabled(input: {
  adoptId: string;
  agentId: string;
  roleTemplate: string;
  skillId: string;
  enabled: boolean;
}): Promise<SkillEnableResult> {
  if (!isJiuwenClawAdoptId(input.adoptId)) {
    return { ok: false, kind: "runtime_retired", detail: "Legacy runtime has been archived" };
  }

  const effectiveAssets = await resolveEffectiveRoleAssets(input.roleTemplate);
  const isRoleDefault = effectiveAssets.skills.default.includes(input.skillId);
  if (!isRoleDefault) {
    const result = await skillRegistry.setEnabled(input.adoptId, input.skillId, input.enabled);
    return result.ok
      ? { ok: true, item: result.value }
      : { ok: false, kind: "registry_error", detail: result.error.detail };
  }

  const role = resolveAgentRoleTemplate(input.roleTemplate);
  const runtimeAgentId = resolveRuntimeAgentId(input.adoptId, input.agentId);
  const runtimeAdapter = getRoleRuntimeAdapter("jiuwenswarm");
  const registered = await skillRegistry.listSkills(input.adoptId);
  if (!registered.ok) {
    return { ok: false, kind: "registry_error", detail: registered.error.detail };
  }

  const roleDefaultSkillIds = new Set(effectiveAssets.skills.default);
  const activeSkillIds = registered.value
    .filter((skill) =>
      !roleDefaultSkillIds.has(skill.id) && skill.enabled && skill.state === "ready"
    )
    .map((skill) => skill.id);
  const previousDisabled = roleSkillPreferences.getDisabledDefaultSkillIds(input.adoptId);
  const wasDisabled = previousDisabled.includes(input.skillId);
  const applyRoleScope = async (disabledDefaultSkillIds: string[]) => {
    const result = await runtimeAdapter.reconcileSkills({
      adoptId: input.adoptId,
      agentId: runtimeAgentId,
      role,
      effectiveAssets,
      activeSkillIds,
      disabledDefaultSkillIds,
    });
    if (!result.ok) throw new Error(result.reason || "岗位技能同步失败");
  };

  const disabledDefaultSkillIds = roleSkillPreferences.setDefaultSkillEnabled(
    input.adoptId,
    input.skillId,
    input.enabled,
  );
  try {
    await applyRoleScope(disabledDefaultSkillIds);
    await runtimeAdapter.bumpSessionEpoch(input.adoptId, runtimeAgentId);
  } catch (error) {
    roleSkillPreferences.setDefaultSkillEnabled(
      input.adoptId,
      input.skillId,
      wasDisabled ? false : true,
    );
    await applyRoleScope(previousDisabled).catch(() => undefined);
    return {
      ok: false,
      kind: "sync_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const projected = await listSkillsWithRoleDefaults({
    adoptId: input.adoptId,
    agentId: runtimeAgentId,
    roleTemplate: input.roleTemplate,
  });
  if (!projected.ok) {
    return { ok: false, kind: "registry_error", detail: projected.error.detail };
  }
  const item = projected.value.find((skill) => skill.id === input.skillId);
  return item
    ? { ok: true, item }
    : { ok: false, kind: "not_found", detail: "skill not found" };
}
