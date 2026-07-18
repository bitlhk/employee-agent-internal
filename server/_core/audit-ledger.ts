import { randomBytes } from "crypto";
import { appendFile, mkdir, open, readdir, readFile, rename, stat, statfs, unlink, writeFile } from "fs/promises";
import path from "path";
import { getDb } from "../db";
import { auditEvents } from "../../drizzle/schema";

const METADATA_MAX_BYTES = 16 * 1024;
const DEFAULT_APP_ROOT = process.env.APP_ROOT || process.cwd();
const DEFAULT_DLQ_DIR = path.join(DEFAULT_APP_ROOT, "data", "audit-dlq");
const DLQ_STATE_FILE = ".drain-state.json";
const DLQ_LOCK_FILE = ".drain.lock";

const SECRET_KEY_RE = /password|token|secret|apiKey|cookie|authorization|credential|privateKey|gatewayToken|botToken/i;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g;
const NATIONAL_ID_RE = /(?<!\d)\d{6}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g;
const BANK_CARD_RE = /(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)/g;

export const FAIL_CLOSE_AUDIT_ACTIONS = new Set([
  "audit.export.requested",
  "audit.export.completed",
  "audit.export.failed",
  "audit.export.downloaded",
  "admin.user.role_changed",
  "admin.user.access_changed",
  "admin.user.access_changed.requested",
  "admin.user.access_changed.completed",
  "admin.user.password_reset",
  "admin.user.password_reset.requested",
  "admin.user.password_reset.completed",
  "tenant.created",
  "tenant.deleted",
  "file.downloaded",
  "skill.market.approved",
  "skill.market.approved.requested",
  "skill.market.approved.completed",
  "config.security_critical_changed",
]);

export type AuditRecordMode = "sync" | "async" | "auto";
export type AuditRecordResultStatus = "persisted" | "dlq" | "queued" | "failed";

export type AuditEventResult = "success" | "failed" | "denied" | "warning";
export type AuditEventSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface AuditEventInput {
  eventId?: string;
  eventTime?: Date | string;
  category?: string;
  action: string;
  result?: AuditEventResult;
  severity?: AuditEventSeverity;
  actorType?: string;
  actorUserId?: number | null;
  actorName?: string | null;
  actorEmail?: string | null;
  actorRole?: string | null;
  actorOrgId?: string | null;
  actorDepartmentId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  targetName?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  resourceName?: string | null;
  workspaceId?: string | null;
  agentInstanceId?: string | null;
  runtimeType?: string | null;
  runtimeAgentId?: string | null;
  requestId?: string | null;
  sessionId?: string | null;
  correlationId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  source?: string;
  environment?: string | null;
  detailType?: string | null;
  detailId?: string | null;
  errorCode?: string | null;
  policyCode?: string | null;
  riskType?: string | null;
  channel?: string | null;
  toolName?: string | null;
  metadata?: unknown;
  mode?: AuditRecordMode;
}

export interface NormalizedAuditEvent {
  eventId: string;
  eventTime: Date;
  category: string;
  action: string;
  result: AuditEventResult;
  severity: AuditEventSeverity;
  actorType: string;
  actorUserId?: number | null;
  actorName?: string | null;
  actorEmail?: string | null;
  actorRole?: string | null;
  actorOrgId?: string | null;
  actorDepartmentId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  targetName?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  resourceName?: string | null;
  workspaceId?: string | null;
  agentInstanceId?: string | null;
  runtimeType?: string | null;
  runtimeAgentId?: string | null;
  requestId?: string | null;
  sessionId?: string | null;
  correlationId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  source: string;
  environment?: string | null;
  detailType?: string | null;
  detailId?: string | null;
  errorCode?: string | null;
  policyCode?: string | null;
  riskType?: string | null;
  channel?: string | null;
  toolName?: string | null;
  metadataJson: Record<string, unknown> | null;
  metadataTruncated: boolean;
  metadataOriginalBytes?: number | null;
}

