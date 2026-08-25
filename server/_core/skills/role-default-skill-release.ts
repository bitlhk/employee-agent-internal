import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  roleSkillPreinstallV2Schema,
  SKILL_MARKET_V2_SCHEMA_VERSION,
} from "../../../shared/skill-market-v2";
import {
  deleteRoleSkillPreinstall,
  getClawByAdoptId,
  getRoleSkillPreinstall,
  getSkillIdentityBySkillId,
  getSkillVersionById,
  getVerifiedRolePackRelease,
  resolveEffectiveRoleAssets,
  upsertRoleSkillPreinstall,
  type UpsertRoleSkillPreinstallInput,
} from "../../db";
import { recordAuditRequired } from "../audit-events";
import {
  resolveRuntimeAgentId,
  resolveRuntimeWorkspaceByIds,
} from "../helpers";
import { resolveAgentRoleTemplate } from "../role-templates";
import { getRoleRuntimeAdapter } from "../../routers/role-runtime-adapters";
import {
  digestSkillSourceTree,
  verifyImmutableSkillArtifact,
} from "./skill-artifact";
import { skillInstaller } from "./skill-installer";
import { parseSkillSourceDirectory } from "./skill-source";
import { skillStoreMarketplaceDir, skillStorePath } from "./skill-store";

export type RoleDefaultSkillReleaseEvidence = {
  roleKey: string;
  skillId: string;
  skillIdentityId: string;
  versionSkillIdentityId: string;
  versionStatus: string;
  artifactSha256: string;
  providedArtifactSha256: string;
  defaultSkillIds: string[];
  rolePackReleaseStatus: string;
};

export function assertRoleDefaultSkillReleaseEvidence(
  evidence: RoleDefaultSkillReleaseEvidence
): void {
  if (evidence.versionStatus !== "approved") {
    throw new Error("Role-default release requires an approved Skill version");
  }
  if (evidence.skillIdentityId !== evidence.versionSkillIdentityId) {
    throw new Error(
      "Skill version does not belong to the requested immutable identity"
    );
  }
  if (!evidence.defaultSkillIds.includes(evidence.skillId)) {
    throw new Error(
      `Skill ${evidence.skillId} is not a default Skill for ${evidence.roleKey}`
    );
  }
  if (evidence.rolePackReleaseStatus !== "verified") {
    throw new Error(
      "Role-default release requires a verified Role Pack release"
    );
  }
  if (evidence.artifactSha256 !== evidence.providedArtifactSha256) {
    throw new Error(
      "Golden Task evidence did not provide the exact approved Skill artifact"
    );
  }
}

async function reconcileRoleAdoption(input: {
  adoptId: string;
  roleKey: string;
  skillId: string;
  expectedArtifactSha256: string;
}) {
  const adoption = await getClawByAdoptId(input.adoptId);
  if (!adoption)
    throw new Error(`Agent adoption is unavailable: ${input.adoptId}`);
  const roleTemplate = String(adoption.roleTemplate || "general-assistant");
  if (roleTemplate !== input.roleKey) {
    throw new Error(
      `Agent ${input.adoptId} belongs to ${roleTemplate}, not ${input.roleKey}`
    );
  }
  const role = resolveAgentRoleTemplate(roleTemplate);
  const effectiveAssets = await resolveEffectiveRoleAssets(role.id);
  const adapter = getRoleRuntimeAdapter("jiuwenswarm");
  const agentId = resolveRuntimeAgentId(
    input.adoptId,
    String(adoption.agentId || "")
  );
  const result = await adapter.reconcileSkills({
    adoptId: input.adoptId,
    agentId,
    role,
    effectiveAssets,
  });
  if (!result.ok)
    throw new Error(
      result.reason || `Skill reconciliation failed: ${input.adoptId}`
    );
  await adapter.refreshCapabilities(input.adoptId, agentId);
  const runtimePath = path.join(
    resolveRuntimeWorkspaceByIds(input.adoptId, agentId),
    "skills",
    input.skillId
  );
  const runtimeDigest = digestSkillSourceTree(runtimePath);
  if (runtimeDigest.sha256 !== input.expectedArtifactSha256) {
    throw new Error(
      `Runtime Skill digest mismatch for ${input.adoptId}: ${runtimeDigest.sha256}`
    );
  }
  return {
    adoptId: input.adoptId,
    agentId,
    runtimePath,
    artifactSha256: runtimeDigest.sha256,
    changed: Number(result.changed || 0),
  };
}

