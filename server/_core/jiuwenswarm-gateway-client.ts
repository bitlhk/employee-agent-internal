import type { Request, Response } from "express";
import { WebSocket, type RawData } from "ws";
import {
  buildJiuwenAgentId,
  buildJiuwenSessionId,
  buildJiuwenServiceId,
  bumpSessionEpoch,
  type JiuwenClawRuntimeClaw,
  type JiuwenForwardOptions,
  type JiuwenSelectedSkillMetadata,
  normalizeJiuwenFileEvent,
  normalizeJiuwenPermissionRequest,
  normalizeJiuwenToolPayload,
  normalizeJiuwenUsageSummary,
  normalizeJiuwenMode,
  stringifyJiuwenToolPayload,
  recordJiuwenToolAudit,
} from "./jiuwenclaw-bridge";
import { appendLogAsync, resolveRuntimeWorkspace } from "./helpers";
import { privateMessageLogFields } from "./log-privacy";

const DEFAULT_GATEWAY_WS_URL = "ws://127.0.0.1:19000/ws";

function gatewayWsUrl(): string {
  return String(process.env.JIUWENCLAW_GATEWAY_WS_URL || DEFAULT_GATEWAY_WS_URL);
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

function initSse(res: Response): void {
  if (!res.headersSent) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
  }
  if (res.socket) res.socket.setNoDelay(true);
}

function eventPayload(frame: any): Record<string, unknown> {
  const payload = frame?.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
}

function payloadSessionId(payload: Record<string, unknown>): string {
  const direct = payload.session_id;
  return typeof direct === "string" ? direct : "";
}

function buildGatewayChatParams(args: {
  serviceId: string;
  agentId: string;
  sessionId: string;
  channelId: string;
  message: string;
  workspaceDir: string;
  model?: string;
  runtimeMode?: unknown;
  selectedSkills?: JiuwenSelectedSkillMetadata[];
}) {
  const mode = normalizeJiuwenMode(args.runtimeMode || process.env.JIUWENCLAW_DEFAULT_MODE);
  const selectedSkills = Array.isArray(args.selectedSkills) ? args.selectedSkills : [];
  return {
    service_id: args.serviceId,
    agent_id: args.agentId,
    session_id: args.sessionId,
    query: args.message,
    content: args.message,
    project_dir: args.workspaceDir,
    interactive_ask: true,
    request_metadata: {
      effective_project_dir: args.workspaceDir,
      source_channel: args.channelId,
      ...(selectedSkills.length ? { selected_skills: selectedSkills } : {}),
    },
    mode,
    ...(args.model ? { model_name: args.model } : {}),
  };
}

function buildGatewayPermissionAnswerParams(args: {
  serviceId: string;
  agentId: string;
  sessionId: string;
  channelId: string;
  workspaceDir: string;
  permissionRequestId: string;
  selectedOption: string;
  source?: string;
  runtimeMode?: unknown;
}) {
  const mode = normalizeJiuwenMode(args.runtimeMode || process.env.JIUWENCLAW_DEFAULT_MODE);
  const source = String(args.source || "permission_interrupt").trim() || "permission_interrupt";
  return {
    service_id: args.serviceId,
    agent_id: args.agentId,
    session_id: args.sessionId,
    query: "",
    content: "",
    project_dir: args.workspaceDir,
    request_id: args.permissionRequestId,
    answers: [{ selected_options: [args.selectedOption] }],
    source,
    mode,
    request_metadata: {
      effective_project_dir: args.workspaceDir,
      source_channel: args.channelId,
    },
  };
}

function sendGatewayRequest(ws: WebSocket, method: string, id: string, params: Record<string, unknown>): void {
  ws.send(JSON.stringify({
    type: "req",
    id,
    method,
    params,
  }));
}

