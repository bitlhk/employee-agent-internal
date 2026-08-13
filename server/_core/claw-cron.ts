import express from "express";
import type { CronJobInput, CronProviderHandle, CronSchedule } from "@shared/types/cron";
import type { ClawAdoption } from "../../drizzle/schema";
import {
  isAuthorizedInternalRequest,
  isJiuwenClawAdoptId,
  requireClawOwner,
  resolveRuntimeAgentId,
} from "./helpers";
import { JiuwenClawCronProvider } from "./cron/jiuwenclaw-cron-provider";
import {
  resolveCronCapabilities,
  unavailableDeliveryChannelError,
} from "./cron/channel-capabilities";
import { deleteCronDeliveryConfig, saveCronDeliveryConfig } from "./cron-delivery";
import { normalizeChannelId } from "./cron/channel-provider-registry";
import {
  createCronJobIdempotently,
  normalizeCronIdempotencyKey,
} from "./cron/cron-idempotency";
import { withCronCreationScopeLock } from "../db/cron-job-creations";
import { stableToolInputHash } from "./tool-governance";
import { authorizeClawRouteExecution } from "./governance/claw-route-execution-authority";

const cronProvider = new JiuwenClawCronProvider();

function isLegacyArchivedAdopt(adoptId: string): boolean {
  return !isJiuwenClawAdoptId(String(adoptId || ""));
}

function archivedRuntimeResponse(res: express.Response) {
  return res.status(410).json({ error: "LEGACY_RUNTIME_ARCHIVED" });
}

function archivedRuntimeError() {
  return Object.assign(new Error("Legacy runtime has been archived"), { status: 410 });
}

function toCronHandle(claw: ClawAdoption): CronProviderHandle {
  const adoptId = String(claw.adoptId || "");
  return {
    adoptId,
    agentId: resolveRuntimeAgentId(adoptId, String(claw.agentId || "")),
    userId: Number(claw.userId || 0),
    runtime: "jiuwenclaw",
  };
}

async function capabilitiesForClaw(claw: ClawAdoption) {
  const adoptId = String(claw?.adoptId || "").trim();
  return resolveCronCapabilities(adoptId, cronProvider.capabilities());
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
    const intervalMinutes = Number(
      raw?.intervalMinutes || (raw?.everyMs ? Math.round(Number(raw.everyMs) / 60_000) : 0) || 30,
    );
    return { kind: "interval", intervalMinutes, display: `每 ${intervalMinutes} 分钟` };
  }
  if (kind === "once" || kind === "at") {
    const runAt = String(raw?.runAt || raw?.at || "");
    return { kind: "once", runAt, display: runAt };
  }
  const cronExpr = String(raw?.cronExpr || raw?.expr || "0 9 * * *");
  return { kind: "cron", cronExpr, display: raw?.display ? String(raw.display) : cronExpr };
}