export async function releaseRoleDefaultSkillVersion(input: {
  roleKey: string;
  skillId: string;
  versionId: string;
  rolePackReleaseId: string;
  goldenTaskRunId: string;
  providedArtifactSha256: string;
  actorUserId: number;
  adoptIds: string[];
}) {
  const operationId = randomUUID();
  const identity = await getSkillIdentityBySkillId(input.skillId);
  if (!identity || identity.status !== "active") {
    throw new Error(`Active Skill identity is unavailable: ${input.skillId}`);
  }
  const version = await getSkillVersionById(input.versionId);
  if (!version)
    throw new Error(`Skill version is unavailable: ${input.versionId}`);
  const release = await getVerifiedRolePackRelease(input.rolePackReleaseId);
  const effectiveAssets = await resolveEffectiveRoleAssets(input.roleKey);
  assertRoleDefaultSkillReleaseEvidence({
    roleKey: input.roleKey,
    skillId: input.skillId,
    skillIdentityId: identity.identityId,
    versionSkillIdentityId: version.skillIdentityId,
    versionStatus: version.status,
    artifactSha256: version.artifactSha256,
    providedArtifactSha256: input.providedArtifactSha256,
    defaultSkillIds: effectiveAssets.skills.default,
    rolePackReleaseStatus: release?.status || "missing",
  });
  if (!input.goldenTaskRunId.trim())
    throw new Error("Golden Task run ID is required");
  if (!input.adoptIds.length)
    throw new Error("At least one target Agent adoption is required");

  verifyImmutableSkillArtifact({
    artifactPath: version.artifactPath,
    artifactSha256: version.artifactSha256,
  });
  const parsed = parseSkillSourceDirectory(
    version.artifactPath,
    identity.skillId
  );
  if (parsed.skillId !== identity.skillId || parsed.warnings.length > 0) {
    throw new Error(
      parsed.skillId !== identity.skillId
        ? "Approved artifact Skill identity mismatch"
        : `Approved artifact failed validation: ${parsed.warnings.join("; ")}`
    );
  }

  const previous = await getRoleSkillPreinstall(
    input.roleKey,
    identity.identityId
  );
  const targetPath = path.join(
    skillStoreMarketplaceDir("approved"),
    identity.skillId
  );
  const backupPath = skillStorePath(
    "archive",
    "role-default-releases",
    operationId,
    identity.skillId
  );
  const hadTarget = existsSync(targetPath);

  await recordAuditRequired({
    action: "skill.role_default.release.requested",
    result: "success",
    severity: "high",
    actorType: "user",
    actorUserId: input.actorUserId,
    actorRole: "admin",
    targetType: "role_template",
    targetId: input.roleKey,
    resourceType: "skill",
    resourceId: identity.identityId,
    source: "role_default_skill_release",
    correlationId: operationId,
    metadata: {
      skillId: identity.skillId,
      versionId: version.versionId,
      version: version.version,
      artifactSha256: version.artifactSha256,
      rolePackReleaseId: input.rolePackReleaseId,
      goldenTaskRunId: input.goldenTaskRunId,
      adoptIds: input.adoptIds,
    },
  });
  if (hadTarget) await skillInstaller.installFromSource(targetPath, backupPath);

  const restorePreviousRecord = async () => {
    if (previous) {
      await upsertRoleSkillPreinstall({
        roleKey: previous.roleKey,
        skillIdentityId: previous.skillIdentityId,
        versionId: previous.versionId,
        artifactSha256: previous.artifactSha256,
        rolePackReleaseId: previous.rolePackReleaseId,
        goldenTaskRunId: previous.goldenTaskRunId,
        providedArtifactSha256: previous.providedArtifactSha256,
        enabled: previous.enabled,
        updatedBy: previous.updatedBy,
      });
    } else {
      await deleteRoleSkillPreinstall(input.roleKey, identity.identityId);
    }
  };

  try {
    await skillInstaller.installFromSource(version.artifactPath, targetPath);
    const reconciled = [];
    for (const adoptId of [...new Set(input.adoptIds)]) {
      reconciled.push(
        await reconcileRoleAdoption({
          adoptId,
          roleKey: input.roleKey,
          skillId: identity.skillId,
          expectedArtifactSha256: version.artifactSha256,
        })
      );
    }
    const rowInput: UpsertRoleSkillPreinstallInput = {
      roleKey: input.roleKey,
      skillIdentityId: identity.identityId,
      versionId: version.versionId,
      artifactSha256: version.artifactSha256,
      rolePackReleaseId: input.rolePackReleaseId,
      goldenTaskRunId: input.goldenTaskRunId,
      providedArtifactSha256: input.providedArtifactSha256,
      enabled: true,
      updatedBy: input.actorUserId,
    };
    roleSkillPreinstallV2Schema.parse({
      schemaVersion: SKILL_MARKET_V2_SCHEMA_VERSION,
      ...rowInput,
      updatedAt: new Date().toISOString(),
    });
    const preinstall = await upsertRoleSkillPreinstall(rowInput);
    await recordAuditRequired({
      action: "skill.role_default.release.completed",
      result: "success",
      severity: "high",
      actorType: "user",
      actorUserId: input.actorUserId,
      actorRole: "admin",
      targetType: "role_template",
      targetId: input.roleKey,
      resourceType: "skill",
      resourceId: identity.identityId,
      source: "role_default_skill_release",
      correlationId: operationId,
      metadata: {
        skillId: identity.skillId,
        versionId: version.versionId,
        version: version.version,
        artifactSha256: version.artifactSha256,
        rolePackReleaseId: input.rolePackReleaseId,
        goldenTaskRunId: input.goldenTaskRunId,
        reconciled,
      },
    });
    await rm(path.dirname(backupPath), { recursive: true, force: true });
    return {
      operationId,
      identity,
      version,
      preinstall,
      reconciled,
      targetPath,
    };
  } catch (error) {
    if (hadTarget && existsSync(backupPath)) {
      await skillInstaller
        .installFromSource(backupPath, targetPath)
        .catch(() => undefined);
    } else if (!hadTarget) {
      await rm(targetPath, { recursive: true, force: true }).catch(
        () => undefined
      );
    }
    await restorePreviousRecord().catch(() => undefined);
    for (const adoptId of [...new Set(input.adoptIds)]) {
      const expected =
        hadTarget && existsSync(targetPath)
          ? digestSkillSourceTree(targetPath).sha256
          : "";
      if (!expected) continue;
      await reconcileRoleAdoption({
        adoptId,
        roleKey: input.roleKey,
        skillId: identity.skillId,
        expectedArtifactSha256: expected,
      }).catch(() => undefined);
    }
    await recordAuditRequired({
      action: "skill.role_default.release.failed",
      result: "failed",
      severity: "high",
      actorType: "user",
      actorUserId: input.actorUserId,
      actorRole: "admin",
      targetType: "role_template",
      targetId: input.roleKey,
      resourceType: "skill",
      resourceId: identity.identityId,
      source: "role_default_skill_release",
      correlationId: operationId,
      errorCode: "ROLE_DEFAULT_SKILL_RELEASE_FAILED",
      metadata: {
        skillId: identity.skillId,
        versionId: version.versionId,
        rollbackAttempted: true,
        error: error instanceof Error ? error.message : String(error),
      },
    }).catch(() => undefined);
    await rm(path.dirname(backupPath), { recursive: true, force: true }).catch(
      () => undefined
    );
    throw error;
  }
}
