import { randomUUID } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { WebSocket, type RawData } from "ws";
import type {
  ChannelId,
  CronDeliveryConfig,
  CronJob,
  CronJobInput,
  CronProvider,
  CronProviderCapabilities,
  CronProviderHandle,
  CronResult,
  CronRunRecord,
  PreviewRunsRequest,
  PreviewRunsResponse,
} from "@shared/types/cron";
import { getCronDeliveryChannel } from "../cron-delivery";
import { jiuwenClawServiceId, resolveRuntimeWorkspaceByIds } from "../helpers";
import { computePreviewRuns } from "./openclaw-cron-provider";
import { normalizeChannelId } from "./channel-provider-registry";

const DEFAULT_AGENTSERVER_WS_URL = "ws://127.0.0.1:18092";
const DEFAULT_WEBCHANNEL_WS_URL = "ws://127.0.0.1:19000/ws";
const APP_ROOT = process.env.APP_ROOT || process.cwd();
const META_PATH = path.join(APP_ROOT, "data", "jiuwen-cron-meta.json");
const RUNS_PATH = path.join(APP_ROOT, "data", "jiuwen-cron-runs.json");

const JIUWEN_CRON_CAPABILITIES: CronProviderCapabilities = {
  scheduleKinds: ["once", "interval", "cron"],
  promptRequired: true,
  supportsTimezone: true,
  supportsWakeOffset: true,
  supportsPreview: true,
  supportsRunNow: true,
  supportedChannels: ["web", "feishu", "dingtalk"],
};

type JiuwenCronJob = {
  id?: string;
  name?: string;
  enabled?: boolean;
  expired?: boolean;
  cron_expr?: string;
  timezone?: string;
  wake_offset_seconds?: number;
  description?: string;
  targets?: string;
  created_at?: string;
  updated_at?: string;
  mode?: string;
  delete_after_run?: boolean;
  metadata?: Record<string, any>;
};

type JiuwenCronMeta = {
  jobs?: Array<{
    adoptId: string;
    taskId: string;
    name?: string;
    description?: string;
    channelId?: ChannelId;
    createdBy?: number;
    updatedAt?: string;
  }>;
};

type JiuwenCronStoredRun = CronRunRecord & {
  adoptId: string;
  updatedAt: string;
};

type JiuwenCronRuns = {
  runs?: JiuwenCronStoredRun[];
};

function ok<T>(value: T): CronResult<T> {
  return { ok: true, value };
}

function validationFailed<T>(detail: string): CronResult<T> {
  return { ok: false, error: { kind: "validation_failed", detail } };
}

function runtimeUnavailable<T>(detail: string): CronResult<T> {
  return { ok: false, error: { kind: "runtime_unavailable", detail } };
}

function notFound<T>(detail: string): CronResult<T> {
  return { ok: false, error: { kind: "not_found", detail } };
}

function notImplemented<T>(detail: string): CronResult<T> {
  return { ok: false, error: { kind: "not_implemented", detail } };
}

function ensureDataDir() {
  mkdirSync(path.dirname(META_PATH), { recursive: true });
}

function readMeta(): JiuwenCronMeta {
  try {
    if (existsSync(META_PATH)) return JSON.parse(readFileSync(META_PATH, "utf-8"));
  } catch {}
  return { jobs: [] };
}

function writeMeta(meta: JiuwenCronMeta) {
  ensureDataDir();
  writeFileSync(META_PATH, JSON.stringify({ jobs: meta.jobs || [] }, null, 2), "utf-8");
}

function readRuns(): JiuwenCronRuns {
  try {
    if (existsSync(RUNS_PATH)) return JSON.parse(readFileSync(RUNS_PATH, "utf-8"));
  } catch {}
  return { runs: [] };
}

function writeRuns(store: JiuwenCronRuns) {
  ensureDataDir();
  writeFileSync(RUNS_PATH, JSON.stringify({ runs: store.runs || [] }, null, 2), "utf-8");
}

