import semver from "semver";
import { z } from "zod";

export const SKILL_MARKET_V2_SCHEMA_VERSION = "ea.skill-market.v2" as const;

export const strictSemverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "version must use strict MAJOR.MINOR.PATCH syntax")
  .refine(
    value => semver.valid(value) === value,
    "version is not valid SemVer"
  );

export const sha256Schema = z
  .string()
  .regex(
    /^[a-f0-9]{64}$/,
    "SHA-256 must be 64 lowercase hexadecimal characters"
  );
export const skillRuntimeIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "skillId must be a lowercase kebab-case runtime slug"
  );

export const skillVisibilitySchema = z.enum(["organization", "platform"]);
export type SkillVisibility = z.infer<typeof skillVisibilitySchema>;
export const skillMaintainerTypeSchema = z.enum(["system", "user"]);
export type SkillMaintainerType = z.infer<typeof skillMaintainerTypeSchema>;

export const skillIdentityV2Schema = z
  .object({
    schemaVersion: z.literal(SKILL_MARKET_V2_SCHEMA_VERSION),
    id: z.string().min(1),
    skillId: skillRuntimeIdSchema,
    maintainerType: skillMaintainerTypeSchema,
    maintainerUserId: z.number().int().positive().nullable(),
    organizationId: z.string().min(1).nullable(),
    visibility: skillVisibilitySchema,
    sourceOrigin: z.string().min(1).max(64),
    upstreamAuthor: z.string().min(1).max(256).nullable(),
    upstreamRepository: z.string().min(1).max(1_024).nullable(),
    upstreamLicense: z.string().min(1).max(256).nullable(),
    displayName: z.string().min(1).max(128),
    description: z.string().max(4_000).optional(),
    category: z.string().min(1).max(64),
    status: z.enum(["active", "archived"]),
    latestApprovedVersionId: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .superRefine((value, context) => {
    if (value.maintainerType === "user" && !value.maintainerUserId) {
      context.addIssue({
        code: "custom",
        path: ["maintainerUserId"],
        message: "user-maintained Skills require maintainerUserId",
      });
    }
    if (value.maintainerType === "system" && value.maintainerUserId) {
      context.addIssue({
        code: "custom",
        path: ["maintainerUserId"],
        message: "system-maintained Skills must not have a user maintainer",
      });
    }
    if (value.visibility === "organization" && !value.organizationId) {
      context.addIssue({
        code: "custom",
        path: ["organizationId"],
        message: "organization visibility requires organizationId",
      });
    }
    if (value.visibility === "platform" && value.organizationId) {
      context.addIssue({
        code: "custom",
        path: ["organizationId"],
        message: "platform visibility must not be scoped to an organization",
      });
    }
  });
export type SkillIdentityV2 = z.infer<typeof skillIdentityV2Schema>;

export const skillVersionStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "revoked",
  "offline",
]);
export type SkillVersionStatus = z.infer<typeof skillVersionStatusSchema>;

export const skillVersionV2Schema = z
  .object({
    schemaVersion: z.literal(SKILL_MARKET_V2_SCHEMA_VERSION),
    id: z.string().min(1),
    skillIdentityId: z.string().min(1),
    version: strictSemverSchema,
    artifactSha256: sha256Schema,
    artifactSize: z.number().int().positive(),
    artifactPath: z.string().min(1),
    upstreamRevision: z.string().min(1).max(256).nullable(),
    status: skillVersionStatusSchema,
    changelog: z.string().max(8_000).optional(),
    submittedBy: z.number().int().positive(),
    submittedAt: z.string().min(1),
    reviewedBy: z.number().int().positive().nullable(),
    reviewedAt: z.string().min(1).nullable(),
    reviewNote: z.string().max(8_000).nullable(),
    scanPolicyFingerprint: sha256Schema,
    scanResultFingerprint: sha256Schema,
  })
  .superRefine((value, context) => {
    const reviewed = value.status !== "pending";
    if (reviewed && (!value.reviewedBy || !value.reviewedAt)) {
      context.addIssue({
        code: "custom",
        path: ["reviewedBy"],
        message: "reviewed versions require reviewedBy and reviewedAt",
      });
    }
  });
export type SkillVersionV2 = z.infer<typeof skillVersionV2Schema>;

export const skillAssignmentSourceSchema = z.enum([
  "personal",
  "role_preinstall",
]);
export type SkillAssignmentSource = z.infer<typeof skillAssignmentSourceSchema>;