function channelLabel(channelId: string) {
  if (channelId === "web") return "当前对话";
  if (channelId === "wechat") return "微信";
  if (channelId === "feishu") return "飞书";
  if (channelId === "dingtalk") return "钉钉";
  return "企业微信";
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
          channelLabel: first.channelLabel || channelLabel(channelId),
          targetId: first.targetId,
          targetLabel: first.targetLabel,
          format: first.format,
        }],
      };
    }
  }

  const rawChannel = String(
    raw?.channel || raw?.to || raw?.mode || (raw?.weixin ? "wechat" : ""),
  ).trim();
  const channelId = rawChannel === "conversation"
    ? "web"
    : rawChannel === "weixin"
      ? "wechat"
      : normalizeChannelId(rawChannel) || "web";
  return {
    targets: [{
      channelId,
      channelLabel: channelLabel(channelId),
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

async function authorizeCronMutation(input: {
  req: express.Request;
  claw: ClawAdoption;
  operation: string;
  resource: string;
  payload: unknown;
}) {
  return authorizeClawRouteExecution({
    req: input.req,
    claw: input.claw,
    source: "claw_cron_route",
    operation: {
      capabilityId: "cron.write",
      operation: input.operation,
      sideEffect: "write",
      resource: input.resource,
      payloadHash: stableToolInputHash(input.payload),
    },
  });
}

export async function listCronJobsForClaw(claw: ClawAdoption, options?: {
  limit?: number;
  offset?: number;
  query?: string;
  enabled?: string;
  scheduleKind?: string;
}) {
  const adoptId = String(claw?.adoptId || "").trim();
  if (isLegacyArchivedAdopt(adoptId)) throw archivedRuntimeError();

  const limit = Math.max(1, Math.min(200, Number(options?.limit || 20)));
  const offset = Math.max(0, Number(options?.offset || 0));
  const query = String(options?.query || "").trim().toLowerCase();
  const enabled = String(options?.enabled || "all");
  const scheduleKind = String(options?.scheduleKind || "all");
  const listed = await cronProvider.listJobs(toCronHandle(claw));
  if (!listed.ok) throw providerError(listed.error);

  let jobs = listed.value;
  if (query) {
    jobs = jobs.filter((job) =>
      String(job.name || "").toLowerCase().includes(query)
      || String(job.description || "").toLowerCase().includes(query)
    );
  }
  if (enabled === "enabled") jobs = jobs.filter((job) => job.enabled !== false);
  if (enabled === "disabled") jobs = jobs.filter((job) => job.enabled === false);
  if (["interval", "once", "cron"].includes(scheduleKind)) {
    jobs = jobs.filter((job) => String(job.schedule?.kind || "") === scheduleKind);
  }
  const total = jobs.length;
  return {
    runtime: "jiuwenclaw",
    capabilities: await capabilitiesForClaw(claw),
    jobs: jobs.slice(offset, offset + limit),
    total,
    limit,
    offset,
  };
}

export async function listCronRunsForClaw(claw: ClawAdoption, options?: {
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
  const handle = toCronHandle(claw);
  const listed = await cronProvider.listJobs(handle);
  if (!listed.ok) throw providerError(listed.error);

  const targetJobs = jobId ? listed.value.filter((job) => String(job.id) === jobId) : listed.value;
  let runs: any[] = [];
  for (const job of targetJobs.slice(0, 50)) {
    const runResult = await cronProvider.listRuns(handle, job.id, 100);
    if (!runResult.ok) {
      console.warn("[CRON-PROVIDER] JiuwenSwarm listRuns failed", {
        adoptId,
        jobId: job.id,
        error: runResult.error,
      });
      continue;
    }
    runs.push(...runResult.value.map((run) => ({ ...run, jobName: job.name })));
  }
  if (["ok", "error", "skipped", "timeout", "canceled"].includes(scope)) {
    runs = runs.filter((run) => String(run?.status || "") === scope);
  }
  runs.sort((a, b) => Date.parse(String(b?.startedAt || "")) - Date.parse(String(a?.startedAt || "")));
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
      if (isLegacyArchivedAdopt(adoptId)) return archivedRuntimeResponse(res);

      const listed = await cronProvider.listJobs(toCronHandle(claw));
      if (!listed.ok) {
        return res.status(providerErrorStatus(listed.error.kind)).json({ error: listed.error.detail });
      }
      const enabled = listed.value.filter((job) => job.enabled);
      const nextRunIso = enabled.map((job) => job.state.nextRunAt).filter(Boolean).sort()[0];
      return res.json({
        enabled: true,
        runtime: "jiuwenclaw",
        jobs: listed.value.length,
        enabledJobs: enabled.length,
        nextRunAt: nextRunIso || undefined,
        nextWakeAtMs: nextRunIso ? new Date(nextRunIso).getTime() : undefined,
      });
    } catch (error: any) {
      return res.status(500).json({ error: String(error?.message || error || "cron status failed") });
    }
  });

  app.get("/api/claw/cron/capabilities", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      if (isLegacyArchivedAdopt(adoptId)) return archivedRuntimeResponse(res);
      return res.json({ runtime: "jiuwenclaw", capabilities: await capabilitiesForClaw(claw) });
    } catch (error: any) {
      return res.status(500).json({ error: String(error?.message || error || "capabilities failed") });
    }
  });

  app.get("/api/claw/cron/list", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await resolveClaw(req, res, adoptId);
      if (!claw) return;
      if (isLegacyArchivedAdopt(adoptId)) return archivedRuntimeResponse(res);
      return res.json(await listCronJobsForClaw(claw, {
        limit: Number(req.query.limit || 20),
        offset: Number(req.query.offset || 0),
        query: String(req.query.query || ""),
        enabled: String(req.query.enabled || "all"),
        scheduleKind: String(req.query.scheduleKind || "all"),
      }));
    } catch (error: any) {
      return res.status(Number(error?.status || 500)).json({ error: String(error?.message || error || "cron list failed") });
    }
  });

  app.get("/api/claw/cron/runs", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await resolveClaw(req, res, adoptId);
      if (!claw) return;
      if (isLegacyArchivedAdopt(adoptId)) return archivedRuntimeResponse(res);
      return res.json(await listCronRunsForClaw(claw, {
        limit: Number(req.query.limit || 20),
        offset: Number(req.query.offset || 0),
        jobId: String(req.query.jobId || ""),
        scope: String(req.query.scope || "all"),
      }));
    } catch (error: any) {
      return res.status(Number(error?.status || 500)).json({ error: String(error?.message || error || "cron runs failed") });
    }
  });

  app.post("/api/claw/cron/preview-runs", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      if (isLegacyArchivedAdopt(adoptId)) return archivedRuntimeResponse(res);
      const result = await cronProvider.previewRuns({
        adoptId,
        schedule: req.body?.schedule,
        timezone: req.body?.timezone,
        count: req.body?.count || 5,
        wakeOffsetSeconds: req.body?.wakeOffsetSeconds,
      });
      if (!result.ok) return res.status(400).json({ error: result.error.detail });
      return res.json(result.value);
    } catch (error: any) {
      return res.status(500).json({ error: String(error?.message || error || "preview runs failed") });
    }
  });

  app.post("/api/claw/cron/add", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      const job = req.body?.job || {};
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await resolveClaw(req, res, adoptId);
      if (!claw) return;
      if (isLegacyArchivedAdopt(adoptId)) return archivedRuntimeResponse(res);

      const handle = toCronHandle(claw);
      const input = cronJobInputFromRequest(job);
      const authority = await authorizeCronMutation({
        req,
        claw,
        operation: "create_cron_job",
        resource: `cron:${input.name}`,
        payload: input,
      });
      if (!authority.allowed) {
        return res.status(403).json({ error: authority.reason, code: authority.policyCode });
      }
      input.meta = {
        ...(input.meta || {}),
        taskAuthorizationSnapshotId: authority.taskSnapshotId,
        executionAuthorityFingerprint: authority.effectiveAuthorityFingerprint,
      };
      const idempotencyKey = normalizeCronIdempotencyKey(
        req.get("Idempotency-Key") || req.body?.idempotencyKey || req.body?.idempotency_key,
      );
      const availabilityError = unavailableDeliveryChannelError(
        input.delivery.targets[0].channelId,
        await capabilitiesForClaw(claw),
      );
      if (availabilityError) return res.status(400).json({ error: availabilityError });
      const creation = await createCronJobIdempotently({
        adoptId,
        idempotencyKey,
        input,
        create: () => withCronCreationScopeLock(adoptId, async () => {
          const existing = await cronProvider.listJobs(handle);
          if (existing.ok && existing.value.length >= 5) {
            throw Object.assign(new Error(
              `每个智能体最多 5 个定时任务，当前已有 ${existing.value.length} 个`,
            ), { status: 400, code: "CRON_LIMIT_EXCEEDED" });
          }
          const result = await cronProvider.addJob(handle, input);
          if (!result.ok) throw providerError(result.error);
          return result.value;
        }),
      });
      const target = input.delivery.targets[0];
      if (target?.channelId) {
        await saveCronDeliveryConfig(adoptId, creation.job.name || input.name, target.channelId, creation.job.id);
      }
      return res.json({ runtime: "jiuwenclaw", job: creation.job, reused: creation.reused });
    } catch (error: any) {
      return res.status(Number(error?.status || 500)).json({
        error: String(error?.message || error || "cron add failed"),
        ...(error?.code ? { code: String(error.code) } : {}),
      });
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
      if (isLegacyArchivedAdopt(adoptId)) return archivedRuntimeResponse(res);

      const authority = await authorizeCronMutation({
        req,
        claw,
        operation: "update_cron_job",
        resource: `cron:${id}`,
        payload: patch,
      });
      if (!authority.allowed) {
        return res.status(403).json({ error: authority.reason, code: authority.policyCode });
      }

      let deliveryTarget: CronJobInput["delivery"]["targets"][number] | undefined;
      if (patch.delivery !== undefined) {
        deliveryTarget = cronDeliveryFromRequest(patch.delivery).targets[0];
        const availabilityError = unavailableDeliveryChannelError(
          deliveryTarget.channelId,
          await capabilitiesForClaw(claw),
        );
        if (availabilityError) return res.status(400).json({ error: availabilityError });
        patch.delivery = { targets: [deliveryTarget] };
      }
      const result = await cronProvider.updateJob(toCronHandle(claw), id, patch);
      if (!result.ok) {
        return res.status(providerErrorStatus(result.error.kind)).json({ error: result.error.detail });
      }
      if (deliveryTarget?.channelId) {
        await saveCronDeliveryConfig(adoptId, result.value.name, deliveryTarget.channelId, id);
      }
      return res.json({ runtime: "jiuwenclaw", job: result.value });
    } catch (error: any) {
      return res.status(500).json({ error: String(error?.message || error || "cron update failed") });
    }
  });

  app.post("/api/claw/cron/run", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      const id = String(req.body?.id || "").trim();
      if (!adoptId || !id) return res.status(400).json({ error: "adoptId and id required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      if (isLegacyArchivedAdopt(adoptId)) return archivedRuntimeResponse(res);

      const authority = await authorizeCronMutation({
        req,
        claw,
        operation: "run_cron_job",
        resource: `cron:${id}`,
        payload: { id },
      });
      if (!authority.allowed) {
        return res.status(403).json({ error: authority.reason, code: authority.policyCode });
      }

      const result = await cronProvider.runJobNow(toCronHandle(claw), id);
      if (!result.ok) {
        return res.status(providerErrorStatus(result.error.kind)).json({ error: result.error.detail });
      }
      return res.json({ runtime: "jiuwenclaw", ok: true, ...result.value, watcher: "unsupported" });
    } catch (error: any) {
      return res.status(500).json({ error: String(error?.message || error || "cron run failed") });
    }
  });

  app.post("/api/claw/cron/remove", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      const id = String(req.body?.id || "").trim();
      if (!adoptId || !id) return res.status(400).json({ error: "adoptId and id required" });
      const claw = await resolveClaw(req, res, adoptId);
      if (!claw) return;
      if (isLegacyArchivedAdopt(adoptId)) return archivedRuntimeResponse(res);

      const authority = await authorizeCronMutation({
        req,
        claw,
        operation: "remove_cron_job",
        resource: `cron:${id}`,
        payload: { id },
      });
      if (!authority.allowed) {
        return res.status(403).json({ error: authority.reason, code: authority.policyCode });
      }

      const result = await cronProvider.removeJob(toCronHandle(claw), id);
      if (!result.ok) {
        return res.status(providerErrorStatus(result.error.kind)).json({ error: result.error.detail });
      }
      await deleteCronDeliveryConfig(adoptId, id);
      return res.json({ runtime: "jiuwenclaw", ok: true });
    } catch (error: any) {
      return res.status(500).json({ error: String(error?.message || error || "cron remove failed") });
    }
  });
}
