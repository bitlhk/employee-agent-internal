import express from "express";
import { COOKIE_NAME } from "@shared/const";
import { existsSync, readFileSync, readdirSync, writeFileSync, rmSync, statSync } from "fs";
import path from "path";
import { strictLimiter } from "./security";
import {
  APP_ROOT,
  buildSessionRegistryScope,
  isJiuwenClawAdoptId,
  jiuwenClawAgentId,
  readSessionEpoch,
  resolveRuntimeWorkspace,
  requireClawOwner,
  upsertSessionRegistry,
} from "./helpers";
import { createContext } from "./context";
import { adminMfaWriteAccess } from "./admin-mfa-policy";
import { clearSessionCookieVariants, setLogoutLockCookieVariants } from "./cookies";
import { sessionAuthVersion } from "./sdk";
import { skillInstaller } from "./skills/skill-installer";
import { MAX_SKILL_PACKAGE_BYTES, parseSkillPackageBuffer } from "./skills/skill-source";
import { skillStoreMarketplaceDir } from "./skills/skill-store";
import { scanUploadForMalware } from "./upload-security";
import {
  deleteAgentTasksByConversation,
  listAgentTasksByConversation,
} from "../db/agents";
import {
  buildExpertTaskHistoryMessages,
  expertConversationIdFromSessionKey,
} from "./expert-task-history";
import { logError, logInfo } from "./observability/logger";
import { resolveEaAssistantModelConfig } from "./ea-assistant-model";
import { fetchWithTimeout } from "./fetch-timeout";

import {
  addJiuwenUsageEvents,
  addUsageEvent,
  bindHistoryAttachmentOwner,
  dedupeHistoryMessages,
  deleteJiuwenHistorySession,
  invalidateChatHistorySessionList,
  listClawChatHistorySessionRecords,
  logIosLoadDebug,
  mergeJiuwenHistoryCandidates,
  resolveJiuwenHistorySession,
  type UsageBucket,
} from "./chat-history";
import {
  beginChatSessionDeletion,
  endChatSessionDeletion,
  makeChatLifecycleKey,
  waitForChatSessionIdle,
} from "./chat-inflight";

function activeConversationTask(tasks: any[]): any | undefined {
  return tasks.find((task) => {
    const status = String(task?.status || "").toLowerCase();
    const interactionStatus = String(task?.interactionStatus || task?.interaction_status || "").toLowerCase();
    return status === "pending" || status === "running" || interactionStatus === "pending";
  });
}

async function prepareConversationDeletion(args: {
  adoptId: string;
  conversationId: string;
}): Promise<
  | { ok: true; lifecycleKey: string }
  | { ok: false; status: number; error: string; message: string }
> {
  const lifecycleKey = makeChatLifecycleKey(args.adoptId, args.conversationId);
  if (!beginChatSessionDeletion(lifecycleKey)) {
    return {
      ok: false,
      status: 409,
      error: "SESSION_DELETING",
      message: "该会话正在删除，请稍后再试",
    };
  }

  try {
    const idle = await waitForChatSessionIdle(lifecycleKey, 5_000);
    if (!idle) {
      endChatSessionDeletion(lifecycleKey);
      return {
        ok: false,
        status: 409,
        error: "SESSION_BUSY",
        message: "该会话仍在生成回复，请等待完成后再删除",
      };
    }

    const tasks = await listAgentTasksByConversation(args.adoptId, args.conversationId, 100);
    const activeTask = activeConversationTask(tasks);
    if (activeTask) {
      endChatSessionDeletion(lifecycleKey);
      return {
        ok: false,
        status: 409,
        error: "SESSION_HAS_ACTIVE_TASK",
        message: `“${String(activeTask.agentName || activeTask.agentId || "专家")}”仍在处理，请先取消或等待任务完成`,
      };
    }
    return { ok: true, lifecycleKey };
  } catch (error) {
    endChatSessionDeletion(lifecycleKey);
    throw error;
  }
}

