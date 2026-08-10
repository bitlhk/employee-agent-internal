import { and, eq } from "drizzle-orm";
import {
  customMcpCallReceipts,
  type CustomMcpCallReceipt,
} from "../../drizzle/schema";
import { getDb } from "./connection";

function isDuplicateEntry(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    if ("code" in current && String((current as { code?: unknown }).code) === "ER_DUP_ENTRY") return true;
    current = "cause" in current ? (current as { cause?: unknown }).cause : null;
  }
  return false;
}

export async function reserveCustomMcpCall(input: {
  requestId: string;
  policyDecisionId: string;
  approvalId?: string | null;
  idempotencyKey: string;
  connectionId: number;
  toolName: string;
  userId: number;
  adoptId: string;
  argsHash: string;
}): Promise<{ reserved: boolean; conflict: boolean; receipt: CustomMcpCallReceipt }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  try {
    await db.insert(customMcpCallReceipts).values(input);
  } catch (error) {
    if (!isDuplicateEntry(error)) throw error;
    const rows = await db.select().from(customMcpCallReceipts).where(and(
      eq(customMcpCallReceipts.adoptId, input.adoptId),
      eq(customMcpCallReceipts.connectionId, input.connectionId),
      eq(customMcpCallReceipts.toolName, input.toolName),
      eq(customMcpCallReceipts.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    const receipt = rows[0];
    if (!receipt) throw error;
    return { reserved: false, conflict: receipt.argsHash !== input.argsHash, receipt };
  }
  const rows = await db.select().from(customMcpCallReceipts)
    .where(eq(customMcpCallReceipts.requestId, input.requestId)).limit(1);
  if (!rows[0]) throw new Error("Custom MCP call receipt was not created");
  return { reserved: true, conflict: false, receipt: rows[0] };
}

export async function getCustomMcpCallReceiptByApprovalId(approvalId: string): Promise<CustomMcpCallReceipt | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(customMcpCallReceipts)
    .where(eq(customMcpCallReceipts.approvalId, approvalId)).limit(1);
  return rows[0] || null;
}

export async function completeCustomMcpCall(input: {
  requestId: string;
  status: "completed" | "failed" | "blocked";
  resultHash?: string | null;
  externalRequestId?: string | null;
  durationMs?: number | null;
  errorCode?: string | null;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(customMcpCallReceipts).set({
    status: input.status,
    resultHash: input.resultHash || null,
    externalRequestId: input.externalRequestId || null,
    durationMs: input.durationMs ?? null,
    errorCode: input.errorCode || null,
    completedAt: new Date(),
  }).where(and(
    eq(customMcpCallReceipts.requestId, input.requestId),
    eq(customMcpCallReceipts.status, "started"),
  ));
}
