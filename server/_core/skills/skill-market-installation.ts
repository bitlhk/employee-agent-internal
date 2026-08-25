import { randomUUID } from "node:crypto";
import semver from "semver";
import type { SkillSource } from "../../../shared/types/skill";
import {
  beginAgentSkillInstallation,
  completeAgentSkillInstallation,
  failAgentSkillInstallation,
  getAgentSkillInstallation,
  getClawByAdoptId,
  getSkillIdentityById,
  getSkillVersionById,
  resolveEffectiveRoleAssets,
} from "../../db";
import { verifyImmutableSkillArtifact } from "./skill-artifact";
import { skillRegistry } from "./skill-registry";
import { parseSkillSourceDirectory } from "./skill-source";

export function assertMarketplaceInstallDoesNotOverrideRoleDefault(input: {
  skillId: string;
  roleTemplate: string;
  defaultSkillIds: string[];
}): void {
  if (!input.defaultSkillIds.includes(input.skillId)) return;
  throw new Error(
    `Skill ${input.skillId} is managed by the ${input.roleTemplate} role default; use the governed role-default release flow instead`,
  );
}

export async function installApprovedSkillVersion(input: {
  adoptId: string;
  versionId: string;
  actorUserId: number;
  organizationId: string;
}) {
  const version = await getSkillVersionById(input.versionId);
  if (!version || version.status !== "approved") {
    throw new Error("Skill version is not approved or is unavailable");
  }
  const identity = await getSkillIdentityById(version.skillIdentityId);
  if (!identity || identity.status !== "active")
    throw new Error("Skill identity is unavailable");
  if (
    identity.visibility === "organization" &&
    identity.organizationId !== input.organizationId
  ) {
    throw new Error("Skill version is not visible to this organization");
  }
  const adoption = await getClawByAdoptId(input.adoptId);
  if (!adoption) throw new Error("Agent adoption is unavailable");
  const roleTemplate = String(adoption.roleTemplate || "general-assistant");
  const effectiveAssets = await resolveEffectiveRoleAssets(roleTemplate);
  assertMarketplaceInstallDoesNotOverrideRoleDefault({
    skillId: identity.skillId,
    roleTemplate,
    defaultSkillIds: effectiveAssets.skills.default,
  });
  verifyImmutableSkillArtifact({
    artifactPath: version.artifactPath,
    artifactSha256: version.artifactSha256,
  });
  const parsed = parseSkillSourceDirectory(
    version.artifactPath,
    identity.skillId
  );
  if (parsed.skillId !== identity.skillId) {
    throw new Error(
      "approved artifact skillId does not match its immutable Skill identity"
    );
  }
  if (parsed.warnings.length > 0) {
    throw new Error(
      `approved artifact no longer passes static validation: ${parsed.warnings.slice(0, 5).join("; ")}`
    );
  }

  const current = await getAgentSkillInstallation(
    input.adoptId,
    identity.identityId
  );
  const activeVersion = current?.activeVersionId
    ? await getSkillVersionById(current.activeVersionId)
    : undefined;
  const operation = !activeVersion
    ? ("install" as const)
    : semver.lt(version.version, activeVersion.version)
      ? ("rollback" as const)
      : ("update" as const);
  const operationId = randomUUID();
  await beginAgentSkillInstallation({
    adoptId: input.adoptId,
    skillIdentityId: identity.identityId,
    targetVersionId: version.versionId,
    targetArtifactSha256: version.artifactSha256,
    operationId,
    operation,
    actorUserId: input.actorUserId,
  });

  const source: SkillSource = {
    kind: "marketplace",
    skillId: identity.skillId,
    displayName: identity.displayName,
    description: identity.description || "",
    sourcePath: version.artifactPath,
    marketplaceId: String(version.legacyMarketId || version.versionId),
    version: version.version,
  };
  try {
    const installed = await skillRegistry.install(input.adoptId, source, {
      allowVersionDowngrade: operation === "rollback",
      preserveImmutableSourcePath: true,
    });
    if (!installed.ok) throw new Error(installed.error.detail);
    await skillRegistry.updateScan(input.adoptId, identity.skillId, {
      warnings: parsed.warnings,
      scannedAt: new Date().toISOString(),
    });
    await completeAgentSkillInstallation({
      adoptId: input.adoptId,
      skillIdentityId: identity.identityId,
      versionId: version.versionId,
      artifactSha256: version.artifactSha256,
      operationId,
      operation,
      actorUserId: input.actorUserId,
    });
    return {
      identity,
      version,
      operation,
      operationId,
      item: installed.value,
      warnings: parsed.warnings,
    };
  } catch (error) {
    await failAgentSkillInstallation({
      adoptId: input.adoptId,
      skillIdentityId: identity.identityId,
      targetVersionId: version.versionId,
      operationId,
      operation,
      actorUserId: input.actorUserId,
      errorMessage: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    throw error;
  }
}