export interface AuditRecordResult {
  eventId: string;
  status: AuditRecordResultStatus;
  persisted: boolean;
  dlqWritten: boolean;
  failClose: boolean;
  metadataTruncated: boolean;
  metadataOriginalBytes?: number | null;
  error?: string;
}

export interface AuditDlqStats {
  dir: string;
  exists: boolean;
  fileCount: number;
  eventCount: number;
  bytes: number;
  diskAvailableBytes?: number;
  diskTotalBytes?: number;
  newestFileMtime?: Date;
  lastWriteFailure?: string;
  lastDrainTime?: Date;
}

export interface AuditDlqDrainResult {
  locked: boolean;
  scanned: number;
  persisted: number;
  duplicates: number;
  failed: number;
  invalid: number;
  remaining: number;
  completedAt: string;
}

export interface AuditLedgerOptions {
  dlqDir?: string;
  insertAuditEvent?: (event: NormalizedAuditEvent) => Promise<void>;
  now?: () => Date;
  idFactory?: () => string;
}

export class AuditRecordError extends Error {
  constructor(
    message: string,
    readonly eventId: string,
    readonly causeError?: unknown,
  ) {
    super(message);
    this.name = "AuditRecordError";
  }
}

export function createAuditLedger(options: AuditLedgerOptions = {}) {
  const dlqDir = options.dlqDir || DEFAULT_DLQ_DIR;
  const insertAuditEvent = options.insertAuditEvent || insertAuditEventToDb;
  const now = options.now || (() => new Date());
  const idFactory = options.idFactory || createAuditEventId;

  async function persistWithDlq(event: NormalizedAuditEvent, failClose: boolean): Promise<AuditRecordResult> {
    try {
      await insertAuditEvent(event);
      return {
        eventId: event.eventId,
        status: "persisted",
        persisted: true,
        dlqWritten: false,
        failClose,
        metadataTruncated: event.metadataTruncated,
        metadataOriginalBytes: event.metadataOriginalBytes,
      };
    } catch (persistError) {
      try {
        await writeAuditDlq(event, persistError, dlqDir);
        return {
          eventId: event.eventId,
          status: "dlq",
          persisted: false,
          dlqWritten: true,
          failClose,
          metadataTruncated: event.metadataTruncated,
          metadataOriginalBytes: event.metadataOriginalBytes,
          error: errorMessage(persistError),
        };
      } catch (dlqError) {
        if (failClose) {
          throw new AuditRecordError(
            `fail-close audit event ${event.action} could not be persisted or written to DLQ`,
            event.eventId,
            { persistError, dlqError },
          );
        }
        return {
          eventId: event.eventId,
          status: "failed",
          persisted: false,
          dlqWritten: false,
          failClose,
          metadataTruncated: event.metadataTruncated,
          metadataOriginalBytes: event.metadataOriginalBytes,
          error: `${errorMessage(persistError)}; dlq: ${errorMessage(dlqError)}`,
        };
      }
    }
  }

  async function recordAuditEvent(input: AuditEventInput): Promise<AuditRecordResult> {
    const event = normalizeAuditEvent(input, now, idFactory);
    const failClose = FAIL_CLOSE_AUDIT_ACTIONS.has(event.action);
    const mode = input.mode || "auto";

    if (mode === "async" && !failClose) {
      persistWithDlq(event, false).catch((err) => {
        console.error("[AUDIT] async audit event failed:", err);
      });
      return {
        eventId: event.eventId,
        status: "queued",
        persisted: false,
        dlqWritten: false,
        failClose: false,
        metadataTruncated: event.metadataTruncated,
        metadataOriginalBytes: event.metadataOriginalBytes,
      };
    }

    return persistWithDlq(event, failClose);
  }

  return {
    dlqDir,
    recordAuditEvent,
    getDlqStats: () => getAuditDlqStats(dlqDir),
  };
}

