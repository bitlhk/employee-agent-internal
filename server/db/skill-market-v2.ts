import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import {
  agentSkillAssignments,
  agentSkillInstallEvents,
  agentSkillInstallations,
  runtimeOrganizationMemberships,
  skillIdentities,
  skillVersions,
  users,
  type InsertSkillIdentity,
  type InsertSkillVersion,
} from "../../drizzle/schema";
import { getDb } from "./connection";
import { latestStrictSemver } from "../../shared/skill-market-v2";

export async function getSkillIdentityById(identityId: string) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return (
    await db
      .select()
      .from(skillIdentities)
      .where(eq(skillIdentities.identityId, identityId))
      .limit(1)
  )[0];
}

export async function resolveSkillPublisherOrganization(
  userId: number
): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const membership = (
    await db
      .select()
      .from(runtimeOrganizationMemberships)
      .where(
        and(
          eq(runtimeOrganizationMemberships.userId, userId),
          eq(runtimeOrganizationMemberships.status, "active")
        )
      )
      .limit(1)
  )[0];
  if (membership?.organizationId) return membership.organizationId;
  const user = (
    await db
      .select({ organization: users.organization })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
  )[0];
  return String(user?.organization || "").trim() || `legacy-user-${userId}`;
}

export async function getSkillIdentityBySkillId(skillId: string) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return (
    await db
      .select()
      .from(skillIdentities)
      .where(eq(skillIdentities.skillId, skillId))
      .limit(1)
  )[0];
}

export async function updateSkillIdentityPresentation(input: {
  identityId: string;
  displayName: string;
  description: string | null;
  category: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db
    .update(skillIdentities)
    .set({
      displayName: input.displayName,
      description: input.description,
      category: input.category,
      updatedAt: new Date(),
    })
    .where(eq(skillIdentities.identityId, input.identityId));
  return getSkillIdentityById(input.identityId);
}

export async function listSkillIdentitiesForMaintainer(
  userId: number,
  isAdmin: boolean
) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const condition = isAdmin
    ? eq(skillIdentities.maintainerType, "system")
    : and(
        eq(skillIdentities.maintainerType, "user"),
        eq(skillIdentities.maintainerUserId, userId)
      );
  return db
    .select()
    .from(skillIdentities)
    .where(condition)
    .orderBy(skillIdentities.displayName);
}

export async function listSkillVersionsByIdentity(identityId: string) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db
    .select()
    .from(skillVersions)
    .where(eq(skillVersions.skillIdentityId, identityId))
    .orderBy(desc(skillVersions.submittedAt), desc(skillVersions.id));
}

export async function getSkillVersionById(versionId: string) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return (
    await db
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.versionId, versionId))
      .limit(1)
  )[0];
}

export async function getApprovedSkillVersionByIdentityAndVersion(
  skillIdentityId: string,
  version: string
) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return (
    await db
      .select()
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.skillIdentityId, skillIdentityId),
          eq(skillVersions.version, version),
          eq(skillVersions.status, "approved")
        )
      )
      .limit(1)
  )[0];
}

export async function getSkillVersionByLegacyMarketId(legacyMarketId: number) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return (
    await db
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.legacyMarketId, legacyMarketId))
      .limit(1)
  )[0];
}

export async function createSkillIdentityAndVersion(input: {
  identity: InsertSkillIdentity;
  version: InsertSkillVersion;
}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.transaction(async tx => {
    await tx.insert(skillIdentities).values(input.identity);
    await tx.insert(skillVersions).values(input.version);
  });
  return {
    identity: await getSkillIdentityById(String(input.identity.identityId)),
    version: await getSkillVersionById(String(input.version.versionId)),
  };
}

export async function insertSkillVersion(input: InsertSkillVersion) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.insert(skillVersions).values(input);
  return getSkillVersionById(String(input.versionId));
}

export async function reviewSkillVersionByLegacyMarketId(input: {
  legacyMarketId: number;
  status: "approved" | "rejected" | "withdrawn" | "revoked";
  reviewedBy: number;
  reviewNote?: string | null;
}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const version = await getSkillVersionByLegacyMarketId(input.legacyMarketId);
  if (!version) return null;
  await db.transaction(async tx => {
    await tx
      .update(skillVersions)
      .set({
        status: input.status,
        reviewedBy: input.reviewedBy,
        reviewedAt: new Date(),
        reviewNote: input.reviewNote || null,
      })
      .where(eq(skillVersions.versionId, version.versionId));
    const approved = await tx
      .select()
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.skillIdentityId, version.skillIdentityId),
          eq(skillVersions.status, "approved")
        )
      );
    const latest = latestStrictSemver(approved);
    await tx
      .update(skillIdentities)
      .set({
        latestApprovedVersionId: latest?.versionId || null,
        status: "active",
      })
      .where(eq(skillIdentities.identityId, version.skillIdentityId));
  });
  return getSkillVersionById(version.versionId);
}