function getMeta(adoptId: string, taskId: string) {
  return (readMeta().jobs || []).find((job) => job.adoptId === adoptId && job.taskId === taskId);
}

export function getJiuwenCronRouteMeta(adoptId: string, taskId: string): { channelId?: ChannelId } | null {
  const meta = getMeta(String(adoptId || ""), String(taskId || ""));
  if (!meta) return null;
  return {
    channelId: meta.channelId,
  };
}

export function findJiuwenCronRouteMeta(taskId: string): { adoptId: string; channelId?: ChannelId; name?: string } | null {
  const id = String(taskId || "").trim();
  if (!id) return null;
  const meta = (readMeta().jobs || []).find((job) => job.taskId === id);
  if (!meta) return null;
  return {
    adoptId: meta.adoptId,
    channelId: meta.channelId,
    name: meta.name,
  };
}

export function findJiuwenCronRunRouteMeta(taskId: string, runId?: string): { adoptId: string } | null {
  const id = String(taskId || "").trim();
  const targetRunId = String(runId || "").trim();
  if (!id) return null;
  const runs = readRuns().runs || [];
  const match = runs.find((run) => (
    run.jobId === id
    && (!targetRunId || run.id === targetRunId)
    && run.adoptId
  )) || runs.find((run) => run.jobId === id && run.adoptId);
  return match ? { adoptId: match.adoptId } : null;
}

export function recordJiuwenCronRun(input: {
  adoptId: string;
  taskId: string;
  runId?: string;
  status: CronRunRecord["status"];
  output?: string;
  errorMessage?: string;
  triggeredBy?: CronRunRecord["triggeredBy"];
  triggeredByUser?: number;
  startedAt?: string;
  finishedAt?: string;
  deliveryStatus?: CronRunRecord["deliveryStatus"];
}) {
  const adoptId = String(input.adoptId || "").trim();
  const taskId = String(input.taskId || "").trim();
  if (!adoptId || !taskId) return { recorded: false, duplicate: false };

  const now = new Date().toISOString();
  const id = String(input.runId || `${taskId}:${Date.now()}`).trim();
  const store = readRuns();
  const runs = store.runs || [];
  const existing = runs.find((run) => run.adoptId === adoptId && run.jobId === taskId && run.id === id);
  const duplicate = Boolean(existing && existing.status === input.status && existing.output === input.output);
  const startedAt = input.startedAt || existing?.startedAt || now;
  const finishedAt = input.finishedAt || (input.status === "running" ? existing?.finishedAt : now);
  const startedMs = Date.parse(startedAt);
  const finishedMs = finishedAt ? Date.parse(finishedAt) : NaN;
  const next: JiuwenCronStoredRun = {
    adoptId,
    id,
    jobId: taskId,
    startedAt,
    finishedAt,
    durationMs: Number.isFinite(startedMs) && Number.isFinite(finishedMs) ? Math.max(0, finishedMs - startedMs) : existing?.durationMs,
    status: input.status,
    output: input.output ?? existing?.output,
    errorMessage: input.errorMessage ?? existing?.errorMessage,
    deliveryStatus: duplicate
      ? existing?.deliveryStatus || input.deliveryStatus
      : input.deliveryStatus
        || (input.status === "running" ? "pending" : input.status === "ok" ? "ok" : input.status === "skipped" ? "skipped" : "failed"),
    triggeredBy: existing?.triggeredBy || input.triggeredBy || "schedule",
    triggeredByUser: input.triggeredByUser ?? existing?.triggeredByUser,
    updatedAt: now,
  };
  if (existing) Object.assign(existing, next);
  else runs.push(next);
  runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  writeRuns({ runs: runs.slice(0, 1000) });
  return { recorded: true, duplicate };
}