export function conformAuditEventToSchema(event: NormalizedAuditEvent): NormalizedAuditEvent {
  const limited = <T extends string | null | undefined>(value: T, max: number): T => (
    typeof value === "string" && value.length > max ? value.slice(0, max) as T : value
  );
  return {
    ...event,
    eventId: limited(event.eventId, 64),
    category: limited(event.category, 64),
    action: limited(event.action, 128),
    actorType: limited(event.actorType, 32),
    actorName: limited(event.actorName, 128),
    actorEmail: limited(event.actorEmail, 320),
    actorRole: limited(event.actorRole, 64),
    actorOrgId: limited(event.actorOrgId, 64),
    actorDepartmentId: limited(event.actorDepartmentId, 64),
    targetType: limited(event.targetType, 64),
    targetId: limited(event.targetId, 128),
    targetName: limited(event.targetName, 256),
    resourceType: limited(event.resourceType, 64),
    resourceId: limited(event.resourceId, 128),
    resourceName: limited(event.resourceName, 256),
    workspaceId: limited(event.workspaceId, 128),
    agentInstanceId: limited(event.agentInstanceId, 128),
    runtimeType: limited(event.runtimeType, 64),
    runtimeAgentId: limited(event.runtimeAgentId, 128),
    requestId: limited(event.requestId, 128),
    sessionId: limited(event.sessionId, 128),
    correlationId: limited(event.correlationId, 128),
    ip: limited(event.ip, 45),
    source: limited(event.source, 64),
    environment: limited(event.environment, 64),
    detailType: limited(event.detailType, 64),
    detailId: limited(event.detailId, 128),
    errorCode: limited(event.errorCode, 64),
    policyCode: limited(event.policyCode, 64),
    riskType: limited(event.riskType, 64),
    channel: limited(event.channel, 64),
    toolName: limited(event.toolName, 128),
  };
}

export const auditLedger = createAuditLedger();
export const recordAuditEvent = auditLedger.recordAuditEvent;

export function normalizeAuditEvent(
  input: AuditEventInput,
  now: () => Date = () => new Date(),
  idFactory: () => string = createAuditEventId,
): NormalizedAuditEvent {
  if (!input.action || typeof input.action !== "string") {
    throw new Error("audit action is required");
  }

  const metadata = normalizeMetadata(input.metadata);
  return conformAuditEventToSchema({
    eventId: input.eventId || idFactory(),
    eventTime: input.eventTime ? new Date(input.eventTime) : now(),
    category: input.category || categoryFromAction(input.action),
    action: input.action,
    result: input.result || "success",
    severity: input.severity || "info",
    actorType: input.actorType || "user",
    actorUserId: input.actorUserId,
    actorName: input.actorName,
    actorEmail: input.actorEmail,
    actorRole: input.actorRole,
    actorOrgId: input.actorOrgId,
    actorDepartmentId: input.actorDepartmentId,
    targetType: input.targetType,
    targetId: input.targetId,
    targetName: input.targetName,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    resourceName: input.resourceName,
    workspaceId: input.workspaceId,
    agentInstanceId: input.agentInstanceId,
    runtimeType: input.runtimeType,
    runtimeAgentId: input.runtimeAgentId,
    requestId: input.requestId,
    sessionId: input.sessionId,
    correlationId: input.correlationId,
    ip: input.ip,
    userAgent: input.userAgent,
    source: input.source || "platform",
    environment: input.environment || process.env.NODE_ENV || null,
    detailType: input.detailType,
    detailId: input.detailId,
    errorCode: input.errorCode,
    policyCode: input.policyCode,
    riskType: input.riskType,
    channel: input.channel,
    toolName: input.toolName,
    metadataJson: metadata.value,
    metadataTruncated: metadata.truncated,
    metadataOriginalBytes: metadata.originalBytes,
  });
}

export function redactAuditMetadata(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}

