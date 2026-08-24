import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  governedWorkItemExecutions,
  governedWorkItems,
  type GovernedWorkItem,
  type GovernedWorkItemExecution,
  type InsertGovernedWorkItem,
} from "../../drizzle/schema";
import type { GovernedWorkItemStatusV1, WorkExecutionOperationV1 } from "../../shared/work-continuity";
import {
  isPurposeScopedRecordVisible,
  type MemoryRetrievalScopeV1,
} from "../../shared/memory-purpose";
import { getDb } from "./connection";

async function database() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db;
}

function affectedRows(result: unknown): number {
  if (!Array.isArray(result)) return 0;
  const header = result[0];
  return header && typeof header === "object" && "affectedRows" in header
    ? Number((header as { affectedRows?: unknown }).affectedRows || 0)
    : 0;
}

export type GovernedWorkScope = {
  organizationId: string;
  userId: number;
  adoptId: string;
};

export async function createGovernedWorkItemDrafts(inputs: InsertGovernedWorkItem[]) {
  if (!inputs.length) return [];
  for (const input of inputs) {
    const purposeIds = Array.isArray(input.purposeScopeJson) ? input.purposeScopeJson.map(String).filter(Boolean) : [];
    const governedScope = Boolean(
      input.visibilityClass
      || purposeIds.length
      || input.subjectId
      || input.scopeProvenanceJson,
    );
    if (governedScope && (!purposeIds.length || !input.scopeProvenanceJson)) {
      throw new Error("PURPOSE_SCOPE_INCOMPLETE");
    }
  }
  const db = await database();
  return db.transaction(async tx => {
    await tx.insert(governedWorkItems).values(inputs);
    return tx.select().from(governedWorkItems)
      .where(inArray(governedWorkItems.workItemId, inputs.map(item => item.workItemId)))
      .orderBy(asc(governedWorkItems.createdAt), asc(governedWorkItems.id));
  });
}

export async function getGovernedWorkItem(scope: GovernedWorkScope, workItemId: string) {
  const [row] = await (await database()).select().from(governedWorkItems).where(and(
    eq(governedWorkItems.workItemId, workItemId),
    eq(governedWorkItems.organizationId, scope.organizationId),
    eq(governedWorkItems.userId, scope.userId),
    eq(governedWorkItems.adoptId, scope.adoptId),
  )).limit(1);
  return row || null;
}

export async function listGovernedWorkItems(input: GovernedWorkScope & {
  statuses?: GovernedWorkItemStatusV1[];
  limit?: number;
}) {
  const statuses = input.statuses?.length ? input.statuses : undefined;
  return (await database()).select().from(governedWorkItems).where(and(
    eq(governedWorkItems.organizationId, input.organizationId),
    eq(governedWorkItems.userId, input.userId),
    eq(governedWorkItems.adoptId, input.adoptId),
    ...(statuses ? [inArray(governedWorkItems.status, statuses)] : []),
  )).orderBy(desc(governedWorkItems.updatedAt), desc(governedWorkItems.id))
    .limit(Math.max(1, Math.min(input.limit || 100, 200)));
}

export async function listGovernedWorkItemsForPurpose(input: {
  scope: MemoryRetrievalScopeV1;
  statuses?: GovernedWorkItemStatusV1[];
  limit?: number;
}): Promise<{
  items: GovernedWorkItem[];
  candidateRecordCount: number;
  filteredRecordCount: number;
}> {
  const statuses = input.statuses?.length ? input.statuses : undefined;
  const candidates = await (await database()).select().from(governedWorkItems).where(and(
    eq(governedWorkItems.organizationId, input.scope.organizationId),
    ...(statuses ? [inArray(governedWorkItems.status, statuses)] : []),
  )).orderBy(desc(governedWorkItems.updatedAt), desc(governedWorkItems.id))
    .limit(Math.max(1, Math.min(input.limit || 500, 1_000)));
  const items = candidates.filter(item => isPurposeScopedRecordVisible({
    organizationId: item.organizationId,
    userId: item.userId,
    adoptionId: item.adoptId,
    roleTemplate: item.roleTemplate,
    visibilityClass: item.visibilityClass,
    purposeIds: Array.isArray(item.purposeScopeJson) ? item.purposeScopeJson : [],
    subjectId: item.subjectId,
    purposeScopeVersion: item.purposeScopeVersion,
  }, input.scope));
  return {
    items,
    candidateRecordCount: candidates.length,
    filteredRecordCount: candidates.length - items.length,
  };
}