export async function listSkillCatalogV2(input: {
  organizationId?: string | null;
}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const visible = input.organizationId
    ? or(
        eq(skillIdentities.visibility, "platform"),
        and(
          eq(skillIdentities.visibility, "organization"),
          eq(skillIdentities.organizationId, input.organizationId)
        )
      )
    : eq(skillIdentities.visibility, "platform");
  return db
    .select({ identity: skillIdentities, version: skillVersions })
    .from(skillIdentities)
    .innerJoin(
      skillVersions,
      eq(skillVersions.versionId, skillIdentities.latestApprovedVersionId)
    )
    .where(and(eq(skillIdentities.status, "active"), visible))
    .orderBy(skillIdentities.displayName);
}

export async function listApprovedSkillVersions(identityIds: string[]) {
  if (identityIds.length === 0) return [];
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db
    .select()
    .from(skillVersions)
    .where(
      and(
        inArray(skillVersions.skillIdentityId, identityIds),
        eq(skillVersions.status, "approved")
      )
    )
    .orderBy(desc(skillVersions.submittedAt), desc(skillVersions.id));
}

export async function listSkillMarketV2Projection(
  skillIds: string[],
  adoptId?: string,
  includeAllVersions = false
) {
  if (skillIds.length === 0)
    return { identities: [], versions: [], installations: [] };
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const identities = await db
    .select()
    .from(skillIdentities)
    .where(inArray(skillIdentities.skillId, skillIds));
  const identityIds = identities.map(identity => identity.identityId);
  if (identityIds.length === 0)
    return { identities, versions: [], installations: [] };
  const [versions, installations] = await Promise.all([
    db
      .select()
      .from(skillVersions)
      .where(
        includeAllVersions
          ? inArray(skillVersions.skillIdentityId, identityIds)
          : and(
              inArray(skillVersions.skillIdentityId, identityIds),
              eq(skillVersions.status, "approved")
            )
      )
      .orderBy(desc(skillVersions.submittedAt), desc(skillVersions.id)),
    adoptId
      ? db
          .select()
          .from(agentSkillInstallations)
          .where(
            and(
              eq(agentSkillInstallations.adoptId, adoptId),
              inArray(agentSkillInstallations.skillIdentityId, identityIds)
            )
          )
      : Promise.resolve([]),
  ]);
  return { identities, versions, installations };
}

export async function getAgentSkillInstallation(
  adoptId: string,
  skillIdentityId: string
) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return (
    await db
      .select()
      .from(agentSkillInstallations)
      .where(
        and(
          eq(agentSkillInstallations.adoptId, adoptId),
          eq(agentSkillInstallations.skillIdentityId, skillIdentityId)
        )
      )
      .limit(1)
  )[0];
}

