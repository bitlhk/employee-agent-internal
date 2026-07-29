/**
 * Legacy Lingxia-owned cron delivery.
 *
 * New OpenClaw + WeChat jobs use OpenClaw's native announce delivery. This
 * poller remains for existing sidecar jobs and channels whose OpenClaw-native
 * delivery contract has not been verified yet.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { getChannelProvider, normalizeChannelId } from "./cron/channel-provider-registry";
import { createOpenClawRuntimeAdapter } from "./runtime";

const APP_ROOT = process.env.APP_ROOT || process.cwd();
const CONFIG_PATH = `${APP_ROOT}/data/cron-delivery-config.json`;
const POLL_INTERVAL_MS = 60_000;
const USER_ID_CACHE_TTL_MS = 60 * 60 * 1000;

const userIdCache = new Map<string, { userId: number; expiresAt: number }>();
const manualDeliveryInFlight = new Set<string>();
const openClawRuntime = createOpenClawRuntimeAdapter();

interface DeliveryConfig {
  adoptId: string;
  jobId: string;
  jobName: string;
  channel: string;
  lastDeliveredRunTs?: number;
  lastSkippedRunTs?: number;
  failCount?: number;
  lastFailedAt?: number;
  disabled?: boolean;
}

function loadConfigs(): DeliveryConfig[] {
  try {
    if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {}
  return [];
}

function saveConfigs(configs: DeliveryConfig[]) {
  writeFileSync(CONFIG_PATH, JSON.stringify(configs, null, 2), "utf-8");
}

async function resolveUserIdForAdopt(adoptId: string): Promise<number> {
  const cached = userIdCache.get(adoptId);
  if (cached && cached.expiresAt > Date.now()) return cached.userId;
  const { getClawByAdoptId } = await import("../db");
  const claw = await getClawByAdoptId(adoptId);
  const userId = Number((claw as any)?.userId || 0);
  userIdCache.set(adoptId, { userId, expiresAt: Date.now() + USER_ID_CACHE_TTL_MS });
  return userId;
}

function markDeliveryFailure(cfg: DeliveryConfig, configs: DeliveryConfig[]) {
  cfg.failCount = (cfg.failCount || 0) + 1;
  cfg.lastFailedAt = Date.now();
  if (cfg.failCount >= 5) {
    cfg.disabled = true;
    console.error(`[CRON-DELIVERY] disabled delivery after ${cfg.failCount} failures for ${cfg.adoptId}/${cfg.jobName}`);
  }
  saveConfigs(configs);
}

function markDeliverySuccess(cfg: DeliveryConfig, runTs: number, configs: DeliveryConfig[]) {
  cfg.lastDeliveredRunTs = runTs;
  cfg.failCount = 0;
  cfg.lastFailedAt = undefined;
  cfg.disabled = false;
  saveConfigs(configs);
}

function markRunSkipped(cfg: DeliveryConfig, runTs: number, reason: string, configs: DeliveryConfig[]) {
  cfg.lastSkippedRunTs = runTs;
  console.warn(`[CRON-DELIVERY] skip non-success run for ${cfg.adoptId}/${cfg.jobName}: ${reason}`);
  saveConfigs(configs);
}

function makeManualDeliveryKey(params: { adoptId: string; jobId: string; runTs: number }) {
  return `${params.adoptId}:${params.jobId}:${params.runTs}`;
}

function findDeliveryConfig(configs: DeliveryConfig[], adoptId: string, jobId: string) {
  return configs.find((c) => c.adoptId === adoptId && c.jobId === jobId);
}

export async function deliverCronRunNow(params: {
  adoptId: string;
  jobId: string;
  jobName: string;
  runTs: number;
  summary: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const configs = loadConfigs();
  const cfg = findDeliveryConfig(configs, params.adoptId, params.jobId);
  if (!cfg) return { ok: false, reason: "delivery_config_missing" };
  if (cfg.disabled) return { ok: false, reason: "delivery_disabled" };
  if (cfg.lastDeliveredRunTs && params.runTs <= cfg.lastDeliveredRunTs) {
    return { ok: true, reason: "already_delivered" };
  }

  const inFlightKey = makeManualDeliveryKey(params);
  if (manualDeliveryInFlight.has(inFlightKey)) {
    console.warn(`[CRON-DELIVERY] manual delivery already in flight for ${inFlightKey}`);
    return { ok: true, reason: "manual_delivery_in_flight" };
  }

  const channelProvider = getChannelProvider(cfg.channel);
  const normalizedChannel = normalizeChannelId(cfg.channel);
  if (!channelProvider || !normalizedChannel) {
    console.warn(`[CRON-DELIVERY] manual run has no channel provider for channel=${cfg.channel}`);
    return { ok: false, reason: "channel_provider_missing" };
  }

  manualDeliveryInFlight.add(inFlightKey);
  try {
    const userId = await resolveUserIdForAdopt(params.adoptId);
    const delivered = await channelProvider.send(
      {
        adoptId: params.adoptId,
        channelId: normalizedChannel,
        userId,
      },
      {
        title: `定时任务「${params.jobName}」`,
        text: params.summary,
        format: "text",
        metadata: { jobId: params.jobId, jobName: params.jobName, runTs: params.runTs, manual: true },
      },
    );
    if (delivered.ok) {
      markDeliverySuccess(cfg, params.runTs, configs);
      console.log(`[CRON-DELIVERY] manual ${normalizedChannel} sent OK`);
      return { ok: true };
    }
    console.error(`[CRON-DELIVERY] manual ${normalizedChannel} send failed:`, delivered.error.kind, delivered.error.detail || "");
    return { ok: false, reason: delivered.error.kind };
  } finally {
    manualDeliveryInFlight.delete(inFlightKey);
  }
}

export async function saveCronDeliveryConfig(
  adoptId: string,
  jobName: string,
  channel: string,
  jobId: string,
) {
  if (!jobId) throw new Error("jobId is required for cron delivery config");
  const configs = loadConfigs();
  const existing = findDeliveryConfig(configs, adoptId, jobId);
  if (existing) {
    existing.channel = channel;
    existing.jobName = jobName;
    existing.disabled = false;
    existing.failCount = 0;
    existing.lastFailedAt = undefined;
  } else {
    configs.push({ adoptId, jobId, jobName, channel });
  }
  saveConfigs(configs);
}

export async function deleteCronDeliveryConfig(adoptId: string, jobId: string) {
  if (!adoptId || !jobId) return;
  const configs = loadConfigs();
  const next = configs.filter((c) => !(c.adoptId === adoptId && c.jobId === jobId));
  if (next.length !== configs.length) saveConfigs(next);
}

export function getCronDeliveryChannel(adoptId: string, jobId: string): string | undefined {
  const configs = loadConfigs();
  return findDeliveryConfig(configs, adoptId, jobId)?.channel;
}

async function pollAndDeliver() {
  const configs = loadConfigs();
  if (configs.length === 0) return;

  let allJobs: any[] = [];
  try {
    const listData = openClawRuntime.callRpc("cron.list", { includeDisabled: true });
    allJobs = Array.isArray(listData?.jobs) ? listData.jobs : [];
  } catch (e: any) {
    console.error("[CRON-DELIVERY] failed to list jobs:", e?.message?.slice(0, 160));
    return;
  }

  for (const cfg of configs) {
    try {
      if (cfg.disabled) continue;
      if (!cfg.jobId) {
        console.warn(`[CRON-DELIVERY] skip config without jobId for ${cfg.adoptId}/${cfg.jobName}`);
        continue;
      }

      const job = allJobs.find((j: any) => String(j?.id || "") === cfg.jobId);
      if (!job) continue;

      let latestRun: any = null;
      try {
        const runsData = openClawRuntime.callRpc("cron.runs", { id: job.id, limit: 1 });
        const entries = Array.isArray(runsData?.entries) ? runsData.entries : [];
        if (entries.length > 0) latestRun = entries[0];
      } catch {
        continue;
      }

      if (!latestRun) continue;
      const runTs = latestRun.ts || latestRun.runAtMs || 0;
      const lastHandledRunTs = Math.max(cfg.lastDeliveredRunTs || 0, cfg.lastSkippedRunTs || 0);
      if (lastHandledRunTs && runTs <= lastHandledRunTs) continue;

      const status = String(latestRun.status || latestRun.lastStatus || "");
      if (status && status !== "ok") {
        markRunSkipped(cfg, runTs, status, configs);
        continue;
      }

      const summary = latestRun.summary || "";
      if (!summary) continue;

      console.log(`[CRON-DELIVERY] delivering "${cfg.jobName}" to ${cfg.channel} for ${cfg.adoptId}`);

      let deliveryOk = false;
      const channelProvider = getChannelProvider(cfg.channel);
      const normalizedChannel = normalizeChannelId(cfg.channel);
      if (channelProvider && normalizedChannel) {
        const userId = await resolveUserIdForAdopt(cfg.adoptId);
        const delivered = await channelProvider.send(
          {
            adoptId: cfg.adoptId,
            channelId: normalizedChannel,
            userId,
          },
          {
            title: `定时任务「${cfg.jobName}」`,
            text: summary,
            format: "text",
            metadata: { jobId: cfg.jobId, jobName: cfg.jobName, runTs },
          },
        );
        if (delivered.ok) {
          console.log(`[CRON-DELIVERY] ${normalizedChannel} sent OK`);
          deliveryOk = true;
        } else {
          console.error(`[CRON-DELIVERY] ${normalizedChannel} send failed:`, delivered.error.kind, delivered.error.detail || "");
        }
      } else {
        console.warn(`[CRON-DELIVERY] no channel provider for channel=${cfg.channel}`);
      }

      if (deliveryOk) {
        markDeliverySuccess(cfg, runTs, configs);
      } else {
        markDeliveryFailure(cfg, configs);
      }
    } catch (e: any) {
      console.error(`[CRON-DELIVERY] error for ${cfg.adoptId}/${cfg.jobName}:`, e?.message);
    }
  }
}

let pollInterval: ReturnType<typeof setInterval> | null = null;
let initialPoll: ReturnType<typeof setTimeout> | null = null;

export function startCronDeliveryPoller(): () => void {
  if (pollInterval) return stopCronDeliveryPoller;
  console.log("[CRON-DELIVERY] poller started");
  pollInterval = setInterval(pollAndDeliver, POLL_INTERVAL_MS);
  pollInterval.unref?.();
  initialPoll = setTimeout(pollAndDeliver, 5000);
  initialPoll.unref?.();
  return stopCronDeliveryPoller;
}

export function stopCronDeliveryPoller() {
  if (initialPoll) {
    clearTimeout(initialPoll);
    initialPoll = null;
  }
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}
