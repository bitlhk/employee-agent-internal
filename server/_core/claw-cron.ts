import express from "express";
import { isAuthorizedInternalRequest, isJiuwenClawAdoptId, requireClawOwner, resolveRuntimeAgentId } from "./helpers";
import { OpenClawCronProvider } from "./cron/openclaw-cron-provider";
import { JiuwenClawCronProvider } from "./cron/jiuwenclaw-cron-provider";
import { startCronRunWatcher } from "./cron/cron-run-watcher";
import {
  resolveCronCapabilities,
  unavailableDeliveryChannelError,
} from "./cron/channel-capabilities";
import { deleteCronDeliveryConfig, saveCronDeliveryConfig } from "./cron-delivery";
import { normalizeChannelId } from "./cron/channel-provider-registry";
import type { CronJobInput, CronProviderHandle as SharedCronProviderHandle, CronSchedule } from "@shared/types/cron";

const openClawCronProvider = new OpenClawCronProvider();
const jiuwenClawCronProvider = new JiuwenClawCronProvider();

async function capabilitiesForClaw(claw: any) {
  const adoptId = String(claw?.adoptId || "").trim();
  const provider = isJiuwenClawAdoptId(adoptId) ? jiuwenClawCronProvider : openClawCronProvider;
  return resolveCronCapabilities(adoptId, provider.capabilities());
}

function isLegacyArchivedAdopt(adoptId: string): boolean {
  return String(adoptId || "").startsWith("lgh-");
}

function toOpenClawHandle(claw: any): SharedCronProviderHandle {
  const adoptId = String(claw.adoptId || "");
  return {
    adoptId,
    agentId: resolveRuntimeAgentId(adoptId, (claw as any).agentId),
    userId: Number(claw.userId || 0),
    runtime: "openclaw",
  };
}

function toJiuwenClawHandle(claw: any): SharedCronProviderHandle {
  const adoptId = String(claw.adoptId || "");
  return {
    adoptId,
    agentId: resolveRuntimeAgentId(adoptId, (claw as any).agentId),
    userId: Number(claw.userId || 0),
    runtime: "jiuwenclaw",
  };
}

async function resolveClaw(req: express.Request, res: express.Response, adoptId: string) {
  if (isAuthorizedInternalRequest(req)) {
    const { getClawByAdoptId } = await import("../db");
    const claw = await getClawByAdoptId(adoptId);
    if (!claw) {
      res.status(404).json({ error: "NOT_FOUND" });
      return undefined;
    }
    return claw;
  }
  return requireClawOwner(req, res, adoptId);
}

function cronScheduleFromRequest(raw: any): CronSchedule {
  const kind = String(raw?.kind || "cron");
  if (kind === "interval" || kind === "every") {
    const intervalMinutes = Number(raw?.intervalMinutes || (raw?.everyMs ? Math.round(Number(raw.everyMs) / 60000) : 0) || 30);
    return { kind: "interval", intervalMinutes, display: `每 ${intervalMinutes} 分钟` };
  }
  if (kind === "once" || kind === "at") {
    const runAt = String(raw?.runAt || raw?.at || "");
    return { kind: "once", runAt, display: runAt };
  }
  const cronExpr = String(raw?.cronExpr || raw?.expr || "0 9 * * *");
  return { kind: "cron", cronExpr, display: raw?.display ? String(raw.display) : cronExpr };
}

function cronDeliveryFromRequest(raw: any): CronJobInput["delivery"] {
  const targets = Array.isArray(raw?.targets) ? raw.targets : [];
  const first = targets[0];
  if (first?.channelId) {
    const channelId = normalizeChannelId(String(first.channelId));
    if (channelId) {
      return {
        targets: [{
          channelId,
          channelLabel: first.channelLabel || (channelId === "web" ? "当前对话" : channelId === "wechat" ? "微信" : channelId === "feishu" ? "飞书" : "企业微信"),
          targetId: first.targetId,
          targetLabel: first.targetLabel,
          format: first.format,
        }],
      };
    }
  }

  const rawChannel = String(raw?.channel || raw?.to || raw?.mode || (raw?.weixin ? "wechat" : "")).trim();
  const channelId = rawChannel === "conversation"
    ? "web"
    : rawChannel === "weixin"
      ? "wechat"
      : normalizeChannelId(rawChannel) || "wechat";
  return {
    targets: [{
      channelId,
      channelLabel: channelId === "web" ? "当前对话" : channelId === "wechat" ? "微信" : channelId === "feishu" ? "飞书" : "企业微信",
      targetId: raw?.target || raw?.to,
      targetLabel: raw?.targetLabel,
    }],
  };
}