export function updateJiuwenCronRunDelivery(input: {
  adoptId: string;
  taskId: string;
  runId: string;
  deliveryStatus: NonNullable<CronRunRecord["deliveryStatus"]>;
  deliveryTargetMasked?: string;
}): boolean {
  const store = readRuns();
  const run = (store.runs || []).find((item) => (
    item.adoptId === input.adoptId
    && item.jobId === input.taskId
    && item.id === input.runId
  ));
  if (!run) return false;
  run.deliveryStatus = input.deliveryStatus;
  run.deliveryTargetMasked = input.deliveryTargetMasked;
  run.updatedAt = new Date().toISOString();
  writeRuns(store);
  return true;
}

function upsertMeta(handle: CronProviderHandle, taskId: string, input: CronJobInput) {
  const meta = readMeta();
  const jobs = meta.jobs || [];
  const existing = jobs.find((job) => job.adoptId === handle.adoptId && job.taskId === taskId);
  const target = input.delivery.targets[0];
  const channelId = normalizeChannelId(String(target?.channelId || "")) || undefined;
  const next = {
    adoptId: handle.adoptId,
    taskId,
    name: input.name,
    description: input.description,
    channelId,
    createdBy: handle.userId,
    updatedAt: new Date().toISOString(),
  };
  if (existing) Object.assign(existing, next);
  else jobs.push(next);
  writeMeta({ jobs });
}

function removeMeta(adoptId: string, taskId: string) {
  const meta = readMeta();
  const jobs = (meta.jobs || []).filter((job) => !(job.adoptId === adoptId && job.taskId === taskId));
  writeMeta({ jobs });
  const runStore = readRuns();
  writeRuns({ runs: (runStore.runs || []).filter((run) => !(run.adoptId === adoptId && run.jobId === taskId)) });
}

function parseJsonFrame(raw: RawData): any | null {
  try {
    const text = Array.isArray(raw)
      ? Buffer.concat(raw).toString("utf8")
      : Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : String(raw);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function wsOriginFromUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const protocol = url.protocol === "wss:" ? "https:" : "http:";
    return `${protocol}//${url.host}`;
  } catch {
    return "http://127.0.0.1";
  }
}

function buildScheduleRequest(handle: CronProviderHandle, method: string, params: Record<string, any>) {
  const requestId = `linggan-jiuwen-cron-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const serviceId = jiuwenClawServiceId();
  const agentId = handle.agentId || `jiuwen_${handle.adoptId}`;
  const sessionId = `cron_${handle.adoptId}`;
  const workspaceDir = resolveRuntimeWorkspaceByIds(handle.adoptId, agentId);
  return {
    requestId,
    payload: {
      protocol_version: "1.0",
      request_id: requestId,
      timestamp: new Date().toISOString(),
      identity_origin: "user",
      channel: "web",
      channel_context: {
        effective_project_dir: workspaceDir,
        cwd: workspaceDir,
        source_channel: "web",
      },
      method,
      is_stream: false,
      service_id: serviceId,
      agent_id: agentId,
      session_id: sessionId,
      params: {
        service_id: serviceId,
        agent_id: agentId,
        session_id: sessionId,
        project_dir: workspaceDir,
        ...params,
      },
    },
  };
}

function unwrapJiuwenResult(frame: any): any {
  if (frame?.status === "failed" || frame?.response_kind === "e2a.error") {
    const body = frame?.body || {};
    const detail = body?.message || body?.details?.error || body?.error || "JiuwenClaw schedule request failed";
    throw new Error(String(detail));
  }
  if (frame?.body?.result !== undefined) return frame.body.result;
  if (frame?.payload !== undefined) return frame.payload;
  return frame?.body || frame;
}

async function callJiuwenSchedule<T = any>(
  handle: CronProviderHandle,
  method: string,
  params: Record<string, any> = {},
  timeoutMs = 20_000,
): Promise<T> {
  const wsUrl = String(process.env.JIUWENCLAW_AGENTSERVER_WS_URL || DEFAULT_AGENTSERVER_WS_URL);
  const { requestId, payload } = buildScheduleRequest(handle, method, params);

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let sent = false;
    let ackTimer: NodeJS.Timeout | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (ackTimer) clearTimeout(ackTimer);
      clearTimeout(timeout);
      try { ws.close(1000); } catch {}
      fn();
    };
    const sendRequest = () => {
      if (sent || ws.readyState !== WebSocket.OPEN) return;
      sent = true;
      ws.send(JSON.stringify(payload));
    };

    const ws = new WebSocket(wsUrl, {
      headers: {
        Origin: process.env.JIUWENCLAW_WS_ORIGIN || wsOriginFromUrl(wsUrl),
      },
    });
    const timeout = setTimeout(() => {
      finish(() => reject(new Error(`JiuwenClaw schedule request timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    ws.on("open", () => {
      ackTimer = setTimeout(sendRequest, 1500);
    });
    ws.on("message", (raw) => {
      const frame = parseJsonFrame(raw);
      if (!frame) return;
      if (frame?.event === "connection.ack") {
        sendRequest();
        return;
      }
      const frameRequestId = String(frame?.request_id || frame?.response_id || "");
      if (frameRequestId && frameRequestId !== requestId) return;
      if (!frameRequestId && String(frame?.event || "") === "connection.ack") return;
      try {
        const value = unwrapJiuwenResult(frame);
        finish(() => resolve(value as T));
      } catch (error: any) {
        finish(() => reject(error));
      }
    });
    ws.on("error", (error) => {
      finish(() => reject(error));
    });
    ws.on("close", () => {
      if (!settled) finish(() => reject(new Error("JiuwenClaw schedule websocket closed before response")));
    });
  });
}

