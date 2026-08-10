import { and, asc, eq } from "drizzle-orm";
import {
  enterpriseMcpCallReceipts,
  enterpriseMcpConnections,
  enterpriseMcpToolPolicies,
  type EnterpriseMcpCallReceipt,
  type EnterpriseMcpConnection,
  type EnterpriseMcpToolPolicy,
  type InsertEnterpriseMcpConnection,
} from "../../drizzle/schema";
import type { CustomMcpToolSnapshot } from "./custom-mcp-connections";
import { decryptSecret, encryptSecret } from "../_core/secret-protection";
import type { EnterpriseMcpToolPolicyDraft } from "../_core/enterprise-mcp-policy";
import { getDb } from "./connection";

export type PublicEnterpriseMcpConnection = Omit<EnterpriseMcpConnection, "credentialEncrypted" | "toolsJson"> & {
  credentialConfigured: boolean;
  tools: CustomMcpToolSnapshot[];
};

export function toPublicEnterpriseMcpConnection(row: EnterpriseMcpConnection): PublicEnterpriseMcpConnection {
  const { credentialEncrypted, toolsJson, ...safe } = row;
  return {
    ...safe,
    credentialConfigured: Boolean(credentialEncrypted),
    tools: Array.isArray(toolsJson) ? toolsJson as CustomMcpToolSnapshot[] : [],
  };
}

export function revealEnterpriseMcpCredential(row: EnterpriseMcpConnection): string {
  return row.credentialEncrypted ? decryptSecret(row.credentialEncrypted) : "";
}

export async function listEnterpriseMcpConnections(): Promise<EnterpriseMcpConnection[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return await db.select().from(enterpriseMcpConnections).orderBy(asc(enterpriseMcpConnections.businessDomain), asc(enterpriseMcpConnections.displayName));
}

export async function getEnterpriseMcpConnection(serverId: string): Promise<EnterpriseMcpConnection | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(enterpriseMcpConnections).where(eq(enterpriseMcpConnections.serverId, serverId)).limit(1);
  return rows[0] || null;
}

export async function createEnterpriseMcpConnection(
  input: Omit<InsertEnterpriseMcpConnection, "id" | "credentialEncrypted" | "healthStatus" | "identityVerificationStatus" | "identityVerificationError" | "identityVerifiedAt" | "lastError" | "toolsJson" | "lastTestedAt"> & {
    credential?: string | null;
  },
): Promise<EnterpriseMcpConnection> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const { credential, ...stored } = input;
  await db.insert(enterpriseMcpConnections).values({
    ...stored,
    credentialEncrypted: credential ? encryptSecret(credential, { maxStoredLength: null }) : null,
  });
  const row = await getEnterpriseMcpConnection(input.serverId);
  if (!row) throw new Error("Enterprise MCP connection was not created");
  return row;
}

export async function updateEnterpriseMcpConnection(
  serverId: string,
  patch: Partial<Omit<InsertEnterpriseMcpConnection, "id" | "serverId" | "credentialEncrypted" | "createdAt">> & {
    credential?: string | null;
  },
): Promise<EnterpriseMcpConnection | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const values: Record<string, unknown> = { ...patch };
  delete values.credential;
  if (patch.credential !== undefined) {
    values.credentialEncrypted = patch.credential ? encryptSecret(patch.credential, { maxStoredLength: null }) : null;
  }
  await db.update(enterpriseMcpConnections).set(values).where(eq(enterpriseMcpConnections.serverId, serverId));
  return await getEnterpriseMcpConnection(serverId);
}

export async function listEnterpriseMcpToolPolicies(serverId: string): Promise<EnterpriseMcpToolPolicy[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return await db.select().from(enterpriseMcpToolPolicies)
    .where(eq(enterpriseMcpToolPolicies.serverId, serverId))
    .orderBy(asc(enterpriseMcpToolPolicies.toolName));
}

export async function upsertEnterpriseMcpToolPolicies(input: {
  serverId: string;
  policies: EnterpriseMcpToolPolicyDraft[];
  actor: string;
}): Promise<EnterpriseMcpToolPolicy[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  for (const policy of input.policies) {
    await db.insert(enterpriseMcpToolPolicies).values({
      serverId: input.serverId,
      ...policy,
      createdBy: input.actor,
      updatedBy: input.actor,
    }).onDuplicateKeyUpdate({
      set: {
        enabled: policy.enabled,
        sideEffect: policy.sideEffect,
        requiredScopes: policy.requiredScopes,
        allowedRoles: policy.allowedRoles,
        identityModeOverride: policy.identityModeOverride,
        approvalMode: policy.approvalMode,
        auditLevel: policy.auditLevel,
        idempotencyRequired: policy.idempotencyRequired,
        argumentPolicyJson: policy.argumentPolicyJson,
        updatedBy: input.actor,
      },
    });
  }
  return await listEnterpriseMcpToolPolicies(input.serverId);
}

export async function reserveEnterpriseMcpCall(input: {
  requestId: string;
  policyDecisionId: string;
  approvalId?: string | null;
  idempotencyKey?: string | null;
  serverId: string;
  toolName: string;
  userId: number;
  tenantId: string;
  adoptId: string;
  roleKey: string;
  identityMode: "platform" | "tenant" | "user";
  argsHash: string;
}): Promise<{ reserved: boolean; receipt: EnterpriseMcpCallReceipt }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  try {
    await db.insert(enterpriseMcpCallReceipts).values({ ...input, idempotencyKey: input.idempotencyKey || null });
  } catch (error) {
    if (!input.idempotencyKey) throw error;
    const rows = await db.select().from(enterpriseMcpCallReceipts).where(and(
      eq(enterpriseMcpCallReceipts.adoptId, input.adoptId),
      eq(enterpriseMcpCallReceipts.serverId, input.serverId),
      eq(enterpriseMcpCallReceipts.toolName, input.toolName),
      eq(enterpriseMcpCallReceipts.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (rows[0]) return { reserved: false, receipt: rows[0] };
    throw error;
  }
  const rows = await db.select().from(enterpriseMcpCallReceipts)
    .where(eq(enterpriseMcpCallReceipts.requestId, input.requestId)).limit(1);
  if (!rows[0]) throw new Error("Enterprise MCP call receipt was not created");
  return { reserved: true, receipt: rows[0] };
}

export async function getEnterpriseMcpCallReceiptByApprovalId(approvalId: string): Promise<EnterpriseMcpCallReceipt | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(enterpriseMcpCallReceipts)
    .where(eq(enterpriseMcpCallReceipts.approvalId, approvalId)).limit(1);
  return rows[0] || null;
}

export async function completeEnterpriseMcpCall(input: {
  requestId: string;
  status: "completed" | "failed" | "blocked";
  resultHash?: string | null;
  externalRequestId?: string | null;
  durationMs?: number | null;
  errorCode?: string | null;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(enterpriseMcpCallReceipts).set({
    status: input.status,
    resultHash: input.resultHash || null,
    externalRequestId: input.externalRequestId || null,
    durationMs: input.durationMs ?? null,
    errorCode: input.errorCode || null,
    completedAt: new Date(),
  }).where(eq(enterpriseMcpCallReceipts.requestId, input.requestId));
}