function cronJobInputFromRequest(job: any): CronJobInput {
  const rawMeta = job?.meta && typeof job.meta === "object" && !Array.isArray(job.meta) ? job.meta : {};
  return {
    name: String(job?.name || "定时任务").trim() || "定时任务",
    description: job?.description ? String(job.description) : undefined,
    enabled: job?.enabled !== false,
    schedule: cronScheduleFromRequest(job?.schedule || {}),
    prompt: String(job?.prompt || job?.payload?.message || ""),
    delivery: cronDeliveryFromRequest(job?.delivery || {}),
    meta: {
      ...rawMeta,
      sessionTarget: job?.sessionTarget || "isolated",
      skills: job?.skills,
      model: job?.payload?.model || job?.model,
    },
  };
}

function validateCronInputSafety(input: CronJobInput): string | null {
  const minIntervalMinutes = 30;
  if (input.schedule.kind === "interval" && input.schedule.intervalMinutes < minIntervalMinutes) {
    return `执行间隔不能低于 ${minIntervalMinutes} 分钟`;
  }
  if (input.schedule.kind === "cron") {
    const minutePart = input.schedule.cronExpr.trim().split(/\s+/)[0] || "";
    const stepMatch = minutePart.match(/^\*\/(\d+)$/);
    if (minutePart === "*" || (stepMatch && Number(stepMatch[1]) < minIntervalMinutes)) {
      return "cron 表达式执行频率不能高于每 30 分钟";
    }
  }
  if (input.schedule.kind === "once" && !input.schedule.runAt) return "单次任务时间不能为空";
  return null;
}

function providerErrorStatus(kind?: string) {
  if (kind === "validation_failed") return 400;
  if (kind === "not_found") return 404;
  if (kind === "not_implemented") return 501;
  return 500;
}

function providerError(error: any) {
  return Object.assign(new Error(String(error?.detail || "cron provider failed")), {
    status: providerErrorStatus(error?.kind),
  });
}

function archivedRuntimeError() {
  return Object.assign(new Error("Legacy runtime has been archived"), { status: 410 });
}

export async function listCronJobsForClaw(claw: any, options?: {
  limit?: number;
  offset?: number;
  query?: string;
  enabled?: string;
  scheduleKind?: string;
}) {
  const adoptId = String(claw?.adoptId || "").trim();
  const limit = Math.max(1, Math.min(200, Number(options?.limit || 20)));
  const offset = Math.max(0, Number(options?.offset || 0));
  const query = String(options?.query || "").trim().toLowerCase();
  const enabled = String(options?.enabled || "all");
  const scheduleKind = String(options?.scheduleKind || "all");

  if (isLegacyArchivedAdopt(adoptId)) throw archivedRuntimeError();

  if (isJiuwenClawAdoptId(adoptId)) {
    const listed = await jiuwenClawCronProvider.listJobs(toJiuwenClawHandle(claw));
    if (!listed.ok) throw providerError(listed.error);
    let jobs = listed.value;
    if (query) jobs = jobs.filter((j) => String(j.name || "").toLowerCase().includes(query) || String(j.description || "").toLowerCase().includes(query));
    if (enabled === "enabled") jobs = jobs.filter((j) => j.enabled !== false);
    if (enabled === "disabled") jobs = jobs.filter((j) => j.enabled === false);
    if (["interval", "once", "cron"].includes(scheduleKind)) jobs = jobs.filter((j) => String(j.schedule?.kind || "") === scheduleKind);
    const total = jobs.length;
    return { runtime: "jiuwenclaw", capabilities: await capabilitiesForClaw(claw), jobs: jobs.slice(offset, offset + limit), total, limit, offset };
  }

  const listed = await openClawCronProvider.listJobs(toOpenClawHandle(claw));
  if (!listed.ok) throw providerError(listed.error);
  let jobs = listed.value;
  if (query) jobs = jobs.filter((j) => String(j.name || "").toLowerCase().includes(query) || String(j.description || "").toLowerCase().includes(query));
  if (enabled === "enabled") jobs = jobs.filter((j) => j.enabled !== false);
  if (enabled === "disabled") jobs = jobs.filter((j) => j.enabled === false);
  if (["interval", "once", "cron"].includes(scheduleKind)) jobs = jobs.filter((j) => String(j.schedule?.kind || "") === scheduleKind);
  const total = jobs.length;
  return { runtime: "openclaw", capabilities: await capabilitiesForClaw(claw), jobs: jobs.slice(offset, offset + limit), total, limit, offset };
}

