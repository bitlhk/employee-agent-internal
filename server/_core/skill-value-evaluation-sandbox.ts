import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import {
  createClawAdoption,
  createUser,
  getClawByAdoptId,
  getUserByEmail,
  listClawAdoptionsAdmin,
  resolveEffectiveRoleAssets,
  updateClawAdoptionStatus,
} from "../db";
import { resolveRuntimeWorkspaceByIds } from "./helpers";
import { refreshJiuwenRuntimeCapabilities } from "./jiuwenswarm-runtime-refresh";
import { digestSkillSourceTree } from "./skills/skill-artifact-digest";
import { roleSkillPreferences } from "./skills/role-skill-preferences";
import { skillInstaller } from "./skills/skill-installer";
import { skillRegistry } from "./skills/skill-registry";
import type { SkillValueEvaluationArtifact } from "./skill-value-evaluation-runner";
import { evaluationOrganizationKey } from "./skill-value-evaluation-store";

const EVALUATION_SANDBOX_TTL_MS = 24 * 60 * 60 * 1_000;
const EVALUATION_SANDBOX_TTL_DAYS = 1;

export async function ensureSkillValueEvaluationUser(organization: string) {
  const organizationName = organization.trim() || "EA Skill Evaluation";
  const email = `skill-value-eval+${evaluationOrganizationKey(organizationName)}@local.linggan.invalid`;
  let user = await getUserByEmail(email);
  if (!user) {
    await createUser({
      name: "Skill Value Evaluator",
      email,
      loginMethod: "internal_evaluation",
      role: "user",
      accessLevel: "all",
      organization: organizationName,
    });
    user = await getUserByEmail(email);
  }
  if (!user) throw new Error("无法创建 Skill 评测用户");
  return user;
}

export async function ensureSkillValueEvaluationAdoption(input: {
  adoptionId: string;
  userId: number;
  roleTemplate: string;
}) {
  const agentId = `jiuwen_${input.adoptionId}`;
  let adoption = await getClawByAdoptId(input.adoptionId);
  if (!adoption) {
    await createClawAdoption({
      userId: input.userId,
      adoptId: input.adoptionId,
      agentId,
      status: "active",
      permissionProfile: "internal",
      roleTemplate: input.roleTemplate,
      industry: input.roleTemplate.includes("insurance") ? "insurance" : "financial",
      runtime: "jiuwenswarm",
      ttlDays: EVALUATION_SANDBOX_TTL_DAYS,
      entryUrl: `/workspace?adoptId=${encodeURIComponent(input.adoptionId)}`,
      expiresAt: new Date(Date.now() + EVALUATION_SANDBOX_TTL_MS),
    });
    adoption = await getClawByAdoptId(input.adoptionId);
  }
  if (adoption) {
    await updateClawAdoptionStatus(adoption.id, "active", {
      ttlDays: EVALUATION_SANDBOX_TTL_DAYS,
      expiresAt: new Date(Date.now() + EVALUATION_SANDBOX_TTL_MS),
      lastError: null,
    });
    adoption = await getClawByAdoptId(input.adoptionId);
  }
  if (
    !adoption
    || Number(adoption.userId) !== input.userId
    || String(adoption.agentId) !== agentId
    || String(adoption.roleTemplate) !== input.roleTemplate
    || adoption.status !== "active"
  ) {
    throw new Error(`隔离评测实例 ${input.adoptionId} 状态不兼容`);
  }
  return adoption;
}

export async function reclaimExpiredSkillValueEvaluationSandboxes(
  activeAdoptionIds: Set<string>,
): Promise<void> {
  const now = Date.now();
  const rows = await listClawAdoptionsAdmin({ keyword: "lgj-eval-", limit: 1_000 });
  for (const row of rows) {
    const adoptId = String(row.adoptId || "");
    const expiresAt = row.expiresAt ? new Date(row.expiresAt).getTime() : 0;
    const managedSandbox = adoptId.startsWith("lgj-eval-ui-")
      || adoptId.startsWith("lgj-eval-context-");
    if (!managedSandbox || activeAdoptionIds.has(adoptId) || expiresAt > now) continue;
    const agentId = String(row.agentId || "");
    if (agentId) {
      rmSync(resolveRuntimeWorkspaceByIds(adoptId, agentId), { recursive: true, force: true });
    }
    if (row.status !== "recycled") {
      await updateClawAdoptionStatus(Number(row.id), "recycled", {
        // Legacy evaluation rows may not have an expiry. Record the actual
        // recycle time instead of writing the Unix epoch, which MySQL can
        // reject after timezone conversion.
        expiresAt: new Date(now),
        lastError: null,
      });
    }
  }
}

export async function materializeSkillValueEvaluationSide(input: {
  adoptionId: string;
  agentId: string;
  roleTemplate: string;
  skillId: string;
  skillName: string;
  artifact: SkillValueEvaluationArtifact;
}) {
  const effectiveAssets = await resolveEffectiveRoleAssets(input.roleTemplate);
  for (const defaultSkillId of effectiveAssets.skills.default) {
    roleSkillPreferences.setDefaultSkillEnabled(input.adoptionId, defaultSkillId, false);
  }
  const listed = await skillRegistry.listSkills(input.adoptionId);
  if (listed.ok) {
    for (const skill of listed.value) {
      if (input.artifact && skill.id === input.skillId) continue;
      await skillRegistry.uninstall(input.adoptionId, skill.id).catch(() => undefined);
    }
  }
  if (!input.artifact) {
    roleSkillPreferences.setDefaultSkillEnabled(input.adoptionId, input.skillId, false);
    await skillRegistry.uninstall(input.adoptionId, input.skillId).catch(() => undefined);
    await skillRegistry.refreshRuntimeProjection(input.adoptionId);
    const runtimePath = path.join(
      resolveRuntimeWorkspaceByIds(input.adoptionId, input.agentId),
      "skills",
      input.skillId,
    );
    if (existsSync(runtimePath)) rmSync(runtimePath, { recursive: true, force: true });
    return;
  }
  const digest = digestSkillSourceTree(input.artifact.artifactPath);
  if (digest.sha256 !== input.artifact.artifactSha256) {
    throw new Error(`${input.skillId}@${input.artifact.version} Artifact 已变化`);
  }
  roleSkillPreferences.setDefaultSkillEnabled(input.adoptionId, input.skillId, true);
  const installResult = await skillRegistry.install(
    input.adoptionId,
    {
      kind: "marketplace",
      skillId: input.skillId,
      displayName: input.skillName,
      description: "Skill 价值评测隔离版本",
      sourcePath: input.artifact.artifactPath,
      marketplaceId: input.artifact.versionId,
      version: input.artifact.version,
    },
    {
      allowVersionDowngrade: true,
      preserveImmutableSourcePath: true,
    },
  );
  if (!installResult.ok) throw new Error(installResult.error.detail);
  const runtimePath = String(installResult.value.sync.runtimePath || "").trim();
  if (!runtimePath) throw new Error("Skill 评测 Runtime 路径为空");
  await skillRegistry.refreshRuntimeProjection(input.adoptionId);

  // Re-apply the frozen artifact after role projection refreshes shared defaults.
  await skillInstaller.installFromSource(input.artifact.artifactPath, runtimePath);
  const runtimeDigest = digestSkillSourceTree(runtimePath);
  if (runtimeDigest.sha256 !== input.artifact.artifactSha256) {
    throw new Error(`${input.skillId}@${input.artifact.version} Runtime Artifact 装配失败`);
  }
  await refreshJiuwenRuntimeCapabilities(input.adoptionId);
}