export async function getAuditDlqStats(dir = DEFAULT_DLQ_DIR): Promise<AuditDlqStats> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    let bytes = 0;
    let eventCount = 0;
    let newestFileMtime: Date | undefined;
    let lastWriteFailure: string | undefined;
    let lastDrainTime: Date | undefined;

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = path.join(dir, entry.name);
      const s = await stat(filePath);
      bytes += s.size;
      if (!newestFileMtime || s.mtime > newestFileMtime) newestFileMtime = s.mtime;
      const content = await readFile(filePath, "utf8");
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        eventCount += 1;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.type === "audit.dlq.write_failure") lastWriteFailure = parsed.error || "unknown";
        } catch {
          lastWriteFailure = "dlq contains invalid jsonl";
        }
      }
    }

    try {
      const state = JSON.parse(await readFile(path.join(dir, DLQ_STATE_FILE), "utf8"));
      if (state?.completedAt) lastDrainTime = new Date(state.completedAt);
    } catch {}

    const disk = await getDiskStats(dir);
    return {
      dir,
      exists: true,
      fileCount: entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).length,
      eventCount,
      bytes,
      diskAvailableBytes: disk?.availableBytes,
      diskTotalBytes: disk?.totalBytes,
      newestFileMtime,
      lastWriteFailure,
      lastDrainTime,
    };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { dir, exists: false, fileCount: 0, eventCount: 0, bytes: 0 };
    }
    throw err;
  }
}

