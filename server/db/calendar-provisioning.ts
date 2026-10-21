import { eq } from "drizzle-orm";
import { calendarProvisioning } from "../../drizzle/schema";
import { getDb } from "./connection";

export async function getCalendarProvisioning(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [row] = await db
    .select()
    .from(calendarProvisioning)
    .where(eq(calendarProvisioning.userId, userId));
  return row ?? null;
}
export async function saveCalendarProvisioning(
  input: typeof calendarProvisioning.$inferInsert
) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db
    .insert(calendarProvisioning)
    .values(input)
    .onDuplicateKeyUpdate({ set: { userId: input.userId } });
  return (await getCalendarProvisioning(input.userId))!;
}
export async function setCalendarProvisioningStatus(
  userId: number,
  status: "creating" | "ready" | "failed"
) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db
    .update(calendarProvisioning)
    .set({ status })
    .where(eq(calendarProvisioning.userId, userId));
}