export function registerMiscRoutes(app: express.Express) {

  app.post("/api/claw/client-load-metrics", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      if (!adoptId) {
        res.status(400).json({ error: "adoptId required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;

      const rawMetrics = Array.isArray(req.body?.metrics) ? req.body.metrics.slice(0, 24) : [];
      type SanitizedClientLoadMetric = {
        key: string;
        label: string;
        status: string;
        elapsedMs: number;
        requestMs?: number;
        detail: string;
      };
      const metrics: SanitizedClientLoadMetric[] = rawMetrics.map((metric: any) => ({
        key: String(metric?.key || "").slice(0, 48),
        label: String(metric?.label || "").slice(0, 48),
        status: String(metric?.status || "").slice(0, 16),
        elapsedMs: Math.max(0, Math.min(Number(metric?.elapsedMs || 0) || 0, 10 * 60 * 1000)),
        requestMs: metric?.requestMs == null ? undefined : Math.max(0, Math.min(Number(metric.requestMs || 0) || 0, 10 * 60 * 1000)),
        detail: String(metric?.detail || "").replace(/\s+/g, " ").slice(0, 160),
      }));
      const totalMs = Math.max(0, Math.min(Number(req.body?.totalMs || 0) || 0, 10 * 60 * 1000));
      const slowest = metrics
        .slice()
        .sort((a: SanitizedClientLoadMetric, b: SanitizedClientLoadMetric) => Number(b.elapsedMs || 0) - Number(a.elapsedMs || 0))
        .slice(0, 3)
        .map((metric: SanitizedClientLoadMetric) => `${metric.key}:${metric.elapsedMs}ms:${metric.status}`)
        .join(",");

      logInfo("client.load.report", {
        adoptId,
        userId: Number((claw as any).userId || 0),
        path: String(req.body?.path || "").slice(0, 160),
        totalMs,
        metricCount: metrics.length,
        slowest,
        metrics,
      });
      res.json({ ok: true });
    } catch (error: any) {
      logError("client.load.report_failed", error);
      res.status(500).json({ error: "client_load_metrics_failed" });
    }
  });

  app.get("/api/claw/chat-history/sessions", async (req, res) => {
    const startedAt = Date.now();
    let adoptId = "";
    try {
      adoptId = String(req.query.adoptId || "").trim();
      const limit = Math.min(Math.max(Number(req.query.limit || 50) || 50, 1), 100);
      if (!adoptId) {
        logIosLoadDebug("chat_history_sessions_bad_request", {
          ms: Date.now() - startedAt,
          ip: req.ip,
        });
        res.status(400).json({ error: "adoptId required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) {
        logIosLoadDebug("chat_history_sessions_owner_denied", {
          adoptId,
          ms: Date.now() - startedAt,
          statusCode: res.statusCode,
        });
        return;
      }

      const payload = await listClawChatHistorySessionRecords({ adoptId, claw, limit, startedAt });
      res.json(payload);
    } catch (error: any) {
      logError("chat.history.list_failed", error, { adoptId });
      logIosLoadDebug("chat_history_sessions_error", {
        adoptId,
        error: String(error?.message || error),
        ms: Date.now() - startedAt,
      });
      res.status(500).json({ error: "chat_history_list_failed" });
    }
  });

  app.get("/api/claw/chat-history/messages", async (req, res) => {
    const startedAt = Date.now();
    let adoptId = "";
    let sessionKey = "";
    try {
      adoptId = String(req.query.adoptId || "").trim();
      sessionKey = String(req.query.sessionKey || "").trim();
      if (!adoptId || !sessionKey) {
        logIosLoadDebug("chat_history_messages_bad_request", {
          adoptId,
          hasSessionKey: Boolean(sessionKey),
          ms: Date.now() - startedAt,
        });
        res.status(400).json({ error: "adoptId and sessionKey required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) {
        logIosLoadDebug("chat_history_messages_owner_denied", {
          adoptId,
          ms: Date.now() - startedAt,
          statusCode: res.statusCode,
        });
        return;
      }

      const dbAgentId = String((claw as any).agentId || "").trim();
      const expertConversationId = expertConversationIdFromSessionKey(sessionKey);
      if (expertConversationId) {
        const expertTasks = await listAgentTasksByConversation(adoptId, expertConversationId, 100);
        const messages = buildExpertTaskHistoryMessages(expertTasks, 200);
        if (messages.length === 0) {
          res.status(404).json({ error: "session_missing" });
          return;
        }
        logIosLoadDebug("chat_history_messages_done_expert", {
          adoptId,
          conversationId: expertConversationId,
          sessionKey,
          messageCount: messages.length,
          ms: Date.now() - startedAt,
        });
        res.json({
          conversationId: expertConversationId,
          sessionKey,
          sessionId: sessionKey,
          runtime: "ea-expert",
          messages,
        });
        return;
      }

      if (isJiuwenClawAdoptId(adoptId)) {
        const resolved = resolveJiuwenHistorySession({ adoptId, dbAgentId, sessionKey });
        if (!resolved) {
          res.status(404).json({ error: "session_missing" });
          return;
        }
        const runtimeMessages = mergeJiuwenHistoryCandidates({
          candidates: resolved.segments,
          adoptId,
          dbAgentId,
          maxMessages: 200,
          workspaceDir: resolveRuntimeWorkspace(claw, adoptId),
        });
        const expertTasks = await listAgentTasksByConversation(adoptId, resolved.conversationId, 100).catch(() => []);
        const messages = bindHistoryAttachmentOwner(dedupeHistoryMessages([
          ...runtimeMessages,
          ...buildExpertTaskHistoryMessages(expertTasks, 200),
        ], 200), adoptId);
        logIosLoadDebug("chat_history_messages_done_jiuwen", {
          adoptId,
          runtimeAgentId: jiuwenClawAgentId(adoptId, dbAgentId),
          sessionKey,
          messageCount: messages.length,
          ms: Date.now() - startedAt,
        });
        res.json({
          conversationId: resolved.conversationId,
          sessionKey,
          sessionId: resolved.sessionId,
          messages,
        });
        return;
      }

      res.status(400).json({ error: "unsupported_runtime" });
    } catch (error: any) {
      logError("chat.history.messages_failed", error, { adoptId });
      logIosLoadDebug("chat_history_messages_error", {
        adoptId,
        sessionKey,
        error: String(error?.message || error),
        ms: Date.now() - startedAt,
      });
      res.status(500).json({ error: "chat_history_messages_failed" });
    }
  });

  app.delete("/api/claw/chat-history/session", async (req, res) => {
    let adoptId = "";
    try {
      adoptId = String(req.body?.adoptId || "").trim();
      const sessionKey = String(req.body?.sessionKey || "").trim();
      if (!adoptId || !sessionKey) {
        res.status(400).json({ error: "adoptId and sessionKey required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;

      const expertConversationId = expertConversationIdFromSessionKey(sessionKey);
      if (expertConversationId) {
        const prepared = await prepareConversationDeletion({ adoptId, conversationId: expertConversationId });
        if (!prepared.ok) {
          res.status(prepared.status).json({ error: prepared.error, message: prepared.message });
          return;
        }
        try {
          const deleted = await deleteAgentTasksByConversation(adoptId, expertConversationId);
          if (deleted === 0) {
            res.status(404).json({ error: "session_missing" });
            return;
          }
          invalidateChatHistorySessionList(adoptId);
          res.json({
            ok: true,
            runtime: "ea-expert",
            conversationId: expertConversationId,
            sessionId: sessionKey,
            deleted,
          });
          return;
        } finally {
          endChatSessionDeletion(prepared.lifecycleKey);
        }
      }

      const dbAgentId = String((claw as any).agentId || "").trim();
      if (isJiuwenClawAdoptId(adoptId)) {
        const resolved = resolveJiuwenHistorySession({ adoptId, dbAgentId, sessionKey });
        if (!resolved) {
          res.status(404).json({ error: "session_missing" });
          return;
        }
        const prepared = await prepareConversationDeletion({
          adoptId,
          conversationId: resolved.conversationId,
        });
        if (!prepared.ok) {
          res.status(prepared.status).json({ error: prepared.error, message: prepared.message });
          return;
        }
        try {
          const result = deleteJiuwenHistorySession({ adoptId, dbAgentId, sessionKey });
          if (!result) {
            res.status(404).json({ error: "session_missing" });
            return;
          }
          const expertDeleted = await deleteAgentTasksByConversation(adoptId, result.conversationId);
          invalidateChatHistorySessionList(adoptId);
          res.json({
            ok: true,
            runtime: "jiuwenswarm",
            conversationId: result.conversationId,
            sessionId: result.sessionId,
            deleted: result.deleted + expertDeleted,
            expertDeleted,
          });
          return;
        } finally {
          endChatSessionDeletion(prepared.lifecycleKey);
        }
      }

      res.status(400).json({ error: "unsupported_runtime" });
    } catch (error: any) {
      logError("chat.history.delete_failed", error, { adoptId });
      res.status(500).json({ error: "chat_history_delete_failed" });
    }
  });

  app.post("/api/claw/chat-history/activate", async (req, res) => {
    let adoptId = "";
    try {
      adoptId = String(req.body?.adoptId || "").trim();
      const sessionKey = String(req.body?.sessionKey || "").trim();
      if (!adoptId || !sessionKey) {
        res.status(400).json({ error: "adoptId and sessionKey required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;

      const expertConversationId = expertConversationIdFromSessionKey(sessionKey);
      if (expertConversationId) {
        const tasks = await listAgentTasksByConversation(adoptId, expertConversationId, 1);
        if (tasks.length === 0) {
          res.status(404).json({ error: "session_missing" });
          return;
        }
        res.json({
          ok: true,
          conversationId: expertConversationId,
          sessionKey,
          runtime: "ea-expert",
        });
        return;
      }

      const dbAgentId = String((claw as any).agentId || "").trim();
      if (isJiuwenClawAdoptId(adoptId)) {
        const resolved = resolveJiuwenHistorySession({ adoptId, dbAgentId, sessionKey });
        if (!resolved) {
          res.status(404).json({ error: "session_missing" });
          return;
        }
        const runtimeAgentId = jiuwenClawAgentId(adoptId, dbAgentId);
        const currentEpoch = readSessionEpoch(adoptId);
        const scope = buildSessionRegistryScope("web", resolved.conversationId);
        upsertSessionRegistry(adoptId, runtimeAgentId, sessionKey, currentEpoch, scope);
        res.json({
          ok: true,
          conversationId: resolved.conversationId,
          sessionKey,
          epoch: currentEpoch,
          runtime: "jiuwenswarm",
        });
        return;
      }

      res.status(400).json({ error: "unsupported_runtime" });
    } catch (error: any) {
      logError("chat.history.activate_failed", error, { adoptId });
      res.status(500).json({ error: "chat_history_activate_failed" });
    }
  });

  // ── 每日洞察 API ──────────────────────────────────────
  app.get("/api/insights/latest", async (_req, res) => {
    try {
      const { getLatestDailyInsight } = await import("../db");
      const insight = await getLatestDailyInsight();
      if (!insight) {
        res.status(404).json({ error: "No insight found" });
        return;
      }
      res.json({
        id: insight.id,
        date: insight.date,
        title: insight.title,
        summary: insight.summary,
        content: insight.content,
        source: insight.source,
        updatedAt: insight.updatedAt,
      });
    } catch (error) {
      logError("insight.latest_failed", error);
      res.status(500).json({ error: "Failed to get latest insight" });
    }
  });

  app.post("/api/insights/upsert", strictLimiter, async (req, res) => {
    try {
      const expectedToken = process.env.INSIGHTS_PUSH_TOKEN;
      const tokenFromHeader = req.header("x-insights-token") || req.header("authorization")?.replace(/^Bearer\s+/i, "");

      if (!expectedToken || tokenFromHeader !== expectedToken) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const body = req.body || {};
      const date = typeof body.date === "string" ? body.date.trim() : "";
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const content = typeof body.content === "string" ? body.content.trim() : "";
      const summary = typeof body.summary === "string" ? body.summary.trim() : "";
      const source = typeof body.source === "string" ? body.source.trim() : "openclaw";

      if (!date || !title || !content) {
        res.status(400).json({ error: "date/title/content are required" });
        return;
      }

      const { upsertDailyInsight } = await import("../db");
      await upsertDailyInsight({ date, title, summary, content, source });

      res.json({ success: true });
    } catch (error) {
      logError("insight.upsert_failed", error);
      res.status(500).json({ error: "Failed to upsert insight" });
    }
  });

  // ── Logout all sessions/cookies ───────────────────────
  app.post("/api/auth/logout-all", async (req, res) => {
    try {
      clearSessionCookieVariants(req, res);

      // lock sso-bridge for 3 minutes to avoid immediate auto-login after logout
      setLogoutLockCookieVariants(req, res);

      // best-effort site data clear (supported browsers only)
      res.setHeader("Clear-Site-Data", '"cookies", "storage"');
      return res.json({ success: true });
    } catch {
      return res.status(500).json({ success: false });
    }
  });

  // ── Embed auth probe for nginx auth_request ───────────
  app.get("/api/embed/auth-check", async (req, res) => {
    try {
      const context = await createContext({ req, res, info: {} as any });
      if (context.user) {
        res.status(204).end();
      } else {
        res.status(401).json({ error: "UNAUTHORIZED" });
      }
    } catch (e) {
      res.status(401).json({ error: "UNAUTHORIZED" });
    }
  });

  // ── SSO bridge ────────────────────────────────────────
  app.get("/api/embed/sso-bridge", async (req, res) => {
    try {
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5180/";
      const cookieDomain = process.env.COOKIE_DOMAIN || "";
      const nextRaw = typeof req.query.next === "string" ? req.query.next : frontendUrl;
      let nextUrl: URL;
      try {
        nextUrl = new URL(nextRaw);
      } catch {
        return res.redirect(frontendUrl);
      }

      // only allow configured domain destinations; without COOKIE_DOMAIN, stay on FRONTEND_URL origin.
      const frontend = new URL(frontendUrl);
      const allowedDomain = cookieDomain.replace(/^\./, "").toLowerCase();
      const nextHost = nextUrl.hostname.toLowerCase();
      const allowedByCookieDomain = allowedDomain
        ? (nextHost === allowedDomain || nextHost.endsWith(`.${allowedDomain}`))
        : false;
      const allowedByFrontendOrigin = nextUrl.origin === frontend.origin;
      if (!allowedByFrontendOrigin && !allowedByCookieDomain) {
        return res.redirect(frontendUrl);
      }

      // If user just logged out, skip auto-bridge to avoid immediate re-login loop
      if ((req as any).cookies?.logout_lock === "1") {
        return res.redirect(frontendUrl);
      }

      const context = await createContext({ req, res, info: {} as any });
      if (!context.user) {
        return res.redirect(frontendUrl);
      }

      const { sdk } = await import("./sdk");

      const token = await sdk.signSession({
        userId: context.user.id,
        name: context.user.name ?? "",
        authVersion: sessionAuthVersion(context.user),
        mfaVerifiedAt: context.user.mfaVerifiedAt,
      });

      // shared cookie for subdomains
      res.cookie(COOKIE_NAME, token, {
        ...(cookieDomain ? { domain: cookieDomain } : {}),
        httpOnly: true,
        path: "/",
        sameSite: "none",
        secure: true,
      });

      return res.redirect(nextUrl.toString());
    } catch (e) {
      return res.redirect(process.env.FRONTEND_URL || "http://localhost:5180/");
    }
  });

  // ── AI 审核技能包 ───────────────────────────────────
  app.post("/api/claw/admin/ai-review-skill", async (req, res) => {
    try {
      const context = await createContext({ req, res, info: {} as any });
      if (!context.user || context.user.role !== "admin") {
        res.status(403).json({ error: "admin only" });
        return;
      }
      const mfa = await adminMfaWriteAccess(context.user);
      if (mfa.required && !mfa.fresh) { res.status(403).json({ error: "ADMIN_MFA_REQUIRED" }); return; }

      const { getSkillMarketItem: getSMI } = await import("../db");

      const { skillMarketId } = req.body || {};
      if (!skillMarketId) { res.status(400).json({ error: "Missing skillMarketId" }); return; }

      const item = await getSMI(Number(skillMarketId));
      if (!item) { res.status(404).json({ error: "技能不存在" }); return; }

      // 读取源码
      const dir = item.packagePath || "";
      let skillMd = "";
      let scriptFiles: string[] = [];
      let scriptContent = "";
      try { skillMd = readFileSync(`${dir}/SKILL.md`, "utf8"); } catch {}
      try {
        if (existsSync(`${dir}/scripts`)) {
          scriptFiles = readdirSync(`${dir}/scripts`);
          // 读取前 3 个脚本内容
          for (const f of scriptFiles.slice(0, 3)) {
            try {
              const c = readFileSync(`${dir}/scripts/${f}`, "utf8");
              scriptContent += `\n--- ${f} ---\n${c.slice(0, 2000)}\n`;
            } catch {}
          }
        }
      } catch {}

      const prompt = `审核此技能包，简要回答（200字内）：1.安全性 2.描述准确性 3.建议(通过/拒绝/需修改)\n\nSKILL.md(摘要):\n${skillMd.slice(0, 1000)}\n\n脚本: ${scriptFiles.join(",")}\n${scriptContent.slice(0, 1500)}`;

      const modelConfig = await resolveEaAssistantModelConfig();
      if (!modelConfig.apiKey) {
        res.status(503).json({ error: "未配置模型，无法 AI 审核" });
        return;
      }

      // SSE 流式输出
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const requestBody: Record<string, unknown> = {
        model: modelConfig.model,
        messages: [{ role: "user", content: prompt }],
        stream: true,
      };
      requestBody[modelConfig.tokenParam] = 500;
      if (modelConfig.disableThinking) {
        requestBody.chat_template_kwargs = { thinking: false };
      }
      const apiRes = await fetchWithTimeout(modelConfig.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${modelConfig.apiKey}`,
        },
        body: JSON.stringify(requestBody),
      }, 120_000);

      if (!apiRes.ok || !apiRes.body) {
        res.write(`data: ${JSON.stringify({ error: "LLM 调用失败: " + apiRes.status })}\n\n`);
        res.end();
        return;
      }

      const reader = (apiRes.body as any).getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") { res.write(`data: ${JSON.stringify({ done: true })}\n\n`); continue; }
          try {
            const d = JSON.parse(payload);
            const chunk = d.choices?.[0]?.delta?.content || "";
            if (chunk) res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
          } catch {}
        }
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (err: any) {
      logError("skill.ai_review_failed", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else { try { res.end(); } catch {} }
    }
  });

  // ── 管理员上传开源社区技能包（zip）────────────────────
  app.post("/api/claw/skill-market/upload", async (req, res) => {
    try {
      const ctx = await createContext({ req, res } as any);
      if (!ctx.user || ctx.user.role !== "admin") {
        res.status(403).json({ error: "admin only" });
        return;
      }
      const mfa = await adminMfaWriteAccess(ctx.user);
      if (mfa.required && !mfa.fresh) { res.status(403).json({ error: "ADMIN_MFA_REQUIRED" }); return; }

      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        try {
          const buf = Buffer.concat(chunks);
          if (buf.length === 0) { res.status(400).json({ error: "No data" }); return; }
          if (buf.length > MAX_SKILL_PACKAGE_BYTES) { res.status(413).json({ error: "File too large (max 50MB)" }); return; }

          const filename = decodeURIComponent(String(req.header("x-skill-filename") || "uploaded.zip")).trim() || "uploaded.zip";
          const malwareScan = await scanUploadForMalware(buf);
          if (!malwareScan.ok) {
            res.status(400).json({ error: "file_malware_scan_failed", message: malwareScan.error });
            return;
          }
          const parsed = await parseSkillPackageBuffer(buf, filename);
          const marketDir = skillStoreMarketplaceDir();
          const uploadId = `upload-${Date.now()}`;
          const tmpZip = path.join("/tmp", `${uploadId}.zip`);
          const finalDir = path.join(marketDir, "pending", `${parsed.skillId}-${uploadId}`);

          writeFileSync(tmpZip, buf);
          try {
            skillInstaller.installFromSource(tmpZip, finalDir);
          } finally {
            try { rmSync(tmpZip, { force: true }); } catch {}
          }

          const { insertSkillMarketItem } = await import("../db");
          const marketItemId = await insertSkillMarketItem({
            skillId: parsed.skillId,
            name: parsed.displayName || parsed.skillId,
            description: parsed.description || null,
            author: "管理员上传",
            authorUserId: ctx.user!.id,
            version: String(parsed.manifest?.version || "1.0.0"),
            category: "general",
            origin: "opensource",
            status: "pending",
            license: String(parsed.manifest?.license || "MIT"),
            packagePath: finalDir,
          });

          res.json({
            ok: true,
            uploadId: parsed.skillId,
            name: parsed.displayName || parsed.skillId,
            description: parsed.description || "",
            path: finalDir,
            marketItemId,
            warnings: parsed.warnings,
          });
        } catch (err: any) {
          logError("skill.market_upload_failed", err);
          res.status(400).json({ error: String(err?.message || "技能包解析失败") });
        }
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  // ── 智能体使用量统计（从聊天日志解析）──
  app.get("/api/claw/admin/usage-stats", async (req, res) => {
    try {
      // 简单鉴权
      const { createContext } = await import("./context");
      const ctx = await createContext({ req, res } as any);
      if (!ctx.user || ctx.user.role !== "admin") {
        return res.status(403).json({ error: "admin only" });
      }

      const logPaths = [
        APP_ROOT + "/logs/claw-exec-detail.log",
        APP_ROOT + "/logs/claw-exec.log",
      ];
      const lines = logPaths.flatMap((logPath) => {
        if (!existsSync(logPath)) return [] as string[];
        return readFileSync(logPath, "utf8").split("\n").filter(Boolean);
      });
      // 按 adoptId 统计
      const byAdopt: Record<string, UsageBucket> = {};
      const dailyAll: Record<string, number> = {};
      const seen = new Set<string>();
      const isChatUsageEvent = (d: any) => {
        if (d?.event === "chat_stream_response" || d?.event === "ws_chat_response") return true;
        // 兼容旧 tRPC claw.chat 日志；排除管理操作，例如 admin_delete_claw。
        if (d?.event === "claw_exec" && d?.messageType === "user_input") return true;
        if (d?.event === "claw_exec" && d?.message && d?.message !== "admin_delete_claw") return true;
        return false;
      };
      const usageKey = (d: any) => {
        const sessionKey = d?.sessionKey ? String(d.sessionKey) : "";
        const chatId = d?.chatCompletionId ? String(d.chatCompletionId) : "";
        return [
          d?.event || "",
          d?.adoptId || "",
          d?.ts || "",
          sessionKey,
          chatId,
        ].join("|");
      };

      for (const line of lines) {
        try {
          const d = JSON.parse(line);
          if (!isChatUsageEvent(d)) continue;
          addUsageEvent({
            byAdopt,
            dailyAll,
            seen,
            key: usageKey(d),
            adoptId: d.adoptId || "",
            ts: d.ts || "",
            userId: d.userId || 0,
          });
        } catch {}
      }

      // 查用户名和当前 JiuwenSwarm runtime 映射。
      let userMap: Record<number, string> = {};
      const adoptionRows: Array<{ adoptId: string; agentId: string; userId: number; runtime: string }> = [];
      const adoptRuntimeMap: Record<string, string> = {};
      const currentAdoptIds = new Set<string>();
      try {
        const { getDb } = await import("../db");
        const { users, clawAdoptions } = await import("../../drizzle/schema");
        const db = await getDb();
        if (db) {
          const allUsers = await db.select({ id: users.id, name: users.name, email: users.email }).from(users);
          for (const u of allUsers) userMap[u.id] = u.name || u.email || String(u.id);
          const claws = await db.select({
            adoptId: clawAdoptions.adoptId,
            agentId: clawAdoptions.agentId,
            userId: clawAdoptions.userId,
            runtime: clawAdoptions.runtime,
          }).from(clawAdoptions);
          for (const claw of claws) {
            const adoptId = String(claw.adoptId || "").trim();
            const userId = Number(claw.userId || 0);
            const configuredAgentId = String(claw.agentId || "").trim();
            const runtime = String(claw.runtime || "").trim() || (isJiuwenClawAdoptId(adoptId) ? "jiuwenswarm" : "openclaw");
            adoptionRows.push({ adoptId, agentId: configuredAgentId, userId, runtime });
            if (adoptId) currentAdoptIds.add(adoptId);
            if (adoptId) adoptRuntimeMap[adoptId] = runtime;
          }
        }
      } catch {}

      for (const claw of adoptionRows) {
        if (claw.runtime !== "jiuwenswarm" && !isJiuwenClawAdoptId(claw.adoptId)) continue;
        addJiuwenUsageEvents({
          byAdopt,
          dailyAll,
          seen,
          adoptId: claw.adoptId,
          dbAgentId: claw.agentId,
          userId: claw.userId,
        });
      }

      try {
        const jiuwenLogPath = APP_ROOT + "/logs/jiuwenclaw-exec.log";
        if (existsSync(jiuwenLogPath)) {
          const maxLines = Math.min(Math.max(Number(process.env.WORKFORCE_AGENT_USAGE_JIUWEN_LOG_MAX_LINES || process.env.LINGXIA_USAGE_JIUWEN_LOG_MAX_LINES || 20000), 100), 500000);
          const jiuwenLines = readFileSync(jiuwenLogPath, "utf8").split("\n").filter(Boolean).slice(-maxLines);
          for (const line of jiuwenLines) {
            try {
              const d = JSON.parse(line);
              if (d?.event !== "chat_stream_request") continue;
              const adoptId = String(d?.adoptId || "").trim();
              if (!adoptId || !isJiuwenClawAdoptId(adoptId)) continue;
              addUsageEvent({
                byAdopt,
                dailyAll,
                seen,
                key: [
                  "jiuwen-log",
                  adoptId,
                  d?.clientRunId || "",
                  d?.sessionId || "",
                  d?.ts || "",
                ].join("|"),
                adoptId,
                ts: d?.ts || "",
                userId: d?.userId || 0,
              });
            } catch {}
          }
        }
      } catch {}

      // 构建排行
      const adoptions = Object.entries(byAdopt)
        .filter(([adoptId]) => currentAdoptIds.has(adoptId))
        .map(([adoptId, stat]) => ({
          adoptId,
          total: stat.total,
          userId: stat.userId,
          userName: userMap[stat.userId] || String(stat.userId),
          runtime: adoptRuntimeMap[adoptId] || (isJiuwenClawAdoptId(adoptId) ? "jiuwenswarm" : "openclaw"),
          lastActivity: stat.lastTs,
          recent7d: Object.entries(stat.days)
            .filter(([d]) => d >= new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10))
            .reduce((s, [, c]) => s + c, 0),
          dailyBreakdown: Object.entries(stat.days).sort(([a], [b]) => b.localeCompare(a)).slice(0, 14)
            .map(([date, count]) => ({ date, count })),
        }))
        .sort((a, b) => b.total - a.total);

      // 每日全局趋势（最近14天）
      const daily = Object.entries(dailyAll)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 14)
        .map(([date, count]) => ({ date, count }))
        .reverse();

      let installations = {
        summary: {
          commandCopied: 0,
          downloaded: 0,
          started: 0,
          succeeded: 0,
          failed: 0,
          succeeded30d: 0,
          successRate: 0,
        },
        daily: [] as Array<{ date: string; downloaded: number; started: number; succeeded: number; failed: number }>,
        failureStages: [] as Array<{ stage: string; count: number }>,
      };
      try {
        const { getInstallTelemetrySummary } = await import("../db/install-telemetry");
        installations = await getInstallTelemetrySummary();
      } catch (error) {
        logError("admin.usage_stats.install_telemetry_failed", error);
      }

      return res.json({
        adoptions,
        daily,
        installations,
        summary: {
          totalClaws: adoptions.length,
          totalChats: seen.size,
          activeToday: adoptions.filter(a => a.dailyBreakdown.some(d => d.date === new Date().toISOString().slice(0, 10))).length,
        },
      });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

}