async function callJiuwenWebMethod<T = any>(
  method: string,
  params: Record<string, any> = {},
  timeoutMs = 20_000,
): Promise<T> {
  const wsUrl = String(process.env.JIUWENCLAW_WEBCHANNEL_WS_URL || DEFAULT_WEBCHANNEL_WS_URL);
  const requestId = `linggan-jiuwen-web-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { ws.close(1000); } catch {}
      fn();
    };
    const ws = new WebSocket(wsUrl, {
      headers: {
        Origin: process.env.JIUWENCLAW_WEBCHANNEL_ORIGIN || wsOriginFromUrl(wsUrl),
      },
    });
    const timeout = setTimeout(() => {
      finish(() => reject(new Error(`JiuwenClaw web request timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "req",
        id: requestId,
        method,
        params,
      }));
    });
    ws.on("message", (raw) => {
      const frame = parseJsonFrame(raw);
      if (!frame || frame?.type !== "res" || frame?.id !== requestId) return;
      if (frame.ok === false) {
        finish(() => reject(new Error(String(frame.error || frame.payload?.error || frame.code || `${method} failed`))));
        return;
      }
      finish(() => resolve((frame.payload ?? {}) as T));
    });
    ws.on("error", (error) => {
      finish(() => reject(error));
    });
    ws.on("close", () => {
      if (!settled) finish(() => reject(new Error("JiuwenClaw web websocket closed before response")));
    });
  });
}

function channelLabel(channelId: ChannelId) {
  if (channelId === "web") return "定时任务记录";
  if (channelId === "wechat") return "微信";
  if (channelId === "feishu") return "飞书";
  if (channelId === "dingtalk") return "钉钉";
  return "企业微信";
}

function jiuwenCallbackUrl(): string {
  const explicit = String(
    process.env.WORKFORCE_AGENT_JIUWEN_CALLBACK_URL
      || process.env.JIUWEN_CALLBACK_URL
      || process.env.LINGGAN_JIUWEN_CALLBACK_URL
      || "",
  ).trim();
  if (explicit) return explicit;
  const base = String(process.env.EA_INTERNAL_BASE_URL || process.env.APP_BASE_URL || "").trim();
  if (base) return `${base.replace(/\/+$/, "")}/api/internal/jiuwen/callback`;
  const port = String(process.env.PORT || process.env.EA_PORT || "5180").trim() || "5180";
  return `http://127.0.0.1:${port}/api/internal/jiuwen/callback`;
}

