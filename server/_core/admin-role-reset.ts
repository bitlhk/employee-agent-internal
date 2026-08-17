import { TRPCError } from "@trpc/server";
import {
  appendClawAdoptionEvent,
  getClawAdoptionAdminById,
  resolveEffectiveRoleAssets,
} from "../db";
import { logWarn } from "./observability/logger";
import {
  resolveAgentRoleTemplate,
  type AgentRoleTemplate,
  type AgentRuntime,
} from "./role-templates";
import { retiredRuntimeMessage } from "./runtime-policy";
import { roleSkillPreferences } from "./skills/role-skill-preferences";
import { skillRegistry } from "./skills/skill-registry";
import type { Skill } from "../../shared/types/skill";
import { getRoleRuntimeAdapter } from "../routers/role-runtime-adapters";
import { reconcileRoleRuntimeAssets } from "./role-runtime-adapter";

export type AdminClawAdoption = NonNullable<
  Awaited<ReturnType<typeof getClawAdoptionAdminById>>
>;

type EffectiveRoleAssets = Awaited<ReturnType<typeof resolveEffectiveRoleAssets>>;

const roleResettableStatuses = new Set(["creating", "active", "expiring"]);
const personalSkillSourceKinds = new Set(["uploaded", "generated"]);

export const diffSortedRoleAssets = (
  before: readonly string[] = [],
  after: readonly string[] = [],
) => {
  const beforeSet = new Set(before.map((item) => String(item || "").trim()).filter(Boolean));
  const afterSet = new Set(after.map((item) => String(item || "").trim()).filter(Boolean));
  return {
    added: [...afterSet].filter((item) => !beforeSet.has(item)).sort(),
    removed: [...beforeSet].filter((item) => !afterSet.has(item)).sort(),
  };
};

const diffEffectiveRoleAssets = (before: EffectiveRoleAssets, after: EffectiveRoleAssets) => ({
  skills: {
    default: diffSortedRoleAssets(before.skills.default, after.skills.default),
    optional: diffSortedRoleAssets(before.skills.optional, after.skills.optional),
  },
  mcpServers: {
    default: diffSortedRoleAssets(before.mcpServers.default, after.mcpServers.default),
    optional: diffSortedRoleAssets(before.mcpServers.optional, after.mcpServers.optional),
  },
});

const resolveRoleResetRuntime = (row: AdminClawAdoption): AgentRuntime => {
  const runtime = String(row.runtime || "").trim();
  if (runtime === "jiuwenswarm" || String(row.adoptId || "").startsWith("lgj-")) {
    return "jiuwenswarm";
  }
  throw new TRPCError({ code: "BAD_REQUEST", message: retiredRuntimeMessage() });
};

const resolveActiveSkillIdsAfterRoleReset = async (
  adoptId: string,
  effectiveAssets: EffectiveRoleAssets,
): Promise<string[]> => {
  const allowedSkillIds = new Set(
    [...effectiveAssets.skills.default, ...effectiveAssets.skills.optional]
      .map((skillId) => String(skillId || "").trim())
      .filter(Boolean),
  );
  const listed = await skillRegistry.listSkills(adoptId);
  if (!listed.ok) {
    logWarn("agent.role_reset.skill_list_failed", {
      adoptId,
      kind: listed.error.kind,
      detail: listed.error.detail,
    });
    return [];
  }
  return listed.value
    .filter((skill: Skill) => skill.enabled && skill.state === "ready")
    .filter((skill: Skill) => {
      const sourceKind = String(skill.source?.kind || "");
      if (personalSkillSourceKinds.has(sourceKind)) return true;
      return (
        allowedSkillIds.has(String(skill.id || "").trim()) ||
        allowedSkillIds.has(String(skill.source?.skillId || "").trim())
      );
    })
    .map((skill: Skill) => String(skill.id || skill.source?.skillId || "").trim())
    .filter(Boolean)
    .sort();
};

export const resolveSelectableAdoptRoleTemplate = (
  roleId?: string | null,
): AgentRoleTemplate => {
  const role = resolveAgentRoleTemplate(roleId);
  if (role.status !== "mvp") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `岗位暂未开放申请: ${role.name}`,
    });
  }
  return role;
};

export const applyAdminRoleReset = async (input: {
  before: AdminClawAdoption;
  role: AgentRoleTemplate;
  operatorId: number | null;
  targetStatus?: string | null;
}) => {
  const adoptId = String(input.before.adoptId || "");
  const agentId = String(input.before.agentId || "");
  const runtime = resolveRoleResetRuntime(input.before);
  const status = String(input.targetStatus || input.before.status || "");

  if (!adoptId || !agentId) {
    return {
      applied: false,
      runtime,
      reason: "missing runtime agent identifiers",
    };
  }
  if (!roleResettableStatuses.has(status)) {
    return {
      applied: false,
      runtime,
      reason: `status ${status || "unknown"} is not resettable`,
    };
  }

  const previousRoleTemplate = String(input.before.roleTemplate || "general-assistant");
  const previousEffectiveAssets = await resolveEffectiveRoleAssets(previousRoleTemplate);
  const effectiveAssets = await resolveEffectiveRoleAssets(input.role.id);
  const effectiveAssetDiff = diffEffectiveRoleAssets(previousEffectiveAssets, effectiveAssets);
  const activeSkillIds = await resolveActiveSkillIdsAfterRoleReset(adoptId, effectiveAssets);
  const runtimeAdapter = getRoleRuntimeAdapter(runtime);
  const assetReconcile = await reconcileRoleRuntimeAssets(runtimeAdapter, {
    adoptId,
    agentId,
    role: input.role,
    effectiveAssets,
    activeSkillIds,
  });
  roleSkillPreferences.clear(adoptId);
  const sessionEpoch = await runtimeAdapter.bumpSessionEpoch(adoptId, agentId);

  await appendClawAdoptionEvent({
    adoptionId: Number(input.before.id),
    eventType: "profile_updated",
    operatorType: "admin",
    operatorId: input.operatorId,
    detail: JSON.stringify({
      action: "role_reset",
      previousRoleTemplate,
      roleTemplate: input.role.id,
      industry: input.role.industry,
      runtime,
      previousEffectiveAssets,
      effectiveAssets,
      effectiveAssetDiff,
      activeSkillIds,
      skillReconcile: assetReconcile,
      mcpReconcile: assetReconcile,
      sessionEpoch,
    }),
  });

  return {
    applied: true,
    runtime,
    previousRoleTemplate,
    previousEffectiveAssets,
    effectiveAssets,
    effectiveAssetDiff,
    skillReconcile: assetReconcile,
    mcpReconcile: assetReconcile,
    sessionEpoch,
  };
};
