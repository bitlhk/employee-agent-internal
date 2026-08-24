import { createHash, randomUUID } from "node:crypto";
import semver from "semver";
import {
  createSkillIdentityAndVersion,
  deleteSkillMarketItem,
  getSkillIdentityById,
  getSkillIdentityBySkillId,
  insertSkillMarketItem,
  insertSkillVersion,
  listSkillVersionsByIdentity,
} from "../../db";
import {
  SKILL_MARKET_V2_SCHEMA_VERSION,
  decideSkillPublication,
  strictSemverSchema,
  type SkillIdentityV2,
  type SkillMaintainerType,
} from "../../../shared/skill-market-v2";
import {
  digestSkillSourceTree,
  materializeImmutableSkillArtifact,
} from "./skill-artifact";
import { parseSkillSourceDirectory } from "./skill-source";

const STATIC_SCAN_POLICY = "ea.skill.static-scan.v1";

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function identityContract(
  identity: NonNullable<Awaited<ReturnType<typeof getSkillIdentityById>>>
): SkillIdentityV2 {
  return {
    schemaVersion: SKILL_MARKET_V2_SCHEMA_VERSION,
    id: identity.identityId,
    skillId: identity.skillId,
    maintainerType: identity.maintainerType,
    maintainerUserId: identity.maintainerUserId,
    organizationId: identity.organizationId,
    visibility: identity.visibility,
    sourceOrigin: identity.sourceOrigin,
    upstreamAuthor: identity.upstreamAuthor,
    upstreamRepository: identity.upstreamRepository,
    upstreamLicense: identity.upstreamLicense,
    displayName: identity.displayName,
    description: identity.description || undefined,
    category: identity.category,
    status: identity.status,
    latestApprovedVersionId: identity.latestApprovedVersionId,
    createdAt: identity.createdAt.toISOString(),
    updatedAt: identity.updatedAt.toISOString(),
  };
}

export type PublishSkillVersionInput = {
  action: "create_new_skill" | "publish_new_version";
  sourcePath: string;
  actorUserId: number;
  isPlatformAdmin: boolean;
  maintainerType: SkillMaintainerType;
  organizationId: string | null;
  visibility: "organization" | "platform";
  selectedIdentityId?: string;
  requestedVersion: string;
  changelog?: string;
  authorLabel: string;
  sourceOrigin: string;
  category?: string;
  license?: string;
  upstreamRepository?: string | null;
};

export async function publishSkillVersionFromSource(
  input: PublishSkillVersionInput
) {
  const parsed = parseSkillSourceDirectory(input.sourcePath, "skill");
  const version = strictSemverSchema.parse(input.requestedVersion);
  const sourceDigest = digestSkillSourceTree(input.sourcePath);
  const selectedIdentity = input.selectedIdentityId
    ? await getSkillIdentityById(input.selectedIdentityId)
    : undefined;
  const existingIdentity = await getSkillIdentityBySkillId(parsed.skillId);
  const versions = selectedIdentity
    ? await listSkillVersionsByIdentity(selectedIdentity.identityId)
    : [];
  const decision = decideSkillPublication({
    action: input.action,
    actorUserId: input.actorUserId,
    maintainerType: input.maintainerType,
    isPlatformAdmin: input.isPlatformAdmin,
    packageSkillId: parsed.skillId,
    version,
    artifactSha256: sourceDigest.sha256,
    selectedIdentity: selectedIdentity
      ? identityContract(selectedIdentity)
      : null,
    existingIdentityForSkillId: existingIdentity
      ? identityContract(existingIdentity)
      : null,
    existingVersions: versions.map(row => ({
      version: row.version,
      artifactSha256: row.artifactSha256,
    })),
  });
  if (!decision.ok) {
    const error = new Error(decision.detail) as Error & { code: string };
    error.code = decision.code;
    throw error;
  }

  const artifact = await materializeImmutableSkillArtifact({
    sourcePath: input.sourcePath,
    skillId: parsed.skillId,
    version,
  });

  const identityId = selectedIdentity?.identityId || randomUUID();
  const versionId = randomUUID();
  const scanPolicyFingerprint = fingerprint({ policy: STATIC_SCAN_POLICY });
  const scanResultFingerprint = fingerprint({
    policy: STATIC_SCAN_POLICY,
    artifactSha256: artifact.sha256,
    warnings: parsed.warnings,
  });
  const legacyMarketId = await insertSkillMarketItem({
    skillId: parsed.skillId,
    name: parsed.displayName || parsed.skillId,
    description: parsed.description || null,
    author: input.authorLabel,
    authorUserId: input.maintainerType === "user" ? input.actorUserId : null,
    version,
    category: input.category || "general",
    origin: input.sourceOrigin,
    status: "pending",
    license: input.license || String(parsed.manifest?.license || "MIT"),
    packagePath: artifact.artifactPath,
  });

  try {
    const release = {
      versionId,
      skillIdentityId: identityId,
      legacyMarketId,
      version,
      artifactSha256: artifact.sha256,
      artifactSize: artifact.size,
      artifactPath: artifact.artifactPath,
      status: "pending" as const,
      changelog: input.changelog || null,
      submittedBy: input.actorUserId,
      scanPolicyFingerprint,
      scanResultFingerprint,
    };
    if (input.action === "create_new_skill") {
      await createSkillIdentityAndVersion({
        identity: {
          identityId,
          skillId: parsed.skillId,
          maintainerType: input.maintainerType,
          maintainerUserId:
            input.maintainerType === "user" ? input.actorUserId : null,
          organizationId:
            input.visibility === "organization" ? input.organizationId : null,
          visibility: input.visibility,
          sourceOrigin: input.sourceOrigin,
          upstreamAuthor: input.authorLabel,
          upstreamRepository: input.upstreamRepository || null,
          upstreamLicense:
            input.license || String(parsed.manifest?.license || "MIT"),
          displayName: parsed.displayName || parsed.skillId,
          description: parsed.description || null,
          category: input.category || "general",
          status: "active",
          latestApprovedVersionId: null,
          legacyPrimaryMarketId: legacyMarketId,
        },
        version: release,
      });
    } else {
      await insertSkillVersion(release);
    }
  } catch (error) {
    await deleteSkillMarketItem(legacyMarketId).catch(() => undefined);
    throw error;
  }

  return {
    identityId,
    skillId: parsed.skillId,
    versionId,
    version,
    artifactSha256: artifact.sha256,
    legacyMarketId,
    warnings: parsed.warnings,
    status: "pending" as const,
  };
}

export function normalizeLegacySkillVersion(
  value: string,
  fallbackPatch: number
): {
  version: string;
  originalVersion: string | null;
} {
  const trimmed = String(value || "").trim();
  if (strictSemverSchema.safeParse(trimmed).success) {
    return { version: trimmed, originalVersion: null };
  }
  const coerced = semver.coerce(trimmed)?.version;
  return {
    version: coerced || `0.0.${Math.max(1, fallbackPatch)}`,
    originalVersion: trimmed || null,
  };
}