function jiuwenWebhookToken(): string {
  return String(
    process.env.WORKFORCE_AGENT_JIUWEN_WEBHOOK_TOKEN
      || process.env.JIUWEN_WEBHOOK_TOKEN
      || process.env.LINGGAN_JIUWEN_WEBHOOK_TOKEN
      || process.env.INTERNAL_API_KEY
      || "",
  ).trim();
}

function buildCronCallbackMetadata(handle: CronProviderHandle, input: CronJobInput) {
  const target = input.delivery.targets[0];
  const channelId = normalizeChannelId(String(target?.channelId || "")) || "web";
  const callback = {
    callback_url: jiuwenCallbackUrl(),
    token: jiuwenWebhookToken(),
    adoptId: handle.adoptId,
    agentId: handle.agentId,
    userId: handle.userId,
    delivery: {
      channelId,
      targetId: target?.targetId,
      targetLabel: target?.targetLabel,
    },
  };
  return {
    workforceAgent: callback,
    // Older JiuwenSwarm deployments only recognize this metadata key.
    linggan: callback,
  };
}

function deliveryConfigFromMeta(handle: CronProviderHandle, taskId: string, nativeTargets?: unknown): CronDeliveryConfig {
  const configured = normalizeChannelId(getCronDeliveryChannel(handle.adoptId, taskId) || "");
  const local = getMeta(handle.adoptId, taskId)?.channelId;
  const nativeRaw = String(nativeTargets || "").trim();
  const native = nativeRaw === "linggan" ? "web" : normalizeChannelId(nativeRaw);
  const channelId = configured || local || native || "web";
  return {
    targets: [{
      channelId,
      channelLabel: channelLabel(channelId),
    }],
  };
}

function parseDateIso(raw: unknown, fallback = new Date(0).toISOString()) {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const date = new Date(raw < 1e12 ? raw * 1000 : raw);
    return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
  }
  const text = String(raw || "").trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    if (Number.isFinite(numeric)) {
      const date = new Date(numeric < 1e12 ? numeric * 1000 : numeric);
      return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
    }
  }
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function padInt(value: number) {
  return Number.isFinite(value) ? String(Math.trunc(value)) : "0";
}

function localDateParts(raw: string) {
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return null;
  return {
    minute: date.getMinutes(),
    hour: date.getHours(),
    day: date.getDate(),
    month: date.getMonth() + 1,
    second: date.getSeconds(),
    year: date.getFullYear(),
  };
}

function cronExprFromSchedule(schedule: CronJobInput["schedule"]): string {
  if (schedule.kind === "cron") return schedule.cronExpr.trim();
  if (schedule.kind === "once") {
    const parts = localDateParts(schedule.runAt);
    if (!parts) throw new Error("invalid one-time runAt");
    return [
      padInt(parts.minute),
      padInt(parts.hour),
      padInt(parts.day),
      padInt(parts.month),
      "*",
      padInt(parts.second),
      padInt(parts.year),
    ].join(" ");
  }

  const intervalMinutes = Math.max(1, Number(schedule.intervalMinutes || 0));
  if (intervalMinutes < 60) return `*/${Math.trunc(intervalMinutes)} * * * *`;
  if (intervalMinutes % 60 === 0) {
    const hours = Math.max(1, Math.trunc(intervalMinutes / 60));
    if (hours === 1) return "0 * * * *";
    if (hours < 24) return `0 */${hours} * * *`;
    if (hours % 24 === 0) {
      const days = Math.max(1, Math.trunc(hours / 24));
      return days === 1 ? "0 0 * * *" : `0 0 */${days} * *`;
    }
  }
  throw new Error("Jiuwen cron interval must be expressible as a standard cron expression");
}

