import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import { calendarCascades, type CalendarCascade } from "../../drizzle/schema";
import { getDb } from "./connection";
async function database() {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db;
}
export async function getCascade(userId: number, id: string) {
  const [row] = await (
    await database()
  )
    .select()
    .from(calendarCascades)
    .where(
      and(eq(calendarCascades.userId, userId), eq(calendarCascades.id, id))
    )
    .limit(1);
  return row || null;
}
export async function listCascades(userId: number) {
  return (await database())
    .select()
    .from(calendarCascades)
    .where(eq(calendarCascades.userId, userId))
    .orderBy(calendarCascades.createdAt)
    .limit(50);
}
export async function insertCascade(
  input: typeof calendarCascades.$inferInsert
) {
  const db = await database();
  await db
    .insert(calendarCascades)
    .values(input)
    .onDuplicateKeyUpdate({ set: { requestKey: input.requestKey } });
  const [row] = await db
    .select()
    .from(calendarCascades)
    .where(
      and(
        eq(calendarCascades.userId, input.userId),
        eq(calendarCascades.requestKey, input.requestKey)
      )
    )
    .limit(1);
  return row;
}
export async function claimCascade(
  userId: number,
  id: string,
  preparing = false
) {
  const token = randomUUID();
  const db = await database();
  const [result] = await db
    .update(calendarCascades)
    .set({ leaseToken: token, leaseUntil: new Date(Date.now() + 5 * 60_000) })
    .where(
      and(
        eq(calendarCascades.id, id),
        eq(calendarCascades.userId, userId),
        inArray(
          calendarCascades.status,
          preparing
            ? ["drafting"]
            : ["confirmed", "running", "waiting", "compensating"]
        ),
        or(
          isNull(calendarCascades.leaseUntil),
          lt(calendarCascades.leaseUntil, new Date())
        )
      )
    );
  return result.affectedRows
    ? { token, plan: (await getCascade(userId, id))! }
    : null;
}
export async function updateCascade(
  userId: number,
  id: string,
  token: string,
  patch: Partial<
    Pick<CalendarCascade, "steps" | "status" | "planHash" | "errorCode">
  >,
  release = false
) {
  const [result] = await (
    await database()
  )
    .update(calendarCascades)
    .set({
      ...patch,
      leaseToken: release ? null : token,
      leaseUntil: release ? null : new Date(Date.now() + 5 * 60_000),
    })
    .where(
      and(
        eq(calendarCascades.id, id),
        eq(calendarCascades.userId, userId),
        eq(calendarCascades.leaseToken, token),
        gt(calendarCascades.leaseUntil, new Date())
      )
    );
  if (!result.affectedRows) throw new Error("级联方案执行租约已失效");
}
export async function confirmCascadeRecord(
  userId: number,
  id: string,
  planHash: string,
  compensate = false
) {
  const [result] = await (
    await database()
  )
    .update(calendarCascades)
    .set(
      compensate
        ? {
            status: "compensating",
            compensationConfirmedAt: new Date(),
            stopRequested: false,
          }
        : { status: "confirmed", confirmedAt: new Date() }
    )
    .where(
      and(
        eq(calendarCascades.id, id),
        eq(calendarCascades.userId, userId),
        eq(calendarCascades.planHash, planHash),
        inArray(
          calendarCascades.status,
          compensate ? ["partial", "completed"] : ["pending"]
        ),
        compensate ? undefined : gt(calendarCascades.expiresAt, new Date()),
        or(
          isNull(calendarCascades.leaseUntil),
          lt(calendarCascades.leaseUntil, new Date())
        )
      )
    );
  return result.affectedRows === 1;
}
export async function stopCascadeRecord(userId: number, id: string) {
  const [result] = await (
    await database()
  )
    .update(calendarCascades)
    .set({ stopRequested: true })
    .where(
      and(
        eq(calendarCascades.id, id),
        eq(calendarCascades.userId, userId),
        inArray(calendarCascades.status, [
          "drafting",
          "pending",
          "confirmed",
          "running",
          "waiting",
        ])
      )
    );
  return result.affectedRows === 1;
}
export async function cancelUnconfirmedCascade(userId: number, id: string) {
  await (
    await database()
  )
    .update(calendarCascades)
    .set({ status: "cancelled", leaseToken: null, leaseUntil: null })
    .where(
      and(
        eq(calendarCascades.id, id),
        eq(calendarCascades.userId, userId),
        eq(calendarCascades.stopRequested, true),
        inArray(calendarCascades.status, ["drafting", "pending"]),
        or(
          isNull(calendarCascades.leaseUntil),
          lt(calendarCascades.leaseUntil, new Date())
        )
      )
    );
}
export async function validateCascadeExecution(
  userId: number,
  draftId: string,
  cascadeId: string,
  token: string
) {
  const plan = await getCascade(userId, cascadeId);
  if (
    !plan ||
    !["running", "compensating"].includes(plan.status) ||
    !plan.confirmedAt ||
    plan.leaseToken !== token ||
    !plan.leaseUntil ||
    plan.leaseUntil.getTime() <= Date.now() ||
    !plan.steps.some(
      step =>
        (plan.status === "compensating"
          ? step.compensationDraftId
          : step.draftId) === draftId
    ) ||
    (plan.status === "compensating" && !plan.compensationConfirmedAt)
  )
    throw new Error("级联步骤尚未获得本人确认或执行租约已失效");
}
