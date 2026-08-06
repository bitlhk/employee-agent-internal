import type { Express } from "express";
import { listMyCoopSessions } from "../db/coop";
import { listCronJobsForClaw, listCronRunsForClaw } from "./claw-cron";
import { listClawChatHistorySessionRecords } from "./chat-history";
import { requireClawOwner } from "./helpers";
import { sdk } from "./sdk";

type EaSessionKind = "chat" | "cron" | "coop";
type EaSessionSurface = "ea-web" | "jiuwen" | "cron" | "coop";

type EaSessionView = {
  id: string;
  kind: EaSessionKind;
  surface: EaSessionSurface;
  agentId: string;
  effectiveAgentId: string;
  conversationId?: string;
  sessionKey?: string;
  sessionId?: string;
  jiuwenSessionId?: string;
  runtimeSessionKey?: string;
  cronTaskId?: string;
  cronRunId?: string;
  coopSessionId?: string;
  title: string;
  subtitle?: string;
  preview?: string;
  createdAt?: number;
  updatedAt: number;
  sourceUpdatedAt: number;
  sortUpdatedAt: number;
  messageCount: number;
  interactive: boolean;
  status?: "idle" | "running" | "failed" | "done";
  attention?: "running" | "needs_action" | "failed";
  route: string;
};