function scheduleFromJiuwenCron(raw: JiuwenCronJob): CronJob["schedule"] {
  const cronExpr = String(raw.cron_expr || "").trim();
  const fields = cronExpr.split(/\s+/).filter(Boolean);
  if (fields.length === 7) {
    const [minute, hour, day, month, _dow, second, year] = fields;
    if ([minute, hour, day, month, second, year].every((part) => /^\d+$/.test(part))) {
      const runAt = new Date(
        Number(year),
        Math.max(0, Number(month) - 1),
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
      ).toISOString();
      return { kind: "once", runAt, display: runAt };
    }
  }
  return { kind: "cron", cronExpr, display: cronExpr || "cron" };
}

function taskStatus(raw: JiuwenCronJob): CronJob["state"]["status"] {
  if (raw.expired) return "completed";
  if (raw.enabled === false) return "paused";
  return "scheduled";
}

function executionStatus(raw: any): CronRunRecord["status"] {
  const status = String(raw?.status || "").toLowerCase();
  if (status === "success" || status === "ok") return "ok";
  if (status === "cancelled" || status === "canceled") return "canceled";
  if (["running", "error", "skipped", "timeout"].includes(status)) return status as CronRunRecord["status"];
  return status === "failed" ? "error" : "ok";
}

function jiuwenTaskToCronJob(raw: JiuwenCronJob, handle: CronProviderHandle): CronJob {
  const id = String(raw.id || "");
  const meta = getMeta(handle.adoptId, id);
  const createdAt = parseDateIso(raw.created_at);
  const updatedAt = parseDateIso(raw.updated_at, meta?.updatedAt || createdAt);
  const storedRuns = (readRuns().runs || [])
    .filter((run) => run.adoptId === handle.adoptId && run.jobId === id)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const latestRun = storedRuns[0];
  const preview = (() => {
    try {
      const schedule = scheduleFromJiuwenCron(raw);
      return computePreviewRuns({
        adoptId: handle.adoptId,
        schedule,
        timezone: String(raw.timezone || "Asia/Shanghai"),
        count: 1,
        wakeOffsetSeconds: Number(raw.wake_offset_seconds || 0),
      }).runs[0];
    } catch {
      return undefined;
    }
  })();
  return {
    id,
    runtime: "jiuwenclaw",
    adoptId: handle.adoptId,
    userId: handle.userId,
    name: meta?.name || String(raw.name || id || "JiuwenSwarm 定时任务").slice(0, 40),
    enabled: raw.enabled !== false && raw.expired !== true,
    prompt: raw.description ? String(raw.description) : undefined,
    description: meta?.description,
    schedule: scheduleFromJiuwenCron(raw),
    state: {
      status: taskStatus(raw),
      nextRunAt: raw.enabled !== false && raw.expired !== true ? preview?.runAt : undefined,
      lastRunAt: latestRun?.startedAt,
      lastStatus: latestRun?.status === "running" ? undefined : latestRun?.status,
      totalRuns: storedRuns.length,
      successRuns: storedRuns.filter((run) => run.status === "ok").length,
    },
    delivery: deliveryConfigFromMeta(handle, id, raw.targets),
    wakeOffsetSeconds: Number(raw.wake_offset_seconds || 0),
    meta: {
      runNowSupported: true,
      updateSupported: true,
      deliveryManagedBy: "jiuwenclaw-native",
      nativeCronExpr: raw.cron_expr,
      nativeTargets: raw.targets,
      nativeMode: raw.mode,
    },
    createdBy: meta?.createdBy || handle.userId,
    createdAt,
    updatedBy: handle.userId,
    updatedAt,
  };
}

