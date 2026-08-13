import { and, eq, inArray } from "drizzle-orm";
import {
  a2aCapabilityIntentExecutions,
  type A2ACapabilityIntentExecution,
  type InsertA2ACapabilityIntentExecution,
} from "../../drizzle/schema";
import { getDb } from "./connection";

function duplicateKey(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code || (error as { cause?: { code?: unknown } })?.cause?.code || "");
  return code === "ER_DUP_ENTRY";
}

export async function getA2ACapabilityIntentExecution(
  taskId: string,
  intentId: string,
): Promise<A2ACapabilityIntentExecution | null> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db.select().from(a2aCapabilityIntentExecutions).where(and(
    eq(a2aCapabilityIntentExecutions.taskId, taskId),
    eq(a2aCapabilityIntentExecutions.intentId, intentId),
  )).limit(1);
  return rows[0] || null;
}

export async function listA2ACapabilityIntentExecutions(
  taskId: string,
  adoptId: string,
): Promise<A2ACapabilityIntentExecution[]> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return await db.select().from(a2aCapabilityIntentExecutions).where(and(
    eq(a2aCapabilityIntentExecutions.taskId, taskId),
    eq(a2aCapabilityIntentExecutions.adoptId, adoptId),
  ));
}

export async function reserveA2ACapabilityIntentExecution(
  input: Omit<InsertA2ACapabilityIntentExecution, "id" | "status" | "approvalId" | "resultHash" | "externalRequestId" | "errorCode" | "errorMessage" | "completedAt" | "createdAt" | "updatedAt">,
): Promise<{ created: boolean; execution: A2ACapabilityIntentExecution }> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  try {
    await db.insert(a2aCapabilityIntentExecutions).values({ ...input, status: "pending" });
  } catch (error) {
    if (!duplicateKey(error)) throw error;
  }
  const execution = await getA2ACapabilityIntentExecution(input.taskId, input.intentId);
  if (!execution) throw new Error("A2A capability intent execution was not reserved");
  if (execution.intentFingerprint !== input.intentFingerprint || execution.payloadHash !== input.payloadHash) {
    throw new Error("A2A_INTENT_BINDING_CONFLICT");
  }
  return { created: execution.executionId === input.executionId, execution };
}

export async function claimA2ACapabilityIntentExecution(input: {
  taskId: string;
  intentId: string;
  approvalId?: string | null;
}): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const statuses: Array<"pending" | "approval_required"> = input.approvalId
    ? ["pending", "approval_required"]
    : ["pending"];
  const result = await db.update(a2aCapabilityIntentExecutions).set({
    status: "executing",
    ...(input.approvalId ? { approvalId: input.approvalId } : {}),
    errorCode: null,
    errorMessage: null,
  }).where(and(
    eq(a2aCapabilityIntentExecutions.taskId, input.taskId),
    eq(a2aCapabilityIntentExecutions.intentId, input.intentId),
    inArray(a2aCapabilityIntentExecutions.status, statuses),
    ...(input.approvalId
      ? [eq(a2aCapabilityIntentExecutions.approvalId, input.approvalId)]
      : []),
  ));
  return Number((result as unknown as Array<{ affectedRows?: number }>)?.[0]?.affectedRows || 0) === 1;
}

export async function completeA2ACapabilityIntentExecution(input: {
  taskId: string;
  intentId: string;
  status: "approval_required" | "succeeded" | "failed" | "blocked";
  approvalId?: string | null;
  resultHash?: string | null;
  externalRequestId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}): Promise<A2ACapabilityIntentExecution | null> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(a2aCapabilityIntentExecutions).set({
    status: input.status,
    approvalId: input.approvalId || null,
    resultHash: input.resultHash || null,
    externalRequestId: input.externalRequestId || null,
    errorCode: input.errorCode || null,
    errorMessage: input.errorMessage?.slice(0, 2_000) || null,
    completedAt: input.status === "approval_required" ? null : new Date(),
  }).where(and(
    eq(a2aCapabilityIntentExecutions.taskId, input.taskId),
    eq(a2aCapabilityIntentExecutions.intentId, input.intentId),
    eq(a2aCapabilityIntentExecutions.status, "executing"),
  ));
  return await getA2ACapabilityIntentExecution(input.taskId, input.intentId);
}
