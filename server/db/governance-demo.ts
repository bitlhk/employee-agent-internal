import { and, eq } from "drizzle-orm";
import {
  governanceDemoBusinessRecords,
  type GovernanceDemoBusinessRecord,
  type InsertGovernanceDemoBusinessRecord,
} from "../../drizzle/schema";
import { getDb } from "./connection";

function sameBusinessRequest(
  existing: GovernanceDemoBusinessRecord,
  input: Omit<InsertGovernanceDemoBusinessRecord, "id" | "createdAt" | "updatedAt">,
): boolean {
  return existing.customerRef === input.customerRef
    && existing.status === input.status
    && JSON.stringify(existing.payloadJson) === JSON.stringify(input.payloadJson);
}

function idempotentResult(
  existing: GovernanceDemoBusinessRecord,
  input: Omit<InsertGovernanceDemoBusinessRecord, "id" | "createdAt" | "updatedAt">,
): { created: false; record: GovernanceDemoBusinessRecord } {
  if (!sameBusinessRequest(existing, input)) {
    throw new Error("IDEMPOTENCY_CONFLICT: 同一幂等键不能用于不同的 Demo 业务参数");
  }
  return { created: false, record: existing };
}

export async function createGovernanceDemoBusinessRecord(
  input: Omit<InsertGovernanceDemoBusinessRecord, "id" | "createdAt" | "updatedAt">,
): Promise<{ created: boolean; record: GovernanceDemoBusinessRecord }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  try {
    await db.insert(governanceDemoBusinessRecords).values(input);
  } catch (error) {
    const errorCode = error && typeof error === "object"
      ? String("code" in error ? error.code : "cause" in error && error.cause && typeof error.cause === "object" && "code" in error.cause ? error.cause.code : "")
      : "";
    if (errorCode !== "ER_DUP_ENTRY") throw error;
    const existing = await db.select().from(governanceDemoBusinessRecords)
      .where(and(
        eq(governanceDemoBusinessRecords.tenantId, input.tenantId),
        eq(governanceDemoBusinessRecords.requestId, input.requestId),
      )).limit(1);
    if (existing[0]) return idempotentResult(existing[0], input);
    const byIdempotency = await db.select().from(governanceDemoBusinessRecords)
      .where(and(
        eq(governanceDemoBusinessRecords.tenantId, input.tenantId),
        eq(governanceDemoBusinessRecords.toolName, input.toolName),
        eq(governanceDemoBusinessRecords.idempotencyKey, input.idempotencyKey),
      )).limit(1);
    if (byIdempotency[0]) return idempotentResult(byIdempotency[0], input);
    throw error;
  }
  const rows = await db.select().from(governanceDemoBusinessRecords)
    .where(and(
      eq(governanceDemoBusinessRecords.tenantId, input.tenantId),
      eq(governanceDemoBusinessRecords.requestId, input.requestId),
    )).limit(1);
  if (!rows[0]) throw new Error("Demo business record was not created");
  return { created: true, record: rows[0] };
}

export async function getGovernanceDemoBusinessRecord(recordId: string): Promise<GovernanceDemoBusinessRecord | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(governanceDemoBusinessRecords)
    .where(eq(governanceDemoBusinessRecords.recordId, recordId)).limit(1);
  return rows[0] || null;
}
