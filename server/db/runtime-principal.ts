import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  runtimeAuthorizationSnapshots,
  runtimeOrganizationMemberships,
  runtimeOrganizations,
} from "../../drizzle/schema";
import { governanceFingerprint } from "../_core/governance/contracts";
import { getDb } from "./connection";

export type AuthorizationSnapshotInput = {
  userId: number;
  organizationName?: string | null;
  groupIds?: Array<string | number>;
  adoptionId: string;
  agentId: string;
  roleTemplate: string;
  workspaceId: string;
  permissionProfile: string;
};

export type ResolvedAuthorizationSnapshot = {
  tenantId: string;
  organizationId: string;
  authorizationSnapshotId: string;
  authorizationFingerprint: string;
};

function stableId(prefix: string, value: unknown, length = 24): string {
  return `${prefix}_${governanceFingerprint(value).slice(0, length)}`;
}

function stableSourceId(prefix: string, source: string): string {
  return `${prefix}_${createHash("sha256").update(source).digest("hex").slice(0, 24)}`;
}

function normalizeOrganization(value: string | null | undefined): string {
  return String(value || "").trim().replace(/\s+/gu, " ");
}

function normalizeGroupIds(values: Array<string | number> | undefined): string[] {
  return Array.from(new Set((values || [])
    .map(value => String(value).trim())
    .filter(value => value && value !== "0")))
    .sort();
}

export async function resolveOrCreateAuthorizationSnapshot(
  input: AuthorizationSnapshotInput,
): Promise<ResolvedAuthorizationSnapshot> {
  const database = await getDb();
  if (!database) throw new Error("Database not available");

  const [existingMembership] = await database
    .select()
    .from(runtimeOrganizationMemberships)
    .where(eq(runtimeOrganizationMemberships.userId, input.userId))
    .limit(1);
  if (existingMembership?.status === "revoked") {
    throw new Error("Runtime organization membership is revoked");
  }

  const organizationName = normalizeOrganization(input.organizationName);
  const personal = !organizationName;
  const organizationSeed = personal
    ? `personal-user:${input.userId}`
    : organizationName.toLowerCase();
  const organizationId = existingMembership?.organizationId
    || stableSourceId(personal ? "org_personal" : "org", organizationSeed);
  const tenantId = stableSourceId("tn", organizationSeed);
  const groupIds = normalizeGroupIds(input.groupIds);

  if (!existingMembership) {
    await database.insert(runtimeOrganizations).values({
      organizationId,
      tenantId,
      displayName: organizationName || `Personal workspace ${input.userId}`,
      identitySource: personal ? "personal" : "legacy",
      externalSubject: personal ? `user:${input.userId}` : organizationSeed,
    }).onDuplicateKeyUpdate({
      set: { displayName: organizationName || `Personal workspace ${input.userId}` },
    });

    await database.insert(runtimeOrganizationMemberships).values({
      membershipId: stableId("mem", { organizationId, userId: input.userId }),
      organizationId,
      userId: input.userId,
      groupIds,
    }).onDuplicateKeyUpdate({
      set: { groupIds, status: "active", revokedAt: null },
    });
  }

  const [organization] = await database
    .select()
    .from(runtimeOrganizations)
    .where(eq(runtimeOrganizations.organizationId, organizationId))
    .limit(1);
  if (!organization || organization.status !== "active") {
    throw new Error("Runtime organization is missing or disabled");
  }

  const authority = {
    tenantId: organization.tenantId,
    organizationId: organization.organizationId,
    userId: input.userId,
    adoptionId: input.adoptionId,
    agentId: input.agentId,
    roleTemplate: input.roleTemplate,
    workspaceId: input.workspaceId,
    permissionProfile: input.permissionProfile,
    groupIds: existingMembership?.groupIds || groupIds,
    membershipVersion: existingMembership?.membershipVersion || 1,
  };
  const authorizationFingerprint = governanceFingerprint(authority);
  const authorizationSnapshotId = stableId("authz", authority, 32);

  await database.insert(runtimeAuthorizationSnapshots).values({
    snapshotId: authorizationSnapshotId,
    authorizationFingerprint,
    tenantId: organization.tenantId,
    organizationId: organization.organizationId,
    userId: input.userId,
    adoptionId: input.adoptionId,
    agentId: input.agentId,
    roleTemplate: input.roleTemplate,
    workspaceId: input.workspaceId,
    permissionProfile: input.permissionProfile,
    authorityJson: authority,
  }).onDuplicateKeyUpdate({
    set: { snapshotId: authorizationSnapshotId },
  });

  return {
    tenantId: organization.tenantId,
    organizationId: organization.organizationId,
    authorizationSnapshotId,
    authorizationFingerprint,
  };
}

export async function getRuntimeAuthorizationSnapshot(snapshotId: string) {
  const database = await getDb();
  if (!database) return undefined;
  const [snapshot] = await database
    .select()
    .from(runtimeAuthorizationSnapshots)
    .where(eq(runtimeAuthorizationSnapshots.snapshotId, snapshotId))
    .limit(1);
  return snapshot;
}
