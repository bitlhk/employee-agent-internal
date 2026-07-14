/**
 * claw-recover.ts — SSE 截断后恢复端点（批次 2 A3，2026-04-29）
 *
 * 用途：前端收到 __stream_truncated 后短轮询此端点，后端反查 OpenClaw trajectory，
 * 拿 trace.artifacts.assistantTexts 拼成完整文本返回。前端按 lingxiaMsgs.id 替换。
 *
 * 完整设计：memory project_sse_truncation_diag 五批次 A3 章节
 *
 * 5 条严约束（GPT round-5 / round-6）：
 *   #1 不信前端 sessionKey，requireClawOwner + 自己重算
 *   #2 锚点用服务端 streamEndMs（前端从 __stream_truncated 事件透传回来）
 *   #3 v1 纯 time_window（OpenClaw runId !== chatcmpl_xxx，无桥接）；exact 推到 1.5
 *   #4 不挂长 HTTP，前端短轮询每 5s
 *   #5 finalStatus !== "success" → status: "failed"，不返回文本
 */
import express from "express";
import { existsSync } from "fs";
import { sanitizePublicRuntimePaths } from "@shared/lib/public-runtime-path";
import { clawChatLimiter } from "./security";
import {
  appendLogAsync, openClawAgentDir, requireClawOwner, readSessionEpoch,
} from "./helpers";
import { createOpenClawRuntimeAdapter } from "./runtime";

const MAX_TEXT_RESPONSE  = 1 * 1024 * 1024;    // response.text 最大 1MB
const MAX_WINDOW_MS      = 15 * 60 * 1000;     // streamEndMs 之后 15min 内有效

export function registerRecoverRoutes(app: express.Express) {
  app.post("/api/claw/recover-status", clawChatLimiter, async (req, res) => {
    try {
      // v1：仅支持主聊天 session 截断恢复——不接受 epochLabel 等任何 session 定位输入
      // labeled session（collab embed）截断暂不支持恢复，是已知限制
      const { adoptId, streamEndMs, chatCompletionId } = req.body || {};

      if (!adoptId || typeof streamEndMs !== "number" || !Number.isFinite(streamEndMs)) {
        return res.status(400).json({ error: "adoptId and numeric streamEndMs required" });
      }

      // 约束 #1：必须 requireClawOwner 重新校验权限
      const claw = await requireClawOwner(req, res, String(adoptId));
      if (!claw) return;

      // 约束 #1：自己重算 sessionKey（不信前端，主聊天无 epochLabel）
      const epoch = readSessionEpoch(String(adoptId));
      const dbAgentId = String((claw as any).agentId || "").trim();
      const trialAgentId = `trial_${String(adoptId)}`;
      const trialAgentDir = openClawAgentDir(trialAgentId);
      const runtimeAgentId = existsSync(trialAgentDir) ? trialAgentId : dbAgentId;
      const runtime = createOpenClawRuntimeAdapter();
      const sessionKey = runtime.resolveMainSessionKey({
        adoptId: String(adoptId),
        runtimeAgentId,
        epoch,
      });
      const artifactLookup = runtime.findFirstArtifactAfter({
        runtimeAgentId,
        sessionKey,
        streamEndMs,
        windowMs: MAX_WINDOW_MS,
      });

      if (artifactLookup.status === "pending") {
        return res.status(200).json({
          status: "pending",
          reason: artifactLookup.reason,
          sessionKey,
          sessionId: artifactLookup.sessionId,
          elapsedMs: Date.now() - streamEndMs,
        });
      }

      const { sessionId } = artifactLookup;
      const data = artifactLookup.artifact.data || {};
      const finalStatus = data.finalStatus;

      if (finalStatus !== "success") {
        appendLogAsync("claw-exec-detail.log", {
          ts: new Date().toISOString(),
          event: "recover_response",
          adoptId: String(adoptId),
          status: "failed",
          finalStatus,
          sessionKey, sessionId,
          capturedAt: data.capturedAt,
          chatCompletionId: chatCompletionId ?? null,
        });
        return res.status(200).json({
          status: "failed",
          finalStatus,
          reason: "openclaw_session_failed",
          capturedAt: data.capturedAt,
        });
      }

      // 约束 #5：拼接 assistantTexts 并截断超大 response
      const texts = Array.isArray(data.assistantTexts)
        ? data.assistantTexts.filter((t: any) => typeof t === "string")
        : [];
      let recoveredText = sanitizePublicRuntimePaths(texts.join(""));
      let truncatedFlag = false;
      if (recoveredText.length > MAX_TEXT_RESPONSE) {
        recoveredText = recoveredText.slice(0, MAX_TEXT_RESPONSE);
        truncatedFlag = true;
      }

      appendLogAsync("claw-exec-detail.log", {
        ts: new Date().toISOString(),
        event: "recover_response",
        adoptId: String(adoptId),
        status: "ready",
        sessionKey, sessionId,
        capturedAt: data.capturedAt,
        assistantTextsCount: texts.length,
        textBytes: recoveredText.length,
        responseTruncated: truncatedFlag,
        chatCompletionId: chatCompletionId ?? null,
        matchType: "time_window",  // 约束 #3：v1 纯 time_window
      });

      res.status(200).json({
        status: "ready",
        text: recoveredText,
        source: "trace.artifacts",
        matchType: "time_window",
        finalStatus: "success",
        capturedAt: data.capturedAt,
        assistantTextsCount: texts.length,
        responseTruncated: truncatedFlag,
      });
    } catch (e: any) {
      console.error("[recover-status] error:", e?.message || e);
      res.status(500).json({
        error: "internal_error",
        message: String(e?.message || e).slice(0, 200),
      });
    }
  });
}