export async function listCronRunsForClaw(claw: any, options?: {
  limit?: number;
  offset?: number;
  jobId?: string;
  scope?: string;
}) {
  const adoptId = String(claw?.adoptId || "").trim();
  if (isLegacyArchivedAdopt(adoptId)) throw archivedRuntimeError();

  const limit = Math.max(1, Math.min(200, Number(options?.limit || 20)));
  const offset = Math.max(0, Number(options?.offset || 0));
  const jobId = String(options?.jobId || "").trim();
  const scope = String(options?.scope || "all").trim();
  const provider = isJiuwenClawAdoptId(adoptId) ? jiuwenClawCronProvider : openClawCronProvider;
  const handle = isJiuwenClawAdoptId(adoptId) ? toJiuwenClawHandle(claw) : toOpenClawHandle(claw);
  const listed = await provider.listJobs(handle);
  if (!listed.ok) throw providerError(listed.error);

  const targetJobs = jobId ? listed.value.filter((j) => String(j.id) === jobId) : listed.value;
  let runs: any[] = [];
  for (const job of targetJobs.slice(0, 50)) {
    const runResult = await provider.listRuns(handle, job.id, 100);
    if (!runResult.ok) {
      console.warn("[CRON-PROVIDER] listRuns failed for job", { adoptId, jobId: job.id, error: runResult.error });
      continue;
    }
    runs.push(...runResult.value.map((run) => ({ ...run, jobName: job.name })));
  }
  if (["ok", "error", "skipped", "timeout", "canceled"].includes(scope)) runs = runs.filter((r: any) => String(r?.status || "") === scope);
  runs.sort((a: any, b: any) => Date.parse(String(b?.startedAt || "")) - Date.parse(String(a?.startedAt || "")));
  const total = runs.length;
  return { runs: runs.slice(offset, offset + limit), total, limit, offset };
}

