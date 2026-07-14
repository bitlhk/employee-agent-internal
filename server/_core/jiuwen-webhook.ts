import { randomUUID } from "crypto";
import express from "express";
import { getClawByAdoptId } from "../db";
import {
  findJiuwenCronRouteMeta,
  findJiuwenCronRunRouteMeta,
  recordJiuwenCronRun,
  updateJiuwenCronRunDelivery,
} from "./cron/jiuwenclaw-cron-provider";
import { getChannelProvider, normalizeChannelId } from "./cron/channel-provider-registry";
import { isAuthorizedInternalRequest } from "./helpers";

type JiuwenCallbackBody = {
  content?: unknown;
  session_id?: unknown;
  message_id?: unknown;
  timestamp?: unknown;
  ok?: unknown;
  cron?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

function expectedToken(): string {
  return String(
    process.env.WORKFORCE_AGENT_JIUWEN_WEBHOOK_TOKEN
      || process.env.JIUWEN_WEBHOOK_TOKEN
      || process.env.LINGGAN_JIUWEN_WEBHOOK_TOKEN
      || process.env.INTERNAL_API_KEY
      || "",
  ).trim();
}

function isPlaceholder(body: JiuwenCallbackBody): boolean {
  return Boolean((body.cron || {}).is_placeholder);
}

function textContent(body: JiuwenCallbackBody): string {
  return String(body.content || "").trim();
}

function normalizeCronCallbackContent(content: string): {
  statusOverride?: "error";
  output: string;
  errorMessage?: string;
} {
  const text = String(content || "").trim();
  const isInterrupt = /["']result_type["']\s*:\s*["']interrupt["']/.test(text)
    || (text.includes("interrupt_ids") && text.includes("__interaction__"));
  if (!isInterrupt) return { output: text };
  const output = [
    "定时任务执行时触发了工具权限审批，后台任务无法继续自动执行。",
    "建议调整任务提示词，避免使用需要人工审批的工具；或在确认安全后调整 JiuwenSwarm 的工具权限策略。",
  ].join("\n");
  return {
    statusOverride: "error",
    output,
    errorMessage: output,
  };
}

function callbackMeta(body: JiuwenCallbackBody): Record<string, unknown> {
  const metadata = body.metadata || {};
  const value = metadata.workforceAgent || metadata.agent || metadata.linggan;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cronTaskId(cron: Record<string, unknown>): string {
  return String(cron.task_id || cron.job_id || cron.id || cron.schedule_id || "").trim();
}

function callbackDelivery(meta: Record<string, unknown>, fallbackChannel?: unknown) {
  const rawDelivery = meta.delivery;
  const delivery = rawDelivery && typeof rawDelivery === "object" && !Array.isArray(rawDelivery)
    ? rawDelivery as Record<string, unknown>
    : {};
  return {
    channelId: normalizeChannelId(String(delivery.channelId || delivery.channel_id || fallbackChannel || "web")) || "web",
    targetId: String(delivery.targetId || delivery.target_id || "").trim() || undefined,
    targetLabel: String(delivery.targetLabel || delivery.target_label || "").trim() || undefined,
  };
}

export function registerJiuwenWebhookRoutes(app: express.Express) {
  const callback = async (req: express.Request, res: express.Response) => {
    try {
      if (!isAuthorizedInternalRequest(req, expectedToken())) {
        return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
      }

      const body = (req.body || {}) as JiuwenCallbackBody;
      const content = textContent(body);
      const meta = callbackMeta(body);
      const cron = body.cron || {};
      const taskId = cronTaskId(cron);
      const runId = String(cron.run_id || body.message_id || randomUUID()).trim();
      const routeMetaByTask = taskId ? findJiuwenCronRouteMeta(taskId) : null;
      const routeMetaByRun = taskId ? findJiuwenCronRunRouteMeta(taskId, runId) : null;
      const adoptId = String(meta.adoptId || meta.adopt_id || routeMetaByTask?.adoptId || routeMetaByRun?.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ ok: false, error: "adoptId required" });
      if (!taskId) return res.status(400).json({ ok: false, error: "task_id required" });

      const claw = await getClawByAdoptId(adoptId);
      if (!claw) return res.status(404).json({ ok: false, error: "agent not found" });

      const timestamp = Number(body.timestamp || 0);
      const normalized = normalizeCronCallbackContent(content);
      const status = isPlaceholder(body)
        ? "running"
        : normalized.statusOverride
          ? normalized.statusOverride
          : body.ok === false
          ? "error"
          : "ok";
      if (!content && status !== "running") return res.status(400).json({ ok: false, error: "content required" });
      const delivery = callbackDelivery(meta, routeMetaByTask?.channelId);
      const externalDeliveryPending = status === "ok" && delivery.channelId !== "web";
      const result = recordJiuwenCronRun({
        adoptId,
        taskId,
        runId,
        status,
        output: normalized.output || undefined,
        errorMessage: status === "error" ? normalized.errorMessage || normalized.output || "Jiuwen cron callback failed" : undefined,
        triggeredBy: "schedule",
        startedAt: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp).toISOString() : undefined,
        finishedAt: status === "running" ? undefined : new Date().toISOString(),
        deliveryStatus: externalDeliveryPending ? "pending" : undefined,
      });

      if (externalDeliveryPending && !result.duplicate) {
        setImmediate(() => {
          const provider = getChannelProvider(delivery.channelId);
          if (!provider) {
            updateJiuwenCronRunDelivery({
              adoptId,
              taskId,
              runId,
              deliveryStatus: "failed",
              deliveryTargetMasked: delivery.targetLabel,
            });
            console.warn("[JIUWEN-WEBHOOK] delivery provider missing", { adoptId, taskId, channelId: delivery.channelId });
            return;
          }
          void provider.send(
            {
              adoptId,
              channelId: delivery.channelId,
              userId: Number((claw as any).userId || 0),
              targetId: delivery.targetId,
            },
            {
              title: routeMetaByTask?.name ? `定时任务「${routeMetaByTask.name}」` : "定时任务结果",
              text: normalized.output,
              format: "text",
              metadata: { taskId, runId },
            },
          ).then((sent) => {
            updateJiuwenCronRunDelivery({
              adoptId,
              taskId,
              runId,
              deliveryStatus: sent.ok ? "ok" : "failed",
              deliveryTargetMasked: delivery.targetLabel,
            });
            if (!sent.ok) {
              console.warn("[JIUWEN-WEBHOOK] delivery failed", {
                adoptId,
                taskId,
                channelId: delivery.channelId,
                error: sent.error.kind,
              });
            }
          }).catch((error: any) => {
            updateJiuwenCronRunDelivery({ adoptId, taskId, runId, deliveryStatus: "failed" });
            console.warn("[JIUWEN-WEBHOOK] delivery failed", {
              adoptId,
              taskId,
              channelId: delivery.channelId,
              error: error?.message || String(error),
            });
          });
        });
      }
      return res.json({
        ok: true,
        recorded: result.recorded,
        duplicate: result.duplicate,
        adoptId,
        taskId,
        runId,
        delivery: externalDeliveryPending ? (result.duplicate ? "duplicate" : "queued") : "recorded",
      });
    } catch (error: any) {
      console.error("[JIUWEN-WEBHOOK] callback failed", error?.message || error);
      return res.status(500).json({ ok: false, error: error?.message || "callback failed" });
    }
  };

  app.post("/api/internal/jiuwen/callback", callback);
  app.post("/api/internal/jiuwen/linggan/callback", callback);
}