function rawTasks(response: any): JiuwenCronJob[] {
  if (Array.isArray(response?.jobs)) return response.jobs;
  if (Array.isArray(response)) return response;
  return [];
}

function jiuwenExecutionToRunRecord(raw: any, jobId: string): CronRunRecord {
  const startedAt = parseDateIso(raw?.started_at, new Date().toISOString());
  const finishedAt = raw?.completed_at ? parseDateIso(raw.completed_at) : undefined;
  const startedMs = Date.parse(startedAt);
  const finishedMs = finishedAt ? Date.parse(finishedAt) : NaN;
  return {
    id: String(raw?.execution_id || `${jobId}:${startedAt}`),
    jobId,
    startedAt,
    finishedAt,
    durationMs: Number.isFinite(startedMs) && Number.isFinite(finishedMs) ? Math.max(0, finishedMs - startedMs) : undefined,
    status: executionStatus(raw),
    errorMessage: raw?.error ? String(raw.error) : undefined,
    triggeredBy: "schedule",
  };
}

export class JiuwenClawCronProvider implements CronProvider {
  readonly runtime = "jiuwenclaw";

  capabilities(): CronProviderCapabilities {
    return JIUWEN_CRON_CAPABILITIES;
  }

  async listJobs(handle: CronProviderHandle): Promise<CronResult<CronJob[]>> {
    try {
      const response = await callJiuwenWebMethod("cron.job.list");
      return ok(rawTasks(response).map((task) => jiuwenTaskToCronJob(task, handle)));
    } catch (error: any) {
      return runtimeUnavailable(`cron.job.list failed: ${error?.message || error}`);
    }
  }

  async addJob(handle: CronProviderHandle, input: CronJobInput): Promise<CronResult<CronJob>> {
    if (!input.prompt?.trim()) return validationFailed("prompt is required for JiuwenClaw cron jobs");

    const target = input.delivery.targets[0];
    if (!target) return validationFailed("delivery target is required");
    if (!JIUWEN_CRON_CAPABILITIES.supportedChannels.includes(target.channelId)) {
      return validationFailed(`JiuwenClaw cron does not support channel ${target.channelId}`);
    }

    try {
      const response = await callJiuwenWebMethod("cron.job.create", {
        name: input.name.trim(),
        cron_expr: cronExprFromSchedule(input.schedule),
        description: input.prompt.trim(),
        timezone: String(input.meta?.timezone || "Asia/Shanghai"),
        targets: "linggan",
        metadata: buildCronCallbackMetadata(handle, input),
        enabled: input.enabled !== false,
        wake_offset_seconds: Number(input.wakeOffsetSeconds ?? 300),
        mode: String(input.meta?.mode || "agent"),
        delete_after_run: input.schedule.kind === "once",
      });
      if (response?.error) return runtimeUnavailable(`cron.job.create failed: ${String(response.error)}`);

      const rawJob = response?.job || response;
      const taskId = String(rawJob?.id || "");
      if (!taskId) return runtimeUnavailable("schedule.create did not return task_id");
      upsertMeta(handle, taskId, input);
      return ok(jiuwenTaskToCronJob(rawJob, handle));
    } catch (error: any) {
      return runtimeUnavailable(`cron.job.create failed: ${error?.message || error}`);
    }
  }

