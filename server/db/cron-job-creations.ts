import { and, eq, sql } from "drizzle-orm";
import {
  cronJobCreations,
  type CronJobCreation,
  type InsertCronJobCreation,
} from "../../drizzle/schema";
import { getDb } from "./connection";

function isDuplicateKeyError(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code || "");
  const errno = Number((error as { errno?: unknown })?.errno || 0);
  return code === "ER_DUP_ENTRY" || errno === 1062;
}

export async function getCronJobCreation(
  adoptId: string,
  idempotencyKey: string,
): Promise<CronJobCreation | undefined> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const rows = await db
    .select()
    .from(cronJobCreations)
    .where(and(
      eq(cronJobCreations.adoptId, adoptId),
      eq(cronJobCreations.idempotencyKey, idempotencyKey),
    ))
    .limit(1);
  return rows[0];
}

export async function reserveCronJobCreation(
  data: Pick<InsertCronJobCreation, "adoptId" | "idempotencyKey" | "requestHash">,
): Promise<{ kind: "created" } | { kind: "existing"; record: CronJobCreation }> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const existing = await getCronJobCreation(data.adoptId, data.idempotencyKey);
  if (existing) return { kind: "existing", record: existing };

  try {
    await db.insert(cronJobCreations).values({
      ...data,
      status: "pending",
    });
    return { kind: "created" };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const winner = await getCronJobCreation(data.adoptId, data.idempotencyKey);
    if (!winner) throw error;
    return { kind: "existing", record: winner };
  }
}

export async function completeCronJobCreation(args: {
  adoptId: string;
  idempotencyKey: string;
  jobId: string;
  jobJson: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(cronJobCreations).set({
    status: "succeeded",
    jobId: args.jobId,
    jobJson: args.jobJson,
    errorMessage: null,
  }).where(and(
    eq(cronJobCreations.adoptId, args.adoptId),
    eq(cronJobCreations.idempotencyKey, args.idempotencyKey),
    eq(cronJobCreations.status, "pending"),
  ));
}

export async function failCronJobCreation(args: {
  adoptId: string;
  idempotencyKey: string;
  errorMessage: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(cronJobCreations).set({
    status: "failed",
    errorMessage: args.errorMessage.slice(0, 2000),
  }).where(and(
    eq(cronJobCreations.adoptId, args.adoptId),
    eq(cronJobCreations.idempotencyKey, args.idempotencyKey),
    eq(cronJobCreations.status, "pending"),
  ));
}

export async function withCronCreationScopeLock<T>(
  adoptId: string,
  work: () => Promise<T>,
): Promise<T> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db.transaction(async (tx) => {
    // Serializes quota check + remote creation for distinct requests of one agent.
    await tx.execute(sql`SELECT id FROM claw_adoptions WHERE adoptId = ${adoptId} FOR UPDATE`);
    return work();
  });
}