function writeSseData(res: Response, obj: any): void {
  if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function writeSseEvent(res: Response, event: string, obj: any): void {
  if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
}

function emitSseDone(res: Response): void {
  if (res.destroyed || res.writableEnded) return;
  res.write(`data: ${JSON.stringify({ __stream_end: true })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function gatewayEventToText(eventType: string, payload: Record<string, unknown>): string {
  if (eventType === "chat.delta") {
    return String(payload.content || "");
  }
  return "";
}

function shouldFinishGatewayStream(eventType: string, payload: Record<string, unknown>): boolean {
  if (eventType === "chat.final" || eventType === "chat.session_result") return true;
  if (eventType === "chat.processing_status" && payload.is_processing === false) return true;
  if (eventType === "chat.error") return true;
  return false;
}

async function handleGatewayEvent(args: {
  claw: JiuwenClawRuntimeClaw;
  req?: Request;
  res?: Response;
  eventType: string;
  payload: Record<string, unknown>;
  requestId: string;
  agentId: string;
  sessionId: string;
  channelId: string;
  workspaceDir: string;
  collectText?: (text: string) => void;
}): Promise<"permission" | "done" | "continue"> {
  const { eventType, payload } = args;
  const text = gatewayEventToText(eventType, payload);
  if (text) {
    args.collectText?.(text);
    if (args.res) writeSseData(args.res, { choices: [{ delta: { content: text }, index: 0 }] });
  }

  if (eventType === "chat.usage_summary" || eventType === "chat.usage_metadata" || eventType === "context.usage") {
    const usageSummary = normalizeJiuwenUsageSummary(payload);
    if (usageSummary && args.res) {
      writeSseData(args.res, {
        __perf: {
          usage: usageSummary.usage,
          ...(usageSummary.model ? { model: usageSummary.model } : {}),
        },
      });
    }
  }

  const permissionRequest = normalizeJiuwenPermissionRequest(eventType, payload, args.requestId);
  if (permissionRequest && args.res) {
    appendLogAsync("jiuwenclaw-exec.log", {
      ts: new Date().toISOString(),
      event: "gateway_human_approval_required",
      adoptId: args.claw.adoptId,
      agentId: args.agentId,
      sessionId: args.sessionId,
      channelId: args.channelId,
      requestId: args.requestId,
      permissionRequestId: permissionRequest.requestId,
      source: permissionRequest.source,
      toolName: permissionRequest.toolName || "",
    });
    writeSseEvent(args.res, "jiuwen_permission_request", {
      ...permissionRequest,
      adoptId: args.claw.adoptId,
      agentId: args.agentId,
      sessionId: args.sessionId,
      channelId: args.channelId,
    });
    writeSseData(args.res, { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] });
    return "permission";
  }

  const files = normalizeJiuwenFileEvent(payload, args.workspaceDir);
  for (const file of files) {
    if (args.res) writeSseEvent(args.res, "workspace_files", { adoptId: args.claw.adoptId, files: [file] });
  }

  const tool = normalizeJiuwenToolPayload(eventType, payload);
  if (tool) {
    await recordJiuwenToolAudit({
      claw: args.claw,
      req: args.req,
      agentId: args.agentId,
      sessionId: args.sessionId,
      requestId: args.requestId,
      channelId: args.channelId,
      eventType,
      delta: payload,
    });
    const resultText = stringifyJiuwenToolPayload(tool.resultPayload);
    const shouldEmitToolResult = !tool.isResult || tool.isError || resultText.trim().length > 0;
    if (args.res) {
      if (tool.isResult) {
        if (shouldEmitToolResult) {
          writeSseEvent(args.res, "tool_result", {
            tool_call_id: tool.callId,
            name: tool.toolName,
            result: resultText,
            is_error: tool.isError,
            executor: "jiuwenswarm",
            adoptId: args.claw.adoptId,
          });
        }
      } else {
        writeSseEvent(args.res, "tool_call", {
          id: tool.callId,
          name: tool.toolName,
          arguments: stringifyJiuwenToolPayload(tool.argumentsPayload) || "{}",
          executor: "jiuwenswarm",
          adoptId: args.claw.adoptId,
        });
      }
    }
  }

  return shouldFinishGatewayStream(eventType, payload) ? "done" : "continue";
}

export async function forwardToJiuwenGateway(
  claw: JiuwenClawRuntimeClaw,
  message: string,
  res: Response,
  opts: JiuwenForwardOptions = {},
): Promise<void> {
  initSse(res);

  const msgTrim = String(message || "").trim();
  if (msgTrim === "/new" || msgTrim === "/reset") {
    bumpSessionEpoch(claw.adoptId);
    writeSseData(res, { choices: [{ delta: { content: "已开始新对话。" }, index: 0 }] });
    writeSseData(res, { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] });
    emitSseDone(res);
    return;
  }

  const wsUrl = gatewayWsUrl();
  const serviceId = buildJiuwenServiceId();
  const agentId = buildJiuwenAgentId(claw);
  const sessionId = buildJiuwenSessionId(claw, agentId, opts);
  const channelId = claw.adoptId;
  const workspaceDir = resolveRuntimeWorkspace(claw, claw.adoptId);
  const requestId = `linggan-gateway-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const params = buildGatewayChatParams({
    serviceId,
    agentId,
    sessionId,
    channelId,
    message,
    workspaceDir,
    model: opts.model,
    runtimeMode: opts.runtimeMode,
    selectedSkills: opts.selectedSkills,
  });

  appendLogAsync("jiuwenclaw-exec.log", {
    ts: new Date().toISOString(),
    event: "gateway_chat_request",
    adoptId: claw.adoptId,
    selectedSkillIds: (opts.selectedSkills || []).map((skill) => skill.id).filter(Boolean),
    agentId,
    serviceId,
    sessionId,
    channelId,
    userId: claw.userId,
    clientRunId: opts.clientRunId || "",
    wsUrl,
    ...privateMessageLogFields(message),
  });

  await new Promise<void>((resolve) => {
    let settled = false;
    let clientClosed = false;
    let requestSent = false;
    const timeoutMs = Math.max(30_000, Number(process.env.JIUWENCLAW_GATEWAY_CHAT_TIMEOUT_MS || process.env.JIUWENCLAW_CHAT_TIMEOUT_MS || 180_000) || 180_000);
    const ws = new WebSocket(wsUrl);
    const settle = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      appendLogAsync("jiuwenclaw-exec.log", {
        ts: new Date().toISOString(),
        event: "gateway_chat_complete",
        adoptId: claw.adoptId,
        agentId,
        sessionId,
        channelId,
        requestId,
        reason,
      });
      try { ws.close(1000, reason); } catch {}
      if (!clientClosed) emitSseDone(res);
      resolve();
    };
    const timeout = setTimeout(() => {
      writeSseData(res, { __stream_error: true, error: "JiuwenSwarm gateway 响应超时。" });
      settle("timeout");
    }, timeoutMs);
    res.on("close", () => {
      if (!settled) {
        clientClosed = true;
        try { ws.close(1000, "client closed"); } catch {}
      }
    });
    ws.on("open", () => {
      if (requestSent) return;
      requestSent = true;
      sendGatewayRequest(ws, "chat.send", requestId, params);
    });
    ws.on("message", async (raw) => {
      const frame = parseJsonFrame(raw);
      if (!frame || settled) return;
      if (frame.type === "res" && frame.id === requestId && frame.ok === false) {
        writeSseData(res, { __stream_error: true, error: String(frame.error || "JiuwenSwarm gateway 请求失败") });
        settle("request-error");
        return;
      }
      if (frame.type !== "event") return;
      const eventType = String(frame.event || "");
      const payload = eventPayload(frame);
      const sid = payloadSessionId(payload);
      if (sid && sid !== sessionId) return;
      if (eventType === "chat.error") {
        writeSseData(res, { __stream_error: true, error: String(payload.error || payload.message || "JiuwenSwarm gateway 返回错误") });
      }
      const action = await handleGatewayEvent({
        claw,
        req: opts.req,
        res,
        eventType,
        payload,
        requestId,
        agentId,
        sessionId,
        channelId,
        workspaceDir,
      });
      if (action === "permission") {
        settle("permission-required");
      } else if (action === "done") {
        writeSseData(res, { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] });
        settle("done");
      }
    });
    ws.on("error", (err) => {
      if (settled) return;
      writeSseData(res, { __stream_error: true, error: String((err as any)?.message || err || "JiuwenSwarm gateway 连接失败") });
      settle("ws-error");
    });
    ws.on("close", () => {
      if (!settled) settle(clientClosed ? "client-closed" : "ws-close");
    });
  });
}

