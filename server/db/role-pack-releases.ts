import { and, desc, eq, ne } from "drizzle-orm";
import { rolePackReleases, type RolePackRelease } from "../../drizzle/schema";
import type { ReleaseEvidenceRef } from "../_core/governance/task-execution-envelope";
import { getDb } from "./connection";

export type PersistRolePackReleaseInput = {
  releaseId: string;
  rolePackId: string;
  evalSuiteVersion: string;
  assetSetFingerprint: string;
  verificationLevel: "contract" | "controlled_scenario" | "model_scenario";
  status: "candidate" | "verified" | "failed";
  contractReport: Record<string, unknown>;
  scenarioReport?: Record<string, unknown> | null;
  verifiedAt?: Date | null;
};

export async function persistRolePackRelease(input: PersistRolePackReleaseInput): Promise<RolePackRelease> {
  const database = await getDb();
  if (!database) throw new Error("Database not available");
  const [existing] = await database.select().from(rolePackReleases)
    .where(eq(rolePackReleases.releaseId, input.releaseId)).limit(1);
  const verificationRank = { contract: 1, controlled_scenario: 2, model_scenario: 3 } as const;
  const preserveStrongerVerification = input.status === "verified"
    && existing?.status === "verified"
    && verificationRank[existing.verificationLevel] > verificationRank[input.verificationLevel];
  const verificationLevel = preserveStrongerVerification ? existing.verificationLevel : input.verificationLevel;
  const scenarioReport = preserveStrongerVerification ? existing.scenarioReport : input.scenarioReport || null;
  const verifiedAt = preserveStrongerVerification
    ? existing.verifiedAt
    : input.status === "verified" ? input.verifiedAt || new Date() : null;
  if (input.status === "verified") {
    await database.update(rolePackReleases).set({ status: "stale" }).where(and(
      eq(rolePackReleases.rolePackId, input.rolePackId),
      eq(rolePackReleases.evalSuiteVersion, input.evalSuiteVersion),
      eq(rolePackReleases.status, "verified"),
      ne(rolePackReleases.assetSetFingerprint, input.assetSetFingerprint),
    ));
  }
  await database.insert(rolePackReleases).values({
    ...input,
    verificationLevel,
    scenarioReport,
    verifiedAt,
  }).onDuplicateKeyUpdate({
    set: {
      verificationLevel,
      status: input.status,
      contractReport: input.contractReport,
      scenarioReport,
      verifiedAt,
    },
  });
  const [release] = await database.select().from(rolePackReleases)
    .where(eq(rolePackReleases.releaseId, input.releaseId)).limit(1);
  if (!release) throw new Error("Role Pack release persistence failed");
  return release;
}

export async function resolveRolePackReleaseEvidence(input: {
  rolePackId: string;
  evalSuiteVersion: string;
  assetSetFingerprint: string;
}): Promise<ReleaseEvidenceRef> {
  const database = await getDb();
  if (!database) throw new Error("Database not available");
  const [exact] = await database.select().from(rolePackReleases).where(and(
    eq(rolePackReleases.rolePackId, input.rolePackId),
    eq(rolePackReleases.evalSuiteVersion, input.evalSuiteVersion),
    eq(rolePackReleases.assetSetFingerprint, input.assetSetFingerprint),
  )).limit(1);
  if (exact?.status === "verified") return releaseEvidence(exact, "verified");
  if (exact?.status === "stale") return releaseEvidence(exact, "stale");

  const [latestVerified] = await database.select().from(rolePackReleases).where(and(
    eq(rolePackReleases.rolePackId, input.rolePackId),
    eq(rolePackReleases.evalSuiteVersion, input.evalSuiteVersion),
    eq(rolePackReleases.status, "verified"),
  )).orderBy(desc(rolePackReleases.verifiedAt)).limit(1);
  if (latestVerified) return {
    ...releaseEvidence(latestVerified, "stale"),
    assetSetFingerprint: input.assetSetFingerprint,
  };
  return {
    rolePackReleaseId: exact?.releaseId || `${input.rolePackId}@unverified`,
    evalSuiteVersion: input.evalSuiteVersion,
    verificationStatus: "unverified",
    verificationLevel: exact?.verificationLevel || "contract",
    assetSetFingerprint: input.assetSetFingerprint,
  };
}

function releaseEvidence(
  release: RolePackRelease,
  verificationStatus: ReleaseEvidenceRef["verificationStatus"],
): ReleaseEvidenceRef {
  return {
    rolePackReleaseId: release.releaseId,
    evalSuiteVersion: release.evalSuiteVersion,
    verificationStatus,
    verificationLevel: release.verificationLevel,
    lastPassedAt: release.verifiedAt?.toISOString(),
    assetSetFingerprint: release.assetSetFingerprint,
  };
}
