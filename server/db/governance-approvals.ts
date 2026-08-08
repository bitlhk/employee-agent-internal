import { and, asc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import {
  governanceApprovals,
  type GovernanceApproval,
  type InsertGovernanceApproval,
} from "../../drizzle/schema";
import { getDb } from "./connection";

type ApprovalBinding = Pick<GovernanceApproval,
  "approvalId" | "principalFingerprint" | "userId" | "adoptId" |
  "capabilityId" | "operation" | "resource" | "payloadHash" | "policyCode" | "ruleVersion"
>;

function affectedRows(result: unknown): number {
  if (!Array.isArray(result)) return 0;
  const header: unknown = result[0];
  if (!header || typeof header !== "object" || !("affectedRows" in header)) return 0;
  return Number((header as { affectedRows?: unknown }).affectedRows || 0);
}

export async function expireGovernanceApprovals(now = new Date()): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.update(governanceApprovals).set({
    status: "expired",
    activeBindingKey: null,
  }).where(and(
    inArray(governanceApprovals.status, ["pending", "approved"]),
    lt(governanceApprovals.expiresAt, now),
  ));
  return affectedRows(result);
}

export async function getGovernanceApproval(approvalId: string): Promise<GovernanceApproval | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(governanceApprovals)
    .where(eq(governanceApprovals.approvalId, approvalId)).limit(1);
  return rows[0] || null;
}

export async function getActiveGovernanceApproval(activeBindingKey: string): Promise<GovernanceApproval | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(governanceApprovals)
    .where(and(
      eq(governanceApprovals.activeBindingKey, activeBindingKey),
      inArray(governanceApprovals.status, ["pending", "approved"]),
      gt(governanceApprovals.expiresAt, new Date()),
    )).limit(1);
  return rows[0] || null;
}

export async function createGovernanceApproval(
  input: Omit<InsertGovernanceApproval, "id" | "status" | "createdAt" | "updatedAt">,
): Promise<{ created: boolean; approval: GovernanceApproval }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await expireGovernanceApprovals();
  try {
    await db.insert(governanceApprovals).values(input);
  } catch (error) {
    const existing = input.activeBindingKey
      ? await getActiveGovernanceApproval(input.activeBindingKey)
      : null;
    if (existing) return { created: false, approval: existing };
    throw error;
  }
  const approval = await getGovernanceApproval(input.approvalId);
  if (!approval) throw new Error("Governance approval was not created");
  return { created: true, approval };
}

export async function listGovernanceApprovals(input: {
  userId: number;
  adoptId: string;
  statuses?: GovernanceApproval["status"][];
  limit?: number;
}): Promise<GovernanceApproval[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await expireGovernanceApprovals();
  const statuses: GovernanceApproval["status"][] = input.statuses?.length
    ? input.statuses
    : ["pending", "approved"];
  return await db.select().from(governanceApprovals).where(and(
    eq(governanceApprovals.userId, input.userId),
    eq(governanceApprovals.adoptId, input.adoptId),
    inArray(governanceApprovals.status, statuses),
  )).orderBy(asc(governanceApprovals.createdAt)).limit(Math.min(Math.max(input.limit || 50, 1), 100));
}

export async function decideGovernanceApproval(input: {
  approvalId: string;
  userId: number;
  adoptId: string;
  decision: "approved" | "rejected";
  decisionReason?: string | null;
}): Promise<GovernanceApproval | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await expireGovernanceApprovals();
  const now = new Date();
  const result = await db.update(governanceApprovals).set({
    status: input.decision,
    decidedBy: input.userId,
    decisionReason: input.decisionReason || null,
    ...(input.decision === "approved" ? { approvedAt: now } : { rejectedAt: now, activeBindingKey: null }),
  }).where(and(
    eq(governanceApprovals.approvalId, input.approvalId),
    eq(governanceApprovals.userId, input.userId),
    eq(governanceApprovals.adoptId, input.adoptId),
    eq(governanceApprovals.status, "pending"),
    gt(governanceApprovals.expiresAt, now),
  ));
  if (affectedRows(result) !== 1) return null;
  return await getGovernanceApproval(input.approvalId);
}

export async function consumeGovernanceApproval(input: ApprovalBinding): Promise<GovernanceApproval | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const now = new Date();
  const result = await db.update(governanceApprovals).set({
    status: "consumed",
    activeBindingKey: null,
    consumedAt: now,
  }).where(and(
    eq(governanceApprovals.approvalId, input.approvalId),
    eq(governanceApprovals.status, "approved"),
    eq(governanceApprovals.principalFingerprint, input.principalFingerprint),
    eq(governanceApprovals.userId, input.userId),
    eq(governanceApprovals.adoptId, input.adoptId),
    eq(governanceApprovals.capabilityId, input.capabilityId),
    eq(governanceApprovals.operation, input.operation),
    input.resource ? eq(governanceApprovals.resource, input.resource) : isNull(governanceApprovals.resource),
    eq(governanceApprovals.payloadHash, input.payloadHash),
    eq(governanceApprovals.policyCode, input.policyCode),
    eq(governanceApprovals.ruleVersion, input.ruleVersion),
    gt(governanceApprovals.expiresAt, now),
  ));
  if (affectedRows(result) !== 1) return null;
  return await getGovernanceApproval(input.approvalId);
}
