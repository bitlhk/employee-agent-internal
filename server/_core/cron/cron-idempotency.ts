import { createHash } from "crypto";
import type { CronJob, CronJobInput } from "@shared/types/cron";
import {
  completeCronJobCreation,
  failCronJobCreation,
  getCronJobCreation,
  reserveCronJobCreation,
} from "../../db/cron-job-creations";

type StoredCreation = Awaited<ReturnType<typeof getCronJobCreation>>;

export class CronCreationConflictError extends Error {
  readonly status = 409;

  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "CronCreationConflictError";
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

export function cronCreationRequestHash(input: CronJobInput): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(input)))
    .digest("hex");
}

export function normalizeCronIdempotencyKey(value: unknown): string {
  const key = String(value || "").trim();
  if (!key) return "";
  if (/^[A-Za-z0-9._:-]{1,191}$/.test(key)) return key;
  return `sha256:${createHash("sha256").update(key).digest("hex")}`;
}

function jobFromStored(record: NonNullable<StoredCreation>): CronJob {
  if (!record.jobJson) {
    throw new CronCreationConflictError(
      "定时任务创建记录不完整，请使用新的请求重试",
      "CRON_CREATION_RESULT_MISSING",
    );
  }
  try {
    return JSON.parse(record.jobJson) as CronJob;
  } catch {
    throw new CronCreationConflictError(
      "定时任务创建记录无法读取，请使用新的请求重试",
      "CRON_CREATION_RESULT_INVALID",
    );
  }
}

function resultFromStored(
  record: NonNullable<StoredCreation>,
  requestHash: string,
): { job: CronJob; reused: true } | null {
  if (record.requestHash !== requestHash) {
    throw new CronCreationConflictError(
      "同一幂等键不能用于不同的定时任务请求",
      "CRON_IDEMPOTENCY_CONFLICT",
    );
  }
  if (record.status === "succeeded") {
    return { job: jobFromStored(record), reused: true };
  }
  if (record.status === "failed") {
    throw new CronCreationConflictError(
      record.errorMessage || "此前的同一定时任务创建请求已失败",
      "CRON_CREATION_PREVIOUSLY_FAILED",
    );
  }
  return null;
}

async function waitForStoredResult(
  adoptId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<{ job: CronJob; reused: true }> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const record = await getCronJobCreation(adoptId, idempotencyKey);
    if (!record) break;
    const result = resultFromStored(record, requestHash);
    if (result) return result;
  }
  throw new CronCreationConflictError(
    "相同的定时任务请求正在处理中，请稍后再试",
    "CRON_CREATION_IN_PROGRESS",
  );
}

export async function createCronJobIdempotently(args: {
  adoptId: string;
  idempotencyKey: string;
  input: CronJobInput;
  create: () => Promise<CronJob>;
}): Promise<{ job: CronJob; reused: boolean }> {
  const idempotencyKey = normalizeCronIdempotencyKey(args.idempotencyKey);
  if (!idempotencyKey) return { job: await args.create(), reused: false };

  const requestHash = cronCreationRequestHash(args.input);
  const reservation = await reserveCronJobCreation({
    adoptId: args.adoptId,
    idempotencyKey,
    requestHash,
  });
  if (reservation.kind === "existing") {
    const result = resultFromStored(reservation.record, requestHash);
    if (result) return result;
    return waitForStoredResult(args.adoptId, idempotencyKey, requestHash);
  }

  try {
    const job = await args.create();
    await completeCronJobCreation({
      adoptId: args.adoptId,
      idempotencyKey,
      jobId: String(job.id || ""),
      jobJson: JSON.stringify(job),
    });
    return { job, reused: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failCronJobCreation({
      adoptId: args.adoptId,
      idempotencyKey,
      errorMessage: message,
    }).catch(() => undefined);
    throw error;
  }
}