export async function beginAgentSkillInstallation(input: {
  adoptId: string;
  skillIdentityId: string;
  targetVersionId: string;
  targetArtifactSha256: string;
  operationId: string;
  operation: "install" | "update" | "rollback";
  actorUserId: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const current = await getAgentSkillInstallation(
    input.adoptId,
    input.skillIdentityId
  );
  const state =
    input.operation === "install"
      ? "installing"
      : input.operation === "rollback"
        ? "rolling_back"
        : "updating";
  const generation = Number(current?.operationGeneration || 0) + 1;
  const leaseExpiresAt = new Date(Date.now() + 5 * 60_000);
  await db.transaction(async tx => {
    if (current) {
      await tx
        .update(agentSkillInstallations)
        .set({
          desiredVersionId: input.targetVersionId,
          desiredArtifactSha256: input.targetArtifactSha256,
          installState: state,
          operationId: input.operationId,
          operationGeneration: generation,
          leaseExpiresAt,
          lastError: null,
        })
        .where(eq(agentSkillInstallations.id, current.id));
    } else {
      await tx.insert(agentSkillInstallations).values({
        adoptId: input.adoptId,
        skillIdentityId: input.skillIdentityId,
        desiredVersionId: input.targetVersionId,
        desiredArtifactSha256: input.targetArtifactSha256,
        installState: state,
        enabled: true,
        operationId: input.operationId,
        operationGeneration: generation,
        leaseExpiresAt,
        installedBy: input.actorUserId,
      });
    }
    await tx.insert(agentSkillInstallEvents).values({
      eventId: randomUUID(),
      operationId: input.operationId,
      adoptId: input.adoptId,
      skillIdentityId: input.skillIdentityId,
      fromVersionId: current?.activeVersionId || null,
      toVersionId: input.targetVersionId,
      operation: input.operation,
      status: "started",
      actorUserId: input.actorUserId,
      artifactSha256: input.targetArtifactSha256,
    });
  });
  return { current, generation };
}

export async function completeAgentSkillInstallation(input: {
  adoptId: string;
  skillIdentityId: string;
  versionId: string;
  artifactSha256: string;
  operationId: string;
  operation: "install" | "update" | "rollback";
  actorUserId: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.transaction(async tx => {
    await tx
      .update(agentSkillInstallations)
      .set({
        activeVersionId: input.versionId,
        activeArtifactSha256: input.artifactSha256,
        desiredVersionId: null,
        desiredArtifactSha256: null,
        installState: "ready",
        enabled: true,
        operationId: null,
        leaseExpiresAt: null,
        lastError: null,
        installedBy: input.actorUserId,
        installedAt: new Date(),
      })
      .where(
        and(
          eq(agentSkillInstallations.adoptId, input.adoptId),
          eq(agentSkillInstallations.skillIdentityId, input.skillIdentityId),
          eq(agentSkillInstallations.operationId, input.operationId)
        )
      );
    await tx
      .insert(agentSkillAssignments)
      .values({
        assignmentId: randomUUID(),
        adoptId: input.adoptId,
        skillIdentityId: input.skillIdentityId,
        assignmentSource: "personal",
        assignmentRef: `user:${input.actorUserId}`,
        requestedVersionId: input.versionId,
        enabled: true,
      })
      .onDuplicateKeyUpdate({
        set: {
          requestedVersionId: input.versionId,
          enabled: true,
        },
      });
    await tx.insert(agentSkillInstallEvents).values({
      eventId: randomUUID(),
      operationId: input.operationId,
      adoptId: input.adoptId,
      skillIdentityId: input.skillIdentityId,
      toVersionId: input.versionId,
      operation: input.operation,
      status: "succeeded",
      actorUserId: input.actorUserId,
      artifactSha256: input.artifactSha256,
    });
  });
}

export async function failAgentSkillInstallation(input: {
  adoptId: string;
  skillIdentityId: string;
  targetVersionId: string;
  operationId: string;
  operation: "install" | "update" | "rollback";
  actorUserId: number;
  errorMessage: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.transaction(async tx => {
    await tx
      .update(agentSkillInstallations)
      .set({
        desiredVersionId: null,
        desiredArtifactSha256: null,
        installState: "failed",
        leaseExpiresAt: null,
        lastError: input.errorMessage.slice(0, 8_000),
      })
      .where(
        and(
          eq(agentSkillInstallations.adoptId, input.adoptId),
          eq(agentSkillInstallations.skillIdentityId, input.skillIdentityId),
          eq(agentSkillInstallations.operationId, input.operationId)
        )
      );
    await tx.insert(agentSkillInstallEvents).values({
      eventId: randomUUID(),
      operationId: input.operationId,
      adoptId: input.adoptId,
      skillIdentityId: input.skillIdentityId,
      toVersionId: input.targetVersionId,
      operation: input.operation,
      status: "failed",
      actorUserId: input.actorUserId,
      errorMessage: input.errorMessage.slice(0, 8_000),
    });
  });
}

export async function disableAgentSkillInstallation(input: {
  adoptId: string;
  skillId: string;
  actorUserId: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const identity = await getSkillIdentityBySkillId(input.skillId);
  if (!identity) return false;
  const current = await getAgentSkillInstallation(
    input.adoptId,
    identity.identityId
  );
  if (!current) return false;
  const operationId = randomUUID();
  await db.transaction(async tx => {
    await tx
      .update(agentSkillInstallations)
      .set({
        installState: "disabled",
        enabled: false,
        desiredVersionId: null,
        desiredArtifactSha256: null,
        operationId: null,
        leaseExpiresAt: null,
        lastError: null,
      })
      .where(eq(agentSkillInstallations.id, current.id));
    await tx
      .update(agentSkillAssignments)
      .set({ enabled: false })
      .where(
        and(
          eq(agentSkillAssignments.adoptId, input.adoptId),
          eq(agentSkillAssignments.skillIdentityId, identity.identityId),
          eq(agentSkillAssignments.assignmentSource, "personal")
        )
      );
    await tx.insert(agentSkillInstallEvents).values({
      eventId: randomUUID(),
      operationId,
      adoptId: input.adoptId,
      skillIdentityId: identity.identityId,
      fromVersionId: current.activeVersionId,
      operation: "uninstall",
      status: "succeeded",
      actorUserId: input.actorUserId,
      artifactSha256: current.activeArtifactSha256,
    });
  });
  return true;
}