export function registerCronRoutes(app: express.Express) {
  app.get("/api/claw/cron/status", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;

      if (isLegacyArchivedAdopt(adoptId)) return res.status(410).json({ error: "LEGACY_RUNTIME_ARCHIVED" });

      if (isJiuwenClawAdoptId(adoptId)) {
        const listed = await jiuwenClawCronProvider.listJobs(toJiuwenClawHandle(claw));
        if (!listed.ok) return res.status(providerErrorStatus(listed.error.kind)).json({ error: listed.error.detail });
        const enabled = listed.value.filter((j) => j.enabled);
        const nextRunIso = enabled.map((j) => j.state.nextRunAt).filter(Boolean).sort()[0];
        return res.json({
          enabled: true,
          runtime: "jiuwenclaw",
          jobs: listed.value.length,
          enabledJobs: enabled.length,
          nextRunAt: nextRunIso || undefined,
          nextWakeAtMs: nextRunIso ? new Date(nextRunIso).getTime() : undefined,
        });
      }

      const listed = await openClawCronProvider.listJobs(toOpenClawHandle(claw));
      if (!listed.ok) return res.status(500).json({ error: listed.error.detail });
      const enabled = listed.value.filter((j) => j.enabled);
      const nextRunIso = enabled.map((j) => j.state.nextRunAt).filter(Boolean).sort()[0];
      return res.json({
        enabled: true,
        runtime: "openclaw",
        jobs: listed.value.length,
        enabledJobs: enabled.length,
        nextRunAt: nextRunIso || undefined,
        nextWakeAtMs: nextRunIso ? new Date(nextRunIso).getTime() : undefined,
      });
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message || e || "cron status failed") });
    }
  });

  app.get("/api/claw/cron/capabilities", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      if (isLegacyArchivedAdopt(adoptId)) return res.status(410).json({ error: "LEGACY_RUNTIME_ARCHIVED" });
      if (isJiuwenClawAdoptId(adoptId)) return res.json({ runtime: "jiuwenclaw", capabilities: await capabilitiesForClaw(claw) });
      return res.json({ runtime: "openclaw", capabilities: await capabilitiesForClaw(claw) });
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message || e || "capabilities failed") });
    }
  });

  app.get("/api/claw/cron/list", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await resolveClaw(req, res, adoptId);
      if (!claw) return;

      const limit = Math.max(1, Math.min(200, Number(req.query.limit || 20)));
      const offset = Math.max(0, Number(req.query.offset || 0));
      const query = String(req.query.query || "").trim().toLowerCase();
      const enabled = String(req.query.enabled || "all");
      const scheduleKind = String(req.query.scheduleKind || "all");

      if (isLegacyArchivedAdopt(adoptId)) return res.status(410).json({ error: "LEGACY_RUNTIME_ARCHIVED" });

      if (isJiuwenClawAdoptId(adoptId)) {
        const listed = await jiuwenClawCronProvider.listJobs(toJiuwenClawHandle(claw));
        if (!listed.ok) return res.status(providerErrorStatus(listed.error.kind)).json({ error: listed.error.detail });
        let jobs = listed.value;
        if (query) jobs = jobs.filter((j) => String(j.name || "").toLowerCase().includes(query) || String(j.description || "").toLowerCase().includes(query));
        if (enabled === "enabled") jobs = jobs.filter((j) => j.enabled !== false);
        if (enabled === "disabled") jobs = jobs.filter((j) => j.enabled === false);
        if (["interval", "once", "cron"].includes(scheduleKind)) jobs = jobs.filter((j) => String(j.schedule?.kind || "") === scheduleKind);
        const total = jobs.length;
        return res.json({ runtime: "jiuwenclaw", capabilities: await capabilitiesForClaw(claw), jobs: jobs.slice(offset, offset + limit), total, limit, offset });
      }

      const listed = await openClawCronProvider.listJobs(toOpenClawHandle(claw));
      if (!listed.ok) return res.status(providerErrorStatus(listed.error.kind)).json({ error: listed.error.detail });
      let jobs = listed.value;
      if (query) jobs = jobs.filter((j) => String(j.name || "").toLowerCase().includes(query) || String(j.description || "").toLowerCase().includes(query));
      if (enabled === "enabled") jobs = jobs.filter((j) => j.enabled !== false);
      if (enabled === "disabled") jobs = jobs.filter((j) => j.enabled === false);
      if (["interval", "once", "cron"].includes(scheduleKind)) jobs = jobs.filter((j) => String(j.schedule?.kind || "") === scheduleKind);
      const total = jobs.length;
      return res.json({ runtime: "openclaw", capabilities: await capabilitiesForClaw(claw), jobs: jobs.slice(offset, offset + limit), total, limit, offset });
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message || e || "cron list failed") });
    }
  });

  app.get("/api/claw/cron/runs", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await resolveClaw(req, res, adoptId);
      if (!claw) return;
      if (isLegacyArchivedAdopt(adoptId)) return res.status(410).json({ error: "LEGACY_RUNTIME_ARCHIVED" });

      const limit = Math.max(1, Math.min(200, Number(req.query.limit || 20)));
      const offset = Math.max(0, Number(req.query.offset || 0));
      const jobId = String(req.query.jobId || "").trim();
      const scope = String(req.query.scope || "all").trim();

      if (isJiuwenClawAdoptId(adoptId)) {
        const handle = toJiuwenClawHandle(claw);
        const listed = await jiuwenClawCronProvider.listJobs(handle);
        if (!listed.ok) return res.status(providerErrorStatus(listed.error.kind)).json({ error: listed.error.detail });
        const targetJobs = jobId ? listed.value.filter((j) => String(j.id) === jobId) : listed.value;
        let runs: any[] = [];
        for (const job of targetJobs.slice(0, 50)) {
          const runResult = await jiuwenClawCronProvider.listRuns(handle, job.id, 100);
          if (!runResult.ok) {
            console.warn("[CRON-PROVIDER] JiuwenClaw listRuns failed for job", { adoptId, jobId: job.id, error: runResult.error });
            continue;
          }
          runs.push(...runResult.value.map((run) => ({ ...run, jobName: job.name })));
        }
        if (["ok", "error", "skipped", "timeout", "canceled"].includes(scope)) runs = runs.filter((r: any) => String(r?.status || "") === scope);
        runs.sort((a: any, b: any) => Date.parse(String(b?.startedAt || "")) - Date.parse(String(a?.startedAt || "")));
        const total = runs.length;
        return res.json({ runs: runs.slice(offset, offset + limit), total, limit, offset });
      }

      const handle = toOpenClawHandle(claw);

      const listed = await openClawCronProvider.listJobs(handle);
      if (!listed.ok) return res.status(providerErrorStatus(listed.error.kind)).json({ error: listed.error.detail });
      const targetJobs = jobId ? listed.value.filter((j) => String(j.id) === jobId) : listed.value;
      let runs: any[] = [];
      for (const job of targetJobs.slice(0, 50)) {
        const runResult = await openClawCronProvider.listRuns(handle, job.id, 100);
        if (!runResult.ok) {
          console.warn("[CRON-PROVIDER] listRuns failed for job", { adoptId, jobId: job.id, error: runResult.error });
          continue;
        }
        runs.push(...runResult.value.map((run) => ({ ...run, jobName: job.name })));
      }
      if (["ok", "error", "skipped", "timeout", "canceled"].includes(scope)) runs = runs.filter((r: any) => String(r?.status || "") === scope);
      runs.sort((a: any, b: any) => Date.parse(String(b?.startedAt || "")) - Date.parse(String(a?.startedAt || "")));
      const total = runs.length;
      return res.json({ runs: runs.slice(offset, offset + limit), total, limit, offset });
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message || e || "cron runs failed") });
    }
  });

  app.post("/api/claw/cron/preview-runs", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      if (isLegacyArchivedAdopt(adoptId)) return res.status(410).json({ error: "LEGACY_RUNTIME_ARCHIVED" });
      if (isJiuwenClawAdoptId(adoptId)) {
        const result = await jiuwenClawCronProvider.previewRuns({
          adoptId,
          schedule: req.body?.schedule,
          timezone: req.body?.timezone,
          count: req.body?.count || 5,
          wakeOffsetSeconds: req.body?.wakeOffsetSeconds,
        });
        if (!result.ok) return res.status(400).json({ error: result.error.detail });
        return res.json(result.value);
      }
      const result = await openClawCronProvider.previewRuns({
        adoptId,
        schedule: req.body?.schedule,
        timezone: req.body?.timezone,
        count: req.body?.count || 5,
        wakeOffsetSeconds: req.body?.wakeOffsetSeconds,
      });
      if (!result.ok) return res.status(400).json({ error: result.error.detail });
      return res.json(result.value);
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message || e || "preview runs failed") });
    }
  });

  app.post("/api/claw/cron/add", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      const job = req.body?.job || {};
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await resolveClaw(req, res, adoptId);
      if (!claw) return;

      if (isLegacyArchivedAdopt(adoptId)) return res.status(410).json({ error: "LEGACY_RUNTIME_ARCHIVED" });

      if (isJiuwenClawAdoptId(adoptId)) {
        const handle = toJiuwenClawHandle(claw);
        const input = cronJobInputFromRequest(job);
        const availabilityError = unavailableDeliveryChannelError(
          input.delivery.targets[0].channelId,
          await capabilitiesForClaw(claw),
        );
        if (availabilityError) return res.status(400).json({ error: availabilityError });
        const existing = await jiuwenClawCronProvider.listJobs(handle);
        if (existing.ok && existing.value.length >= 5) {
          return res.status(400).json({ error: `每个智能体最多 5 个定时任务，当前已有 ${existing.value.length} 个` });
        }
        const result = await jiuwenClawCronProvider.addJob(handle, input);
        if (!result.ok) return res.status(providerErrorStatus(result.error.kind)).json({ error: result.error.detail });
        const target = input.delivery.targets[0];
        if (target?.channelId) {
          await saveCronDeliveryConfig(adoptId, result.value.name || input.name, target.channelId, result.value.id);
        }
        return res.json({ runtime: "jiuwenclaw", job: result.value });
      }

      const handle = toOpenClawHandle(claw);
      const input = cronJobInputFromRequest(job);
      const safetyError = validateCronInputSafety(input);
      if (safetyError) return res.status(400).json({ error: safetyError });
      const availabilityError = unavailableDeliveryChannelError(
        input.delivery.targets[0].channelId,
        await capabilitiesForClaw(claw),
      );
      if (availabilityError) return res.status(400).json({ error: availabilityError });

      const existing = await openClawCronProvider.listJobs(handle);
      if (existing.ok && existing.value.length >= 5) {
        return res.status(400).json({ error: `每个智能体最多 5 个定时任务，当前已有 ${existing.value.length} 个` });
      }

      const result = await openClawCronProvider.addJob(handle, input);
      if (!result.ok) return res.status(providerErrorStatus(result.error.kind)).json({ error: result.error.detail });

      const target = input.delivery.targets[0];
      const deliveryManagedBy = String(result.value.meta?.deliveryManagedBy || "");
      try {
        if (target?.channelId && deliveryManagedBy !== "openclaw-native") {
          await saveCronDeliveryConfig(adoptId, result.value.name || input.name, target.channelId, result.value.id);
        }
      } catch (saveError: any) {
        console.error("[CRON] failed to save Lingxia delivery config after cron.add; rolling back OpenClaw job", {
          adoptId,
          jobId: result.value.id,
          error: saveError?.message || String(saveError),
        });
        const rollback = await openClawCronProvider.removeJob(handle, result.value.id);
        if (!rollback.ok) {
          console.error("[CRON-ORPHAN] rollback removeJob failed after delivery config save error", {
            adoptId,
            jobId: result.value.id,
            error: rollback.error,
          });
        }
        return res.status(500).json({ error: "定时任务创建失败：投递配置保存失败，已回滚任务" });
      }
      return res.json({ runtime: "openclaw", job: result.value });
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message || e || "cron add failed") });
    }
  });

  app.post("/api/claw/cron/update", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      const id = String(req.body?.id || "").trim();
      const patch = req.body?.patch || {};
      if (!adoptId || !id) return res.status(400).json({ error: "adoptId and id required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;

      if (isLegacyArchivedAdopt(adoptId)) return res.status(410).json({ error: "LEGACY_RUNTIME_ARCHIVED" });

      if (isJiuwenClawAdoptId(adoptId)) {
        if (patch.delivery !== undefined) {
          const target = cronDeliveryFromRequest(patch.delivery).targets[0];
          const availabilityError = unavailableDeliveryChannelError(target.channelId, await capabilitiesForClaw(claw));
          if (availabilityError) return res.status(400).json({ error: availabilityError });
        }
        const result = await jiuwenClawCronProvider.updateJob(toJiuwenClawHandle(claw), id, patch);
        if (!result.ok) return res.status(providerErrorStatus(result.error.kind)).json({ error: result.error.detail });
        return res.json({ runtime: "jiuwenclaw", job: result.value });
      }

      if (patch.delivery !== undefined) {
        const target = cronDeliveryFromRequest(patch.delivery).targets[0];
        const availabilityError = unavailableDeliveryChannelError(target.channelId, await capabilitiesForClaw(claw));
        if (availabilityError) return res.status(400).json({ error: availabilityError });
      }
      const result = await openClawCronProvider.updateJob(toOpenClawHandle(claw), id, patch);
      if (!result.ok) return res.status(providerErrorStatus(result.error.kind)).json({ error: result.error.detail });
      if (patch.delivery !== undefined) {
        const target = cronDeliveryFromRequest(patch.delivery).targets[0];
        const deliveryManagedBy = String(result.value.meta?.deliveryManagedBy || "");
        if (deliveryManagedBy === "openclaw-native") {
          await deleteCronDeliveryConfig(adoptId, id);
        } else if (target?.channelId) {
          await saveCronDeliveryConfig(adoptId, result.value.name, target.channelId, id);
        }
      }
      return res.json({ runtime: "openclaw", job: result.value });
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message || e || "cron update failed") });
    }
  });

  app.post("/api/claw/cron/run", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      const id = String(req.body?.id || "").trim();
      if (!adoptId || !id) return res.status(400).json({ error: "adoptId and id required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;

      if (isLegacyArchivedAdopt(adoptId)) return res.status(410).json({ error: "LEGACY_RUNTIME_ARCHIVED" });

      if (isJiuwenClawAdoptId(adoptId)) {
        const result = await jiuwenClawCronProvider.runJobNow(toJiuwenClawHandle(claw), id);
        if (!result.ok) return res.status(providerErrorStatus(result.error.kind)).json({ error: result.error.detail });
        return res.json({ runtime: "jiuwenclaw", ok: true, ...result.value, watcher: "unsupported" });
      }

      const handle = toOpenClawHandle(claw);
      const listed = await openClawCronProvider.listJobs(handle);
      const job = listed.ok ? listed.value.find((item) => item.id === id) : undefined;
      const startedAtMs = Date.now();
      const result = await openClawCronProvider.runJobNow(handle, id);
      if (!result.ok) return res.status(providerErrorStatus(result.error.kind)).json({ error: result.error.detail });

      startCronRunWatcher({
        adoptId,
        jobId: id,
        jobName: job?.name || id,
        runId: result.value.runId,
        startedAtMs,
      }).catch((error: any) => {
        console.warn("[CRON-WATCHER] failed after cron.run response", {
          adoptId,
          jobId: id,
          runId: result.value.runId,
          error: error?.message || String(error),
        });
      });
      return res.json({ runtime: "openclaw", ok: true, ...result.value, watcher: "started" });
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message || e || "cron run failed") });
    }
  });

  app.post("/api/claw/cron/remove", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      const id = String(req.body?.id || "").trim();
      if (!adoptId || !id) return res.status(400).json({ error: "adoptId and id required" });
      const claw = await resolveClaw(req, res, adoptId);
      if (!claw) return;

      if (isLegacyArchivedAdopt(adoptId)) return res.status(410).json({ error: "LEGACY_RUNTIME_ARCHIVED" });

      if (isJiuwenClawAdoptId(adoptId)) {
        const result = await jiuwenClawCronProvider.removeJob(toJiuwenClawHandle(claw), id);
        if (!result.ok) return res.status(providerErrorStatus(result.error.kind)).json({ error: result.error.detail });
        await deleteCronDeliveryConfig(adoptId, id);
        return res.json({ runtime: "jiuwenclaw", ok: true });
      }

      const result = await openClawCronProvider.removeJob(toOpenClawHandle(claw), id);
      if (!result.ok) return res.status(providerErrorStatus(result.error.kind)).json({ error: result.error.detail });
      await deleteCronDeliveryConfig(adoptId, id);
      return res.json({ runtime: "openclaw", ok: true });
    } catch (e: any) {
      return res.status(500).json({ error: String(e?.message || e || "cron remove failed") });
    }
  });
}