function numberValue(value: unknown, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function timeValue(value: unknown, fallback = 0) {
  if (typeof value === "number") return numberValue(value, fallback);
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function compactText(value: unknown, fallback = "") {
  return String(value || fallback).replace(/\s+/g, " ").trim();
}

function cronStatus(status: unknown): EaSessionView["status"] {
  const text = String(status || "").toLowerCase();
  if (text === "running") return "running";
  if (text === "failed" || text === "error" || text === "timeout") return "failed";
  if (text === "completed" || text === "ok" || text === "canceled" || text === "cancelled") return "done";
  return "idle";
}

function normalizeChatSession(adoptId: string, item: any): EaSessionView {
  const conversationId = String(item?.conversationId || "");
  const title = compactText(item?.title, "新对话");
  const updatedAt = numberValue(item?.updatedAt, Date.now());
  const createdAt = numberValue(item?.createdAt, updatedAt);
  const sessionId = String(item?.sessionId || "");
  const sessionKey = item?.sessionKey ? String(item.sessionKey) : "";
  const isJiuwen = sessionId.startsWith("sess_") || String(item?.sessionKey || "").includes(":web:");
  return {
    id: `chat:${adoptId}:${conversationId || sessionId || item?.sessionKey || updatedAt}`,
    kind: "chat",
    surface: isJiuwen ? "jiuwen" : "ea-web",
    agentId: adoptId,
    effectiveAgentId: adoptId,
    conversationId,
    sessionKey: sessionKey || undefined,
    sessionId: sessionId || undefined,
    jiuwenSessionId: sessionId || undefined,
    runtimeSessionKey: sessionKey || undefined,
    title,
    subtitle: "主对话",
    preview: compactText(item?.preview),
    createdAt,
    updatedAt,
    sourceUpdatedAt: updatedAt,
    sortUpdatedAt: updatedAt,
    messageCount: numberValue(item?.messageCount, 0),
    interactive: true,
    status: "idle",
    ...(item?.attention ? { attention: item.attention } : {}),
    route: `/claw/${encodeURIComponent(adoptId)}?conversation=${encodeURIComponent(conversationId)}`,
  };
}

function normalizeCronSession(adoptId: string, job: any, latestRun: any | undefined): EaSessionView {
  const jobId = String(job?.id || "");
  const latestRunAt = timeValue(latestRun?.startedAt || latestRun?.finishedAt, 0);
  const updatedAt = Math.max(
    timeValue(job?.updatedAt || job?.createdAt, 0),
    timeValue(job?.state?.lastRunAt, 0),
    latestRunAt
  );
  const title = compactText(job?.name, "定时任务");
  const runStatus = latestRun?.status || job?.state?.lastStatus || job?.state?.status;
  return {
    id: `cron:${adoptId}:${jobId}`,
    kind: "cron",
    surface: "cron",
    agentId: adoptId,
    effectiveAgentId: adoptId,
    cronTaskId: jobId,
    cronRunId: latestRun?.id ? String(latestRun.id) : undefined,
    title,
    subtitle: job?.enabled === false ? "已暂停" : "定时任务",
    preview: compactText(latestRun?.output || latestRun?.summary || latestRun?.errorMessage || job?.description || job?.prompt),
    updatedAt: updatedAt || Date.now(),
    sourceUpdatedAt: updatedAt || Date.now(),
    sortUpdatedAt: updatedAt || Date.now(),
    messageCount: latestRun ? 1 : 0,
    interactive: false,
    status: cronStatus(runStatus),
    route: `/scheduled-tasks?task=${encodeURIComponent(jobId)}`,
  };
}

function normalizeCoopSession(item: any): EaSessionView {
  const id = String(item?.id || "");
  const createdAt = timeValue(item?.created_at || item?.createdAt, Date.now());
  const publishedAt = timeValue(item?.published_at || item?.publishedAt, 0);
  const updatedAt = publishedAt || createdAt;
  const totalMembers = numberValue(item?.total_members ?? item?.member_count, 0);
  const completedMembers = numberValue(item?.completed_members, 0);
  const pendingMembers = numberValue(item?.pending_members, 0);
  const status = String(item?.status || "running");
  return {
    id: `coop:${id}`,
    kind: "coop",
    surface: "coop",
    agentId: String(item?.creator_adopt_id || ""),
    effectiveAgentId: String(item?.creator_adopt_id || ""),
    coopSessionId: id,
    title: compactText(item?.title, "未命名协作"),
    subtitle: item?.i_am_creator ? "我发起的协作" : "我参与的协作",
    preview: totalMembers > 0
      ? `成员 ${completedMembers}/${totalMembers}${pendingMembers > 0 ? `，待回复 ${pendingMembers}` : ""}`
      : compactText(item?.creator_name),
    createdAt,
    updatedAt,
    sourceUpdatedAt: updatedAt,
    sortUpdatedAt: updatedAt,
    messageCount: totalMembers,
    interactive: true,
    status: status === "completed" || status === "closed" ? "done" : status === "failed" ? "failed" : "running",
    route: `/collab/${encodeURIComponent(id)}`,
  };
}

export function registerEaSessionViewRoutes(app: Express) {
  app.get("/api/ea/session-view/chat", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      const limit = Math.max(1, Math.min(100, Number(req.query.limit || 60)));
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });

      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const payload = await listClawChatHistorySessionRecords({ adoptId, claw, limit });

      const rawSessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
      const sessions = rawSessions
        .map((item: any) => normalizeChatSession(adoptId, item))
        .filter((item: EaSessionView) => item.conversationId && item.messageCount > 0)
        .sort((a: EaSessionView, b: EaSessionView) => b.updatedAt - a.updatedAt)
        .slice(0, limit);

      return res.json({
        sessions,
        rawSessions,
        meta: {
          ...(payload?.meta || {}),
          contract: "ea-session-view-v1",
          source: "chat-history",
          kind: "chat",
        },
      });
    } catch (error: any) {
      return res.status(500).json({ error: String(error?.message || error || "chat session view failed") });
    }
  });

  app.get("/api/ea/session-view/cron", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      const limit = Math.max(1, Math.min(200, Number(req.query.limit || 100)));
      const jobId = String(req.query.jobId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });

      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const [jobsResult, runsResult] = await Promise.all([
        listCronJobsForClaw(claw, { limit }),
        listCronRunsForClaw(claw, { limit, jobId }),
      ]);

      const jobs = Array.isArray(jobsResult?.jobs) ? jobsResult.jobs : [];
      const runs = Array.isArray(runsResult?.runs) ? runsResult.runs : [];
      const latestRunByJob = new Map<string, any>();
      for (const run of runs) {
        const id = String(run?.jobId || "");
        if (!id) continue;
        const previous = latestRunByJob.get(id);
        if (!previous || timeValue(run?.startedAt) > timeValue(previous?.startedAt)) {
          latestRunByJob.set(id, run);
        }
      }
      const sessions = jobs
        .map((job: any) => normalizeCronSession(adoptId, job, latestRunByJob.get(String(job?.id || ""))))
        .sort((a: EaSessionView, b: EaSessionView) => b.updatedAt - a.updatedAt);

      return res.json({
        sessions,
        jobs,
        runs,
        runtime: jobsResult?.runtime,
        capabilities: jobsResult?.capabilities,
        total: jobsResult?.total,
        limit,
        offset: jobsResult?.offset || 0,
        meta: {
          contract: "ea-session-view-v1",
          source: "cron",
          kind: "cron",
        },
      });
    } catch (error: any) {
      return res.status(Number(error?.status || 500)).json({ error: String(error?.message || error || "cron session view failed") });
    }
  });

  app.get("/api/ea/session-view/coop", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      const limit = Math.max(1, Math.min(200, Number(req.query.limit || 80)));
      const rawSessions = await listMyCoopSessions(user.id, limit);
      const sessions = rawSessions
        .map((item: any) => normalizeCoopSession(item))
        .sort((a: EaSessionView, b: EaSessionView) => b.updatedAt - a.updatedAt)
        .slice(0, limit);

      return res.json({
        sessions,
        rawSessions,
        meta: {
          contract: "ea-session-view-v1",
          source: "coop",
          kind: "coop",
        },
      });
    } catch (error: any) {
      const message = String(error?.message || "");
      const status = message.includes("Unauthorized") || message.includes("Invalid session cookie")
        ? 401
        : Number(error?.status || 500);
      return res.status(status).json({ error: String(error?.message || error || "coop session view failed") });
    }
  });
}