export async function answerJiuwenGatewayPermission(
  claw: JiuwenClawRuntimeClaw,
  args: {
    permissionRequestId: string;
    selectedOption: string;
    source?: string;
    model?: string;
    channel?: unknown;
    conversationId?: unknown;
    epochLabel?: unknown;
    runtimeMode?: unknown;
  },
): Promise<{ ok: true; text: string } | { ok: false; error: string; text?: string }> {
  const permissionRequestId = String(args.permissionRequestId || "").trim();
  if (!permissionRequestId) return { ok: false, error: "permissionRequestId required" };

  const wsUrl = gatewayWsUrl();
  const serviceId = buildJiuwenServiceId();
  const agentId = buildJiuwenAgentId(claw);
  const sessionId = buildJiuwenSessionId(claw, agentId, args);
  const channelId = claw.adoptId;
  const workspaceDir = resolveRuntimeWorkspace(claw, claw.adoptId);
  const requestId = `linggan-gateway-answer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const params = buildGatewayPermissionAnswerParams({
    serviceId,
    agentId,
    sessionId,
    channelId,
    workspaceDir,
    permissionRequestId,
    selectedOption: args.selectedOption,
    source: args.source,
    runtimeMode: args.runtimeMode,
  });

  appendLogAsync("jiuwenclaw-exec.log", {
    ts: new Date().toISOString(),
    event: "gateway_permission_answer_request",
    adoptId: claw.adoptId,
    agentId,
    serviceId,
    sessionId,
    channelId,
    userId: claw.userId,
    requestId,
    permissionRequestId,
    selectedOption: args.selectedOption,
    source: args.source || "permission_interrupt",
    wsUrl,
  });

  return await new Promise((resolve) => {
    let settled = false;
    let requestSent = false;
    let text = "";
    let sawDone = false;
    const timeoutMs = Math.max(15_000, Number(process.env.JIUWENCLAW_GATEWAY_PERMISSION_TIMEOUT_MS || process.env.JIUWENCLAW_PERMISSION_TIMEOUT_MS || 180_000) || 180_000);
    const ws = new WebSocket(wsUrl);
    const settle = (result: { ok: true; text: string } | { ok: false; error: string; text?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      appendLogAsync("jiuwenclaw-exec.log", {
        ts: new Date().toISOString(),
        event: result.ok ? "gateway_permission_answer_complete" : "gateway_permission_answer_failed",
        adoptId: claw.adoptId,
        agentId,
        sessionId,
        channelId,
        requestId,
        permissionRequestId,
        textBytes: Buffer.byteLength(text, "utf8"),
        ...(!result.ok ? { error: result.error } : {}),
      });
      try { ws.close(1000, result.ok ? "permission answer complete" : "permission answer failed"); } catch {}
      resolve(result);
    };
    const timeout = setTimeout(() => {
      settle({ ok: false, error: "JiuwenSwarm gateway 权限确认后等待结果超时。", text });
    }, timeoutMs);
    ws.on("open", () => {
      if (requestSent) return;
      requestSent = true;
      sendGatewayRequest(ws, "chat.send", requestId, params);
    });
    ws.on("message", async (raw) => {
      const frame = parseJsonFrame(raw);
      if (!frame || settled) return;
      if (frame.type === "res" && frame.id === requestId && frame.ok === false) {
        settle({ ok: false, error: String(frame.error || "JiuwenSwarm gateway 权限确认失败"), text });
        return;
      }
      if (frame.type !== "event") return;
      const eventType = String(frame.event || "");
      const payload = eventPayload(frame);
      const sid = payloadSessionId(payload);
      if (sid && sid !== sessionId) return;
      const action = await handleGatewayEvent({
        claw,
        eventType,
        payload,
        requestId,
        agentId,
        sessionId,
        channelId,
        workspaceDir,
        collectText: (chunk) => {
          text += chunk;
        },
      });
      if (action === "done") {
        sawDone = true;
        settle({ ok: true, text });
      }
    });
    ws.on("error", (err) => {
      settle({ ok: false, error: String((err as any)?.message || err || "JiuwenSwarm gateway 连接失败"), text });
    });
    ws.on("close", () => {
      if (!settled) {
        settle(sawDone || text
          ? { ok: true, text }
          : { ok: false, error: "JiuwenSwarm gateway 权限确认连接已关闭但未返回结果。", text });
      }
    });
  });
}