export const agentSkillAssignmentV2Schema = z.object({
  schemaVersion: z.literal(SKILL_MARKET_V2_SCHEMA_VERSION),
  id: z.string().min(1),
  adoptId: z.string().min(1),
  skillIdentityId: z.string().min(1),
  source: skillAssignmentSourceSchema,
  assignmentRef: z.string().min(1),
  requestedVersionId: z.string().min(1),
  enabled: z.boolean(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type AgentSkillAssignmentV2 = z.infer<
  typeof agentSkillAssignmentV2Schema
>;

export const skillInstallationStateSchema = z.enum([
  "ready",
  "installing",
  "updating",
  "rolling_back",
  "failed",
  "quarantined",
  "disabled",
]);

export const agentSkillInstallationV2Schema = z
  .object({
    schemaVersion: z.literal(SKILL_MARKET_V2_SCHEMA_VERSION),
    adoptId: z.string().min(1),
    skillIdentityId: z.string().min(1),
    activeVersionId: z.string().min(1).nullable(),
    activeArtifactSha256: sha256Schema.nullable(),
    desiredVersionId: z.string().min(1).nullable(),
    desiredArtifactSha256: sha256Schema.nullable(),
    state: skillInstallationStateSchema,
    enabled: z.boolean(),
    operationId: z.string().min(1).nullable(),
    operationGeneration: z.number().int().nonnegative(),
    leaseExpiresAt: z.string().min(1).nullable(),
    lastError: z.string().max(8_000).nullable(),
    installedBy: z.number().int().positive().nullable(),
    installedAt: z.string().min(1).nullable(),
    updatedAt: z.string().min(1),
  })
  .superRefine((value, context) => {
    const activePair =
      Boolean(value.activeVersionId) === Boolean(value.activeArtifactSha256);
    const desiredPair =
      Boolean(value.desiredVersionId) === Boolean(value.desiredArtifactSha256);
    if (!activePair) {
      context.addIssue({
        code: "custom",
        path: ["activeVersionId"],
        message: "active version and digest must be set or cleared together",
      });
    }
    if (!desiredPair) {
      context.addIssue({
        code: "custom",
        path: ["desiredVersionId"],
        message: "desired version and digest must be set or cleared together",
      });
    }
    if (
      ["installing", "updating", "rolling_back", "failed"].includes(
        value.state
      ) &&
      !value.operationId
    ) {
      context.addIssue({
        code: "custom",
        path: ["operationId"],
        message: "non-ready installation state requires an operationId",
      });
    }
  });
export type AgentSkillInstallationV2 = z.infer<
  typeof agentSkillInstallationV2Schema
>;

export const roleSkillPreinstallV2Schema = z
  .object({
    schemaVersion: z.literal(SKILL_MARKET_V2_SCHEMA_VERSION),
    roleKey: z.string().min(1),
    skillIdentityId: z.string().min(1),
    versionId: z.string().min(1),
    artifactSha256: sha256Schema,
    rolePackReleaseId: z.string().min(1),
    goldenTaskRunId: z.string().min(1),
    providedArtifactSha256: sha256Schema,
    enabled: z.boolean(),
    updatedBy: z.number().int().positive(),
    updatedAt: z.string().min(1),
  })
  .superRefine((value, context) => {
    if (
      value.enabled &&
      value.artifactSha256 !== value.providedArtifactSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["providedArtifactSha256"],
        message:
          "enabled role preinstall must be validated with the exact provided artifact digest",
      });
    }
  });
export type RoleSkillPreinstallV2 = z.infer<typeof roleSkillPreinstallV2Schema>;

export const createSkillPublicationV2Schema = z.object({
  action: z.literal("create_new_skill"),
  actorUserId: z.number().int().positive(),
  maintainerType: skillMaintainerTypeSchema,
  skillId: skillRuntimeIdSchema,
  version: strictSemverSchema,
  artifactSha256: sha256Schema,
});

export const publishSkillVersionV2Schema = z.object({
  action: z.literal("publish_new_version"),
  actorUserId: z.number().int().positive(),
  selectedSkillIdentityId: z.string().min(1),
  packageSkillId: skillRuntimeIdSchema,
  version: strictSemverSchema,
  artifactSha256: sha256Schema,
});

export type SkillPublicationErrorCode =
  | "SKILL_ID_RESERVED"
  | "SKILL_ID_MISMATCH"
  | "SKILL_MAINTAINER_MISMATCH"
  | "SKILL_VERSION_NOT_GREATER"
  | "SKILL_VERSION_EXISTS"
  | "UNCHANGED_ARTIFACT";

export type SkillPublicationDecision =
  | { ok: true; action: "create_new_skill" | "publish_new_version" }
  | { ok: false; code: SkillPublicationErrorCode; detail: string };

export type ExistingSkillVersionSummary = {
  version: string;
  artifactSha256: string;
};

export function latestStrictSemver<
  T extends { version: string; submittedAt?: Date | string },
>(versions: T[]): T | undefined {
  const submittedAtMs = (value: Date | string | undefined) => {
    if (value instanceof Date) return value.getTime();
    const parsed = value ? Date.parse(value) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...versions].sort((left, right) => {
    const semverOrder = semver.rcompare(left.version, right.version);
    if (semverOrder) return semverOrder;
    return submittedAtMs(right.submittedAt) - submittedAtMs(left.submittedAt);
  })[0];
}

export function resolveLegacyCanonicalSkillId(
  legacySkillId: string,
  packageSkillId: string
): string | null {
  if (legacySkillId === packageSkillId) return packageSkillId;
  return legacySkillId.replaceAll("_", "-") === packageSkillId
    ? packageSkillId
    : null;
}

export function decideSkillPublication(input: {
  action: "create_new_skill" | "publish_new_version";
  actorUserId: number;
  maintainerType?: SkillMaintainerType;
  isPlatformAdmin?: boolean;
  packageSkillId: string;
  version: string;
  artifactSha256: string;
  selectedIdentity?: Pick<
    SkillIdentityV2,
    "id" | "skillId" | "maintainerType" | "maintainerUserId"
  > | null;
  existingIdentityForSkillId?: Pick<
    SkillIdentityV2,
    "id" | "skillId" | "maintainerType" | "maintainerUserId"
  > | null;
  existingVersions?: ExistingSkillVersionSummary[];
}): SkillPublicationDecision {
  const versions = input.existingVersions || [];
  const duplicateVersion = versions.find(
    candidate => candidate.version === input.version
  );
  const duplicateDigest = versions.find(
    candidate => candidate.artifactSha256 === input.artifactSha256
  );

  if (input.action === "create_new_skill") {
    if (input.existingIdentityForSkillId) {
      return {
        ok: false,
        code: "SKILL_ID_RESERVED",
        detail: "skillId already belongs to an existing immutable Skill",
      };
    }
    if (!input.maintainerType) {
      return {
        ok: false,
        code: "SKILL_MAINTAINER_MISMATCH",
        detail:
          "create-new publication requires an explicit system or user maintenance mode",
      };
    }
    if (input.maintainerType === "system" && !input.isPlatformAdmin) {
      return {
        ok: false,
        code: "SKILL_MAINTAINER_MISMATCH",
        detail:
          "only a platform administrator may create a system-maintained Skill",
      };
    }
    return { ok: true, action: input.action };
  }

  const identity = input.selectedIdentity;
  if (!identity || identity.skillId !== input.packageSkillId) {
    return {
      ok: false,
      code: "SKILL_ID_MISMATCH",
      detail: "package skillId must match the selected Skill identity",
    };
  }
  const canMaintain =
    (identity.maintainerType === "system" && Boolean(input.isPlatformAdmin)) ||
    (identity.maintainerType === "user" &&
      identity.maintainerUserId === input.actorUserId);
  if (!canMaintain) {
    return {
      ok: false,
      code: "SKILL_MAINTAINER_MISMATCH",
      detail:
        "system Skills require an administrator; user Skills require their assigned user maintainer",
    };
  }
  if (duplicateVersion) {
    return {
      ok: false,
      code: "SKILL_VERSION_EXISTS",
      detail: "the selected Skill already has this version",
    };
  }
  if (duplicateDigest) {
    return {
      ok: false,
      code: "UNCHANGED_ARTIFACT",
      detail:
        "the selected Skill already has a release with this artifact digest",
    };
  }
  const highestVersion = versions
    .map(candidate => candidate.version)
    .filter(candidate => semver.valid(candidate) === candidate)
    .sort(semver.rcompare)[0];
  if (highestVersion && !semver.gt(input.version, highestVersion)) {
    return {
      ok: false,
      code: "SKILL_VERSION_NOT_GREATER",
      detail: `new version must be greater than ${highestVersion}`,
    };
  }
  return { ok: true, action: input.action };
}

export function resolveEffectiveSkillAssignment(
  assignments: AgentSkillAssignmentV2[]
): AgentSkillAssignmentV2 | undefined {
  return assignments
    .filter(assignment => assignment.enabled)
    .sort((left, right) => {
      const priority = { personal: 1, role_preinstall: 2 } as const;
      return priority[right.source] - priority[left.source];
    })[0];
}