  async updateJob(handle: CronProviderHandle, id: string, patch: Partial<CronJobInput>): Promise<CronResult<CronJob>> {
    const current = await this.listJobs(handle);
    if (!current.ok) return current as CronResult<CronJob>;
    const found = current.value.find((job) => job.id === id);
    if (!found) return notFound("JiuwenClaw cron job not found");
    const rawPatch: Record<string, any> = {};
    if (patch.name !== undefined) rawPatch.name = patch.name;
    if (patch.description !== undefined || patch.prompt !== undefined) {
      rawPatch.description = patch.prompt ?? patch.description ?? found.prompt ?? found.description ?? "";
    }
    if (patch.enabled !== undefined) rawPatch.enabled = patch.enabled;
    if (patch.schedule !== undefined) {
      try {
        rawPatch.cron_expr = cronExprFromSchedule(patch.schedule);
        rawPatch.delete_after_run = patch.schedule.kind === "once";
      } catch (error: any) {
        return validationFailed(error?.message || String(error));
      }
    }
    if (patch.wakeOffsetSeconds !== undefined) rawPatch.wake_offset_seconds = patch.wakeOffsetSeconds;
    if (patch.delivery !== undefined) {
      const target = patch.delivery.targets[0];
      if (!target) return validationFailed("delivery target is required");
      rawPatch.targets = "linggan";
      rawPatch.metadata = buildCronCallbackMetadata(handle, {
        name: patch.name || found.name,
        description: patch.description ?? found.description,
        enabled: patch.enabled ?? found.enabled,
        schedule: patch.schedule || found.schedule,
        prompt: patch.prompt ?? found.prompt,
        delivery: patch.delivery,
        meta: found.meta,
      });
    }
    try {
      if (Object.keys(rawPatch).length > 0) {
        const response = await callJiuwenWebMethod("cron.job.update", { id, patch: rawPatch });
        if (response?.error) return runtimeUnavailable(`cron.job.update failed: ${String(response.error)}`);
      }
    } catch (error: any) {
      return runtimeUnavailable(`cron.job.update failed: ${error?.message || error}`);
    }
    upsertMeta(handle, id, {
      name: patch.name || found.name,
      description: patch.description ?? found.description,
      enabled: patch.enabled ?? found.enabled,
      schedule: patch.schedule || found.schedule,
      prompt: patch.prompt ?? found.prompt,
      delivery: patch.delivery || found.delivery,
      meta: found.meta,
    });
    const refreshed = await this.listJobs(handle);
    if (!refreshed.ok) return refreshed as CronResult<CronJob>;
    const updated = refreshed.value.find((job) => job.id === id);
    return updated ? ok(updated) : notFound("JiuwenClaw cron job not found");
  }

  async removeJob(handle: CronProviderHandle, id: string): Promise<CronResult<void>> {
    try {
      const response = await callJiuwenWebMethod("cron.job.delete", { id });
      if (response?.error) return notFound(String(response.error));
      removeMeta(handle.adoptId, id);
      return ok(undefined);
    } catch (error: any) {
      return runtimeUnavailable(`cron.job.delete failed: ${error?.message || error}`);
    }
  }

  async runJobNow(handle: CronProviderHandle, id: string): Promise<CronResult<{ runId: string }>> {
    try {
      const response = await callJiuwenWebMethod("cron.job.run_now", { id });
      if (response?.error) return runtimeUnavailable(`cron.job.run_now failed: ${String(response.error)}`);
      const runId = String(response?.run_id || `${id}:${Date.now()}`);
      recordJiuwenCronRun({
        adoptId: handle.adoptId,
        taskId: id,
        runId,
        status: "running",
        triggeredBy: "manual",
        triggeredByUser: handle.userId,
      });
      return ok({ runId });
    } catch (error: any) {
      return runtimeUnavailable(`cron.job.run_now failed: ${error?.message || error}`);
    }
  }

  async listRuns(handle: CronProviderHandle, id: string, limit: number): Promise<CronResult<CronRunRecord[]>> {
    const runs = (readRuns().runs || [])
      .filter((run) => run.adoptId === handle.adoptId && run.jobId === id)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, Math.max(1, limit))
      .map(({ adoptId: _adoptId, updatedAt: _updatedAt, ...run }) => run);
    return ok(runs);
  }

  async previewRuns(request: PreviewRunsRequest): Promise<CronResult<PreviewRunsResponse>> {
    try {
      return ok(computePreviewRuns(request));
    } catch (error: any) {
      return validationFailed(`preview failed: ${error?.message || error}`);
    }
  }
}
