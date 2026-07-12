import { createReadStream, createWriteStream, existsSync, readdirSync } from "fs";
import { appendFile, mkdir, rename, rm } from "fs/promises";
import path from "path";
import readline from "readline";

const DAY_MS = 24 * 60 * 60 * 1000;
const queues = new Map<string, Promise<void>>();
const lastPrunedAt = new Map<string, number>();
let retentionTimer: NodeJS.Timeout | null = null;

function boundedDays(raw: unknown, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(3650, Math.max(1, Math.floor(value))) : fallback;
}

export function retentionDaysForLog(filePath: string): number {
  const name = path.basename(filePath).toLowerCase();
  const auditLog = name.includes("audit") || name.includes("exec-detail") || name.includes("tool-router");
  return auditLog
    ? boundedDays(process.env.AUDIT_LOG_RETENTION_DAYS, 730)
    : boundedDays(process.env.APP_LOG_RETENTION_DAYS, 30);
}

function eventTimestamp(line: string): number | null {
  try {
    const item = JSON.parse(line);
    const raw = item?.ts || item?.timestamp || item?.eventTime || item?.createdAt;
    const value = typeof raw === "number" ? raw : Date.parse(String(raw || ""));
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export async function pruneJsonLogFile(filePath: string, now = Date.now()): Promise<void> {
  if (!existsSync(filePath)) return;
  const cutoff = now - retentionDaysForLog(filePath) * DAY_MS;
  const tempPath = `${filePath}.retention-${process.pid}-${Date.now()}`;
  const input = readline.createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  const output = createWriteStream(tempPath, { encoding: "utf8", mode: 0o600 });
  try {
    for await (const line of input) {
      if (!line) continue;
      const timestamp = eventTimestamp(line);
      if (timestamp === null || timestamp >= cutoff) {
        if (!output.write(`${line}\n`)) await new Promise<void>((resolve) => output.once("drain", resolve));
      }
    }
    await new Promise<void>((resolve, reject) => {
      output.once("error", reject);
      output.end(resolve);
    });
    await rename(tempPath, filePath);
    lastPrunedAt.set(filePath, now);
  } catch (error) {
    input.close();
    output.destroy();
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function enqueue(filePath: string, action: () => Promise<void>): Promise<void> {
  const pending = (queues.get(filePath) || Promise.resolve()).catch(() => {}).then(action);
  queues.set(filePath, pending);
  void pending.finally(() => {
    if (queues.get(filePath) === pending) queues.delete(filePath);
  }).catch(() => {});
  return pending;
}

export function appendRetainedJsonLog(filePath: string, payload: unknown): Promise<void> {
  return enqueue(filePath, async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    const lastPruned = lastPrunedAt.get(filePath) || 0;
    if (Date.now() - lastPruned >= DAY_MS) {
      await pruneJsonLogFile(filePath).catch(() => {});
    }
    await appendFile(filePath, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
  });
}

export async function pruneJsonLogDirectory(logDir: string): Promise<void> {
  if (!existsSync(logDir)) return;
  const files = readdirSync(logDir)
    .filter((name) => name.endsWith(".log"))
    .map((name) => path.join(logDir, name));
  await Promise.all(files.map((filePath) => enqueue(filePath, () => pruneJsonLogFile(filePath).catch(() => {}))));
}

export function startJsonLogRetention(logDir: string): void {
  if (retentionTimer) return;
  void pruneJsonLogDirectory(logDir);
  retentionTimer = setInterval(() => void pruneJsonLogDirectory(logDir), DAY_MS);
  retentionTimer.unref();
}