export async function drainAuditDlq(options: {
  dir?: string;
  maxEvents?: number;
  insertAuditEvent?: (event: NormalizedAuditEvent) => Promise<void>;
} = {}): Promise<AuditDlqDrainResult> {
  const dir = options.dir || DEFAULT_DLQ_DIR;
  const maxEvents = Math.max(1, Math.min(10_000, Math.floor(options.maxEvents || 1000)));
  const insertAuditEvent = options.insertAuditEvent || insertAuditEventToDb;
  const completedAt = () => new Date().toISOString();
  await mkdir(dir, { recursive: true });

  let lock: Awaited<ReturnType<typeof open>> | null = null;
  try {
    lock = await open(path.join(dir, DLQ_LOCK_FILE), "wx", 0o600);
  } catch (error: any) {
    if (error?.code === "EEXIST") {
      return { locked: true, scanned: 0, persisted: 0, duplicates: 0, failed: 0, invalid: 0, remaining: 0, completedAt: completedAt() };
    }
    throw error;
  }

  const result: AuditDlqDrainResult = {
    locked: false,
    scanned: 0,
    persisted: 0,
    duplicates: 0,
    failed: 0,
    invalid: 0,
    remaining: 0,
    completedAt: "",
  };

  try {
    const entries = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name)
      .sort();

    for (const name of entries) {
      const source = path.join(dir, name);
      const processing = path.join(dir, `.${name}.${process.pid}.${Date.now()}.processing`);
      try {
        await rename(source, processing);
      } catch (error: any) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }

      const retained: string[] = [];
      try {
        const lines = (await readFile(processing, "utf8")).split(/\r?\n/).filter((line) => line.trim());
        for (const line of lines) {
          if (result.scanned >= maxEvents) {
            retained.push(line);
            result.remaining += 1;
            continue;
          }

          result.scanned += 1;
          let event: NormalizedAuditEvent;
          try {
            const parsed = JSON.parse(line);
            if (parsed?.type !== "audit.event" || !parsed.event?.eventId || !parsed.event?.action) throw new Error("invalid audit DLQ record");
            const eventTime = new Date(parsed.event.eventTime);
            if (Number.isNaN(eventTime.getTime())) throw new Error("invalid audit event time");
            event = conformAuditEventToSchema({ ...parsed.event, eventTime } as NormalizedAuditEvent);
          } catch {
            result.invalid += 1;
            result.remaining += 1;
            retained.push(line);
            continue;
          }

          try {
            await insertAuditEvent(event);
            result.persisted += 1;
          } catch (error) {
            if (isDuplicateEntry(error)) {
              result.duplicates += 1;
            } else {
              result.failed += 1;
              result.remaining += 1;
              retained.push(line);
            }
          }
        }

        if (retained.length > 0) await appendFile(source, `${retained.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
      } finally {
        await unlink(processing).catch(() => {});
      }

      if (result.scanned >= maxEvents) break;
    }

    result.completedAt = completedAt();
    await writeFile(path.join(dir, DLQ_STATE_FILE), `${JSON.stringify(result)}\n`, { encoding: "utf8", mode: 0o600 });
    return result;
  } finally {
    await lock.close().catch(() => {});
    await unlink(path.join(dir, DLQ_LOCK_FILE)).catch(() => {});
  }
}

function isDuplicateEntry(error: unknown): boolean {
  let candidate = error as { code?: string; errno?: number; cause?: unknown } | null;
  for (let depth = 0; candidate && depth < 5; depth += 1) {
    if (candidate.code === "ER_DUP_ENTRY" || candidate.errno === 1062) return true;
    candidate = candidate.cause as typeof candidate;
  }
  return false;
}

async function getDiskStats(dir: string): Promise<{ availableBytes: number; totalBytes: number } | null> {
  try {
    const fsStats = await statfs(dir);
    return {
      availableBytes: Number(fsStats.bavail) * Number(fsStats.bsize),
      totalBytes: Number(fsStats.blocks) * Number(fsStats.bsize),
    };
  } catch {
    return null;
  }
}

async function insertAuditEventToDb(event: NormalizedAuditEvent): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL is not set or database is unavailable");
  await db.insert(auditEvents).values(event as any);
}

async function writeAuditDlq(event: NormalizedAuditEvent, error: unknown, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const line = JSON.stringify({
    type: "audit.event",
    ts: new Date().toISOString(),
    error: errorMessage(error),
    event,
  });
  await appendFile(file, `${line}\n`, "utf8");
}

function normalizeMetadata(metadata: unknown): {
  value: Record<string, unknown> | null;
  truncated: boolean;
  originalBytes?: number | null;
} {
  if (metadata === undefined || metadata === null) {
    return { value: null, truncated: false, originalBytes: null };
  }

  const redacted = redactAuditMetadata(metadata);
  const json = safeStringify(redacted);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= METADATA_MAX_BYTES) {
    return {
      value: asMetadataObject(redacted),
      truncated: false,
      originalBytes: null,
    };
  }

  return {
    value: {
      truncated: true,
      preview: json.slice(0, 2048),
    },
    truncated: true,
    originalBytes: bytes,
  };
}

function asMetadataObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[binary:${value.length}]`;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
  if (typeof value !== "object") return String(value);

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    out[key] = redactValue(item, seen);
  }
  return out;
}

function redactString(value: string): string {
  return value
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/((?:password|token|secret|api[-_]?key|cookie|authorization|credential|private[-_]?key|gatewayToken|botToken)\s*[=:]\s*)(["']?)[^"'\s&]+/gi, "$1$2[REDACTED]")
    .replace(/([?&](?:password|token|secret|api[-_]?key|cookie|authorization|credential|private[-_]?key|gatewayToken|botToken)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(EMAIL_RE, "[REDACTED_EMAIL]")
    .replace(PHONE_RE, "[REDACTED_PHONE]")
    .replace(NATIONAL_ID_RE, "[REDACTED_ID]")
    .replace(BANK_CARD_RE, "[REDACTED_BANK_CARD]");
}

function safeStringify(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function createAuditEventId(): string {
  const now = Date.now();
  const time = encodeCrockfordBase32(now, 10);
  const random = encodeCrockfordBase32(BigInt(`0x${randomBytes(10).toString("hex")}`), 16);
  return `${time}${random}`;
}

function encodeCrockfordBase32(value: number | bigint, minLength: number): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let n = BigInt(value);
  let out = "";
  const base = BigInt(32);
  do {
    out = alphabet[Number(n % base)] + out;
    n /= base;
  } while (n > BigInt(0));
  return out.padStart(minLength, "0");
}

function categoryFromAction(action: string): string {
  const first = action.split(".")[0]?.trim();
  return first || "system";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