export async function listGovernedWorkItemExecutions(scope: GovernedWorkScope, workItemIds: string[]) {
  if (!workItemIds.length) return [];
  return (await database()).select().from(governedWorkItemExecutions).where(and(
    eq(governedWorkItemExecutions.organizationId, scope.organizationId),
    eq(governedWorkItemExecutions.userId, scope.userId),
    eq(governedWorkItemExecutions.adoptId, scope.adoptId),
    inArray(governedWorkItemExecutions.workItemId, workItemIds),
  )).orderBy(desc(governedWorkItemExecutions.createdAt), desc(governedWorkItemExecutions.id));
}

export async function executeGovernedWorkItemTransition(input: GovernedWorkScope & {
  executionReceiptId: string;
  workItemId: string;
  operation: WorkExecutionOperationV1;
  expectedStatuses: GovernedWorkItemStatusV1[];
  toStatus: GovernedWorkItemStatusV1;
  requestedBy: string;
  confirmedBy: string;
  confirmedAt: Date;
  approvalId?: string | null;
  idempotencyKey: string;
  payloadHash: string;
  contextReceiptFingerprint?: string | null;
  resultFingerprint: string;
  patch?: {
    subject?: string;
    description?: string | null;
    ownerPrincipalId?: string | null;
    ownerDisplayName?: string | null;
    dueAt?: Date | null;
    relatedContextJson?: string[];
  };
}): Promise<{ item: GovernedWorkItem; execution: GovernedWorkItemExecution; reused: boolean }> {
  const db = await database();
  return db.transaction(async tx => {
    const [existing] = await tx.select().from(governedWorkItemExecutions).where(and(
      eq(governedWorkItemExecutions.organizationId, input.organizationId),
      eq(governedWorkItemExecutions.userId, input.userId),
      eq(governedWorkItemExecutions.adoptId, input.adoptId),
      eq(governedWorkItemExecutions.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (existing) {
      if (existing.workItemId !== input.workItemId || existing.payloadHash !== input.payloadHash) {
        throw new Error("IDEMPOTENCY_CONFLICT");
      }
      const [item] = await tx.select().from(governedWorkItems).where(and(
        eq(governedWorkItems.workItemId, input.workItemId),
        eq(governedWorkItems.organizationId, input.organizationId),
        eq(governedWorkItems.userId, input.userId),
        eq(governedWorkItems.adoptId, input.adoptId),
      )).limit(1);
      if (!item) throw new Error("WORK_ITEM_NOT_FOUND");
      return { item, execution: existing, reused: true };
    }

    const [current] = await tx.select().from(governedWorkItems).where(and(
      eq(governedWorkItems.workItemId, input.workItemId),
      eq(governedWorkItems.organizationId, input.organizationId),
      eq(governedWorkItems.userId, input.userId),
      eq(governedWorkItems.adoptId, input.adoptId),
    )).limit(1);
    if (!current) throw new Error("WORK_ITEM_NOT_FOUND");
    if (!input.expectedStatuses.includes(current.status)) throw new Error("INVALID_WORK_ITEM_TRANSITION");

    const result = await tx.update(governedWorkItems).set({
      ...input.patch,
      status: input.toStatus,
      confirmedBy: current.confirmedBy || input.confirmedBy,
      confirmedAt: current.confirmedAt || input.confirmedAt,
      version: current.version + 1,
    }).where(and(
      eq(governedWorkItems.id, current.id),
      eq(governedWorkItems.status, current.status),
      eq(governedWorkItems.version, current.version),
    ));
    if (affectedRows(result) !== 1) throw new Error("WORK_ITEM_TRANSITION_CONFLICT");

    await tx.insert(governedWorkItemExecutions).values({
      executionReceiptId: input.executionReceiptId,
      workItemId: input.workItemId,
      organizationId: input.organizationId,
      userId: input.userId,
      adoptId: input.adoptId,
      capabilityId: "grace.work_item",
      capabilityVersion: "1",
      operation: input.operation,
      fromStatus: current.status,
      toStatus: input.toStatus,
      status: "completed",
      requestedBy: input.requestedBy,
      confirmedBy: input.confirmedBy,
      confirmedAt: input.confirmedAt,
      approvalId: input.approvalId || null,
      idempotencyKey: input.idempotencyKey,
      payloadHash: input.payloadHash,
      contextReceiptFingerprint: input.contextReceiptFingerprint || null,
      resultFingerprint: input.resultFingerprint,
      completedAt: new Date(),
    });
    const [item] = await tx.select().from(governedWorkItems).where(eq(governedWorkItems.id, current.id)).limit(1);
    const [execution] = await tx.select().from(governedWorkItemExecutions)
      .where(eq(governedWorkItemExecutions.executionReceiptId, input.executionReceiptId)).limit(1);
    if (!item || !execution) throw new Error("WORK_ITEM_TRANSITION_NOT_PERSISTED");
    return { item, execution, reused: false };
  });
}
