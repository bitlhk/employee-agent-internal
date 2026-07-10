/**
 * claw-ws-proxy.ts v3 — WebSocket 代理：浏览器 ↔ 岗位智能体平台 ↔ OpenClaw Gateway
 *
 * Gateway 事件格式（已验证）：
 *   event="agent" stream="assistant" data.delta="文本"              → 流式内容
 *   event="agent" stream="tool"     data.phase="start"             → 工具调用开始
 *   event="agent" stream="tool"     data.phase="update"            → 工具执行中（可忽略）
 *   event="agent" stream="tool"     data.phase="result"            → 工具调用完成（无实际输出）
 *   event="agent" stream="item"     data.phase="start/update/end"  → UI 展示条目（含 progressText）
 *   event="agent" stream="command_output" data.phase="delta"       → 命令输出流
 *   event="agent" stream="command_output" data.phase="end"         → 命令输出结束（含 output/exitCode/durationMs）
 *   event="agent" stream="lifecycle" data.phase="start/end"        → 运行生命周期
 *   event="chat"  state="final"                                    → 完成信号
 */

import { IncomingMessage } from "http";
import { existsSync, readdirSync, statSync } from "fs";
import { Server } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { createHash, generateKeyPairSync, sign, randomUUID } from "crypto";
// 2026-04-18: eager import 避免首次 WS 聊天挂死（之前是动态 await import，冷启动加载 intent-agent 耗时 18s+ 导致前端心跳超时）
import { WsStreamWriter } from "./stream-writer";
import { routeMessage } from "./intent-agent";
import { createContext } from "./context";
import {
  INTERNAL_BASE_URL,
  appendLogAsync,
  buildRuntimeSessionKey,
  buildSessionRegistryScope,
  lookupSessionRegistry,
  openClawAgentDir,
  openClawWorkspaceDir,
  readSessionEpoch,
  upsertSessionRegistry,
} from "./helpers";
import { ResponseAccumulator } from "./response-accumulator";
import { normalizeWsEvent } from "./runtime";
import { buildRuntimeUserMessage, userLikelyUsesChinese } from "./tool_schema";
import {
  markChatRunComplete,
  markChatRunStarted,
  normalizeClientRunId,
  touchChatRun,
} from "./chat-inflight";
import { scheduleOpenClawToolAudit } from "./openclaw-tool-audit";
import { isAllowedWebSocketOrigin } from "./ws-origin";

// ── Ed25519 设备身份（进程级复用）──
const ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const { publicKey: _pub, privateKey: _priv } = generateKeyPairSync("ed25519");
const _spki = _pub.export({ type: "spki", format: "der" });
const _raw = _spki.subarray(ED25519_PREFIX.length);
const b64u = (b: Buffer) => b.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
const DEV_PUB = b64u(_raw);
const DEV_ID = createHash("sha256").update(_raw).digest("hex");

const GW_URL = `ws://${process.env.CLAW_REMOTE_HOST || "127.0.0.1"}:${process.env.CLAW_GATEWAY_PORT || "18789"}`;
const GW_TOKEN = process.env.CLAW_GATEWAY_TOKEN || "";
const SCOPES = ["operator.admin", "operator.read", "operator.write"];
const ENABLE_WS_DELTA_PACING = (process.env.WORKFORCE_AGENT_WS_DELTA_PACING || process.env.LINGXIA_WS_DELTA_PACING) === "1";
const ROUTINE_ENGLISH_TOOL_PREAMBLE_RE =
  /^\s*(?:sure[,!\s]*)?(?:ok(?:ay)?[,!\s]*)?(?:(?:i'll|i will|let me|i'm going to|i am going to|i need to)\s+(?:check|look|search|find|fetch|open|use|run|get|take|verify|inspect|read|call|query|look up)\b|i'll\s+go ahead\b)/i;
const ROUTINE_ENGLISH_TOOL_PREAMBLE_PREFIX_RE =
  /^\s*(?:sure[,!\s]*)?(?:ok(?:ay)?[,!\s]*)?(?:i'll|i will|let me|i'm going to|i am going to|i need to)\b/i;

function isRoutineEnglishToolPreambleCandidate(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed.length > 240) return false;
  if (/[\u3400-\u9fff\uf900-\ufaff]/.test(trimmed)) return false;
  if (ROUTINE_ENGLISH_TOOL_PREAMBLE_RE.test(trimmed)) return true;
  if (ROUTINE_ENGLISH_TOOL_PREAMBLE_PREFIX_RE.test(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  return ["i'll", "i will", "let me", "i'm going to", "i am going to", "i need to", "sure", "okay", "ok"]
    .some((prefix) => prefix.startsWith(lower));
}

function isRoutineEnglishToolPreamble(text: string) {
  const trimmed = text.trim();
  return trimmed.length > 0
    && trimmed.length <= 240
    && !/[\u3400-\u9fff\uf900-\ufaff]/.test(trimmed)
    && ROUTINE_ENGLISH_TOOL_PREAMBLE_RE.test(trimmed);
}

function normalizeRuntimeMode(value: unknown): "fast" | "plan" {
  return String(value || "").trim().toLowerCase() === "plan" ? "plan" : "fast";
}

function signPayload(nonce: string) {
  const t = Date.now();
  const p = ["v2", DEV_ID, "openclaw-control-ui", "ui", "operator", SCOPES.join(","), String(t), GW_TOKEN, nonce].join("|");
  return { sig: b64u(sign(null, Buffer.from(p, "utf8"), _priv)), t };
}

export function registerWSProxy(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname !== "/api/claw/ws") return;

    const upgradeStart = Date.now();
    const logUpgradeTiming = (stage: string, extra?: Record<string, unknown>) => {
      console.log("[WS] upgrade timing", {
        stage,
        ms: Date.now() - upgradeStart,
        adoptId: url.searchParams.get("adoptId") || "",
        hasCookie: Boolean(req.headers.cookie),
        host: req.headers.host,
        origin: req.headers.origin,
        ...extra,
      });
    };

    try {
      logUpgradeTiming("start");
      if (!isAllowedWebSocketOrigin(req)) {
        console.warn("[WS] rejected invalid origin", {
          host: req.headers.host,
          origin: req.headers.origin,
        });
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return;
      }
      const fakeRes = { setHeader: () => {}, getHeader: () => undefined } as any;
      const ctx = await createContext({ req: req as any, res: fakeRes, info: {} as any });
      logUpgradeTiming("context", { userId: ctx.user?.id });
      if (!ctx.user) {
        console.warn("[WS] rejected unauthenticated upgrade", {
          path: url.pathname,
          hasCookie: Boolean(req.headers.cookie),
          host: req.headers.host,
          origin: req.headers.origin,
        });
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return;
      }

      const adoptId = url.searchParams.get("adoptId") || "";
      if (!adoptId) { socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); socket.destroy(); return; }
      if (!adoptId.startsWith("lgc-")) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        console.warn("[WS] rejected non-OpenClaw runtime:", adoptId);
        return;
      }
      const channel = url.searchParams.get("channel") || "";
      const conversationId = url.searchParams.get("conversationId") || "";

      const { getClawByAdoptId } = await import("../db");
      const claw = await getClawByAdoptId(adoptId);
      logUpgradeTiming("claw_loaded", { ownerUserId: claw?.userId });
      if (!claw || claw.userId !== ctx.user.id) {
        console.warn("[WS] rejected forbidden upgrade", {
          adoptId,
          userId: ctx.user.id,
          ownerUserId: claw?.userId,
          host: req.headers.host,
          origin: req.headers.origin,
        });
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return;
      }

      const dbAgent = String((claw as any).agentId || "").trim();
      const trialId = `trial_${adoptId}`;
      const agentId = existsSync(openClawAgentDir(trialId)) ? trialId : dbAgent;
      logUpgradeTiming("handle_upgrade", { agentId });

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, { adoptId, agentId, userId: ctx.user!.id, channel, conversationId });
      });
    } catch (err) {
      console.error("[WS] upgrade error:", err);
      socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n"); socket.destroy();
    }
  });

  wss.on("connection", (client: WebSocket, _req: IncomingMessage, meta: { adoptId: string; agentId: string; userId: number; channel?: string; conversationId?: string }) => {
    console.log("[WS] connected:", meta.adoptId);

    let gw: WebSocket | null = null;
    let ready = false;
    let sessionKey: string | null = null;
    let pending: string[] = [];
    const pendingBrowserMessages: string[] = [];
    let lastUserSendMs: number = 0;
    let memAcc: ResponseAccumulator | null = null;

    // ── 2026-04-29 批次 b：WS 路径截断诊断 + recover trigger（同 HTTP claw-chat.ts 语义）──
    // 完整设计见 memory project_sse_truncation_diag —— WS 路径裸 bug：lifecycle.end 是唯一
    // 完成信号，gw close/error 异常时不通知前端。这里加 finalize guard + truncated 触发。
    let chatStartedAt = 0;            // 当前 chat 起始（user 发消息时设置）
    let sawLifecycleEnd = false;      // 见到 lifecycle.end 才算正常完成
    let chatFinalized = false;        // 单一 finalize guard
    let activeChat = false;           // 是否有 active chat 在跑（用于 gw close 是否触发 truncated）
    let clientClosed = false;         // 浏览器主动断开（gw close 时用以区分 client_close vs gw_close）
    let activeClientRunId: string | undefined;
    let activeUserPrefersChinese = false;
    let pendingAssistantPreamble = "";
    let preambleWindowOpen = false;
    let lastChatSnapshotText = "";
    let sawAssistantDelta = false;
    let deferredClientSendDelayMs = 0;

    const splitLargeDeltaForClient = (content: string): string[] => {
      const text = String(content || "");
      if (text.length <= 96) return text ? [text] : [];

      const chunks: string[] = [];
      let buf = "";
      const pushBuf = () => {
        if (!buf) return;
        chunks.push(buf);
        buf = "";
      };
      const pushLong = (part: string) => {
        for (let i = 0; i < part.length; i += 72) {
          chunks.push(part.slice(i, i + 72));
        }
      };

      const parts = text.match(/[\s\S]*?(?:[。！？!?；;：:\n]+|\.\s+|,\s+|$)/g)?.filter(Boolean) || [text];
      for (const part of parts) {
        if (part.length > 144) {
          pushBuf();
          pushLong(part);
          continue;
        }
        if ((buf + part).length > 88) pushBuf();
        buf += part;
      }
      pushBuf();
      return chunks.length > 0 ? chunks : [text];
    };

    const emitAssistantDelta = (content: string) => {
      if (!content) return;
      if (memAcc) {
        const wasEmpty = memAcc.getBuffer().length === 0;
        memAcc.appendDelta(content);
        if (wasEmpty) {
          console.log("[MEMORY-DEBUG] first delta received");
        }
      }
      const chunks = splitLargeDeltaForClient(content);
      const shouldPace = chunks.length > 1;
      for (const chunk of chunks) {
        const frame = {
          choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
        };
        if (ENABLE_WS_DELTA_PACING && deferredClientSendDelayMs > 0) {
          const delay = deferredClientSendDelayMs;
          setTimeout(() => sendToClient(frame), delay);
        } else {
          sendToClient(frame);
        }
        if (ENABLE_WS_DELTA_PACING && (shouldPace || deferredClientSendDelayMs > 0)) {
          deferredClientSendDelayMs += 55;
        }
      }
    };

    const flushPendingAssistantPreamble = () => {
      if (pendingAssistantPreamble) {
        emitAssistantDelta(pendingAssistantPreamble);
        pendingAssistantPreamble = "";
      }
      preambleWindowOpen = false;
    };

    // 正常完成 finalize：在 lifecycle.end 已发 __stream_end，这里只写日志
    const finalizeChatNormal = () => {
      if (chatFinalized) return;
      chatFinalized = true;
      activeChat = false;
      markChatRunComplete(String(sessionKey || ""), activeClientRunId, "lifecycle_end");
      if (sessionKey && chatStartedAt > 0) {
        scheduleOpenClawToolAudit({
          runtimeAgentId: meta.agentId,
          sessionKey,
          adoptId: meta.adoptId,
          userId: meta.userId,
          startedAtMs: chatStartedAt,
          endedAtMs: Date.now(),
          channel: meta.channel || "web",
          transport: "ws",
        });
      }
      appendLogAsync("claw-exec-detail.log", {
        ts: new Date().toISOString(),
        event: "ws_chat_response",
        transport: "ws",
        adoptId: meta.adoptId,
        agentId: meta.agentId,
        userId: meta.userId,
        sessionKey,
        durationMs: chatStartedAt > 0 ? Date.now() - chatStartedAt : 0,
        sawLifecycleEnd,
        endReason: "natural",
        flag: process.env.SSE_TRUNCATE_DETECT || "off",
      });
    };

    // 异常 finalize：发 __stream_truncated（前端复用 handleStreamTruncated 启动 recover）
    const finalizeChatTruncated = (reason: string) => {
      if (chatFinalized) return;
      chatFinalized = true;
      activeChat = false;
      markChatRunComplete(String(sessionKey || ""), activeClientRunId, reason === "gw_error" ? "gateway_error" : "gateway_close");

      const flagMode = String(process.env.SSE_TRUNCATE_DETECT || "off").toLowerCase();
      const allowlist = String(process.env.SSE_TRUNCATE_DETECT_USERS || "")
        .split(",").map(s => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
      const flagOn = flagMode === "on"
        || (flagMode === "allowlist" && allowlist.includes(Number(meta.userId)));

      const streamEndMs = Date.now();
      if (sessionKey && chatStartedAt > 0) {
        scheduleOpenClawToolAudit({
          runtimeAgentId: meta.agentId,
          sessionKey,
          adoptId: meta.adoptId,
          userId: meta.userId,
          startedAtMs: chatStartedAt,
          endedAtMs: streamEndMs,
          channel: meta.channel || "web",
          transport: "ws",
        });
      }
      if (flagOn) {
        sendToClient({
          __stream_truncated: true,
          adoptId: meta.adoptId,
          sessionKey,
          endReason: reason,
          chatCompletionId: null,    // WS 路径无 OpenAI 兼容 chunk id
          streamEndMs,
          startedAt: chatStartedAt,
          transport: "ws",
          triggeredBy: reason,
        });
      } else {
        // off 模式保持兼容旧行为：发 __stream_end + finish_reason stop（用户看到完成）
        sendToClient({ __stream_end: true });
        sendToClient({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }

      appendLogAsync("claw-exec-detail.log", {
        ts: new Date().toISOString(),
        event: "ws_chat_response_abnormal",
        transport: "ws",
        adoptId: meta.adoptId,
        agentId: meta.agentId,
        userId: meta.userId,
        sessionKey,
        durationMs: chatStartedAt > 0 ? streamEndMs - chatStartedAt : 0,
        sawLifecycleEnd,
        endReason: reason,
        flag: flagMode,
        triggeredBy: reason,
      });
    };

    // 追踪当前工具调用的命令输出（toolCallId → output buffer）
    const cmdOutputBuffers = new Map<string, string>();

    const sendToClient = (data: object) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      }
    };

    // Acknowledge the browser WebSocket as soon as the HTTP upgrade completes.
    // OpenClaw Gateway/session readiness is tracked separately below; otherwise
    // a slow Gateway handshake makes the browser misclassify WS as unavailable.
    sendToClient({
      type: "connected",
      agentId: meta.agentId,
      channel: meta.channel,
      conversationId: meta.conversationId,
      ready: false,
    });

    const sendToClientAfterDeltaQueue = (data: object) => {
      if (deferredClientSendDelayMs <= 0) {
        sendToClient(data);
        return;
      }
      const delay = deferredClientSendDelayMs + 10;
      deferredClientSendDelayMs = delay + 1;
      setTimeout(() => sendToClient(data), delay);
    };

    const emitWorkspaceFiles = () => {
      try {
        const wsDir = openClawWorkspaceDir(meta.agentId);
        if (!existsSync(wsDir) || lastUserSendMs <= 0) return;

        const SKIP_DIRS = new Set(["skills", "memory", "node_modules", ".git", ".dreams", "dist", "build", ".openclaw"]);
        const newFiles: Array<{ name: string; size: number; path: string }> = [];
        const scanDir = (dir: string, relBase: string, depth: number) => {
          if (depth > 3) return;
          try {
            for (const entry of readdirSync(dir)) {
              if (entry.startsWith(".")) continue;
              if (depth === 0 && SKIP_DIRS.has(entry)) continue;
              const full = `${dir}/${entry}`;
              const rel = relBase ? `${relBase}/${entry}` : entry;
              try {
                const s = statSync(full);
                if (s.isFile()) {
                  if (s.mtimeMs >= lastUserSendMs - 1000) {
                    newFiles.push({ name: entry, size: s.size, path: rel });
                  }
                } else if (s.isDirectory()) {
                  scanDir(full, rel, depth + 1);
                }
              } catch {}
            }
          } catch {}
        };
        scanDir(wsDir, "", 0);
        if (newFiles.length > 0) {
          sendToClient({ _event: "workspace_files", adoptId: meta.adoptId, files: newFiles });
        }
      } catch (e) {
        console.error("[WS] workspace scan error:", e);
      }
    };

    gw = new WebSocket(GW_URL, { headers: { Origin: INTERNAL_BASE_URL } });

    gw.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());

        // ── Gateway 握手 ──
        if (msg.event === "connect.challenge") {
          const n = msg.payload.nonce;
          const { sig, t } = signPayload(n);
          gw!.send(JSON.stringify({
            type: "req", id: randomUUID(), method: "connect",
            params: {
              minProtocol: 3, maxProtocol: 4,
              client: { id: "openclaw-control-ui", version: "1.0.0", platform: "lingxia", mode: "ui" },
              role: "operator", scopes: SCOPES, auth: { token: GW_TOKEN },
              device: { id: DEV_ID, publicKey: DEV_PUB, signature: sig, signedAt: t, nonce: n },
              caps: ["tool-events"],
            },
          }));
          return;
        }

        // ── Session 创建成功（必须在认证成功判断之前，否则会无限循环）──
        if (msg.type === "res" && msg.id === "init-session" && msg.ok) {
          sessionKey = msg.payload?.key;
          ready = true;
          console.log("[WS] ready:", meta.adoptId, "session:", sessionKey);
          sendToClient({ type: "connected", agentId: meta.agentId, sessionKey, channel: meta.channel, conversationId: meta.conversationId, ready: true });
          for (const rawPending of pendingBrowserMessages.splice(0)) {
            client.emit("message", Buffer.from(rawPending));
          }
          for (const p of pending) gw!.send(p);
          pending = [];
          return;
        }

        // ── 认证成功 → 复用 main session（保持上下文跨 WS 重连延续） ──
        // 关键：根据 sessionEpoch 选 key，与 HTTP claw-chat.ts 保持一致
        // epoch=0 → agent:xxx:main（旧默认）
        // epoch>0 → agent:xxx:main:e{epoch}（reset 后用新 key 实现真正"新会话"）
        if (msg.type === "res" && msg.ok === true && !ready) {
          const epoch = readSessionEpoch(meta.adoptId);
          const sessionScope = buildSessionRegistryScope(meta.channel, meta.conversationId);
          const foundSessionKey = lookupSessionRegistry(meta.adoptId, meta.agentId, epoch, sessionScope);
          const mainSessionKey = foundSessionKey || buildRuntimeSessionKey({
            runtimeAgentId: meta.agentId,
            channel: meta.channel,
            conversationId: meta.conversationId,
            epoch,
          });
          if (!foundSessionKey) {
            upsertSessionRegistry(meta.adoptId, meta.agentId, mainSessionKey, epoch, sessionScope);
          }
          console.log("[WS] using session:", mainSessionKey, "epoch:", epoch);
          gw!.send(JSON.stringify({ type: "req", id: "init-session", method: "sessions.create", params: { agentId: meta.agentId, key: mainSessionKey } }));
          return;
        }

        // ── 认证/创建失败 ──
        if (msg.type === "res" && msg.ok === false && !ready) {
          console.error("[WS] gateway error:", msg.error?.message);
          sendToClient({ type: "error", message: msg.error?.message || "Gateway error" });
          client.close();
          return;
        }

        // ── 跳过噪声事件 ──
        if (msg.event === "health" || msg.event === "tick" || msg.event === "heartbeat") return;

        const normalized = normalizeWsEvent(msg, sessionKey);
        if (normalized.kind === "events") {
          const rawEvent = typeof msg.event === "string" ? msg.event : "";
          const rawPayload = msg.payload && typeof msg.payload === "object" ? msg.payload as any : {};
          const rawStream = typeof rawPayload.stream === "string" ? rawPayload.stream : "";
          const rawState = typeof rawPayload.state === "string" ? rawPayload.state : "";
          if (sessionKey && activeClientRunId) {
            touchChatRun(sessionKey, activeClientRunId, "ws_event");
          }
          for (const evt of normalized.events) {
            switch (evt.type) {
              case "delta":
                if (rawEvent === "chat" && rawState === "delta" && sawAssistantDelta) {
                  break;
                }
                if (rawEvent === "agent" && rawStream === "assistant") {
                  sawAssistantDelta = true;
                }
                if (preambleWindowOpen && activeUserPrefersChinese) {
                  pendingAssistantPreamble += evt.content;
                  if (isRoutineEnglishToolPreambleCandidate(pendingAssistantPreamble)) {
                    break;
                  }
                  flushPendingAssistantPreamble();
                } else {
                  emitAssistantDelta(evt.content);
                }
                break;

              case "chat_snapshot": {
                if (sawAssistantDelta) {
                  break;
                }
                const snapshot = evt.content;
                const delta = snapshot.startsWith(lastChatSnapshotText)
                  ? snapshot.slice(lastChatSnapshotText.length)
                  : snapshot;
                lastChatSnapshotText = snapshot;
                if (delta) emitAssistantDelta(delta);
                break;
              }

              case "thinking":
                sendToClient({
                  choices: [{ index: 0, delta: { reasoning_content: evt.content }, finish_reason: null }],
                });
                break;

              case "tool_call":
                if (evt.phase === "start") {
                  if (preambleWindowOpen && pendingAssistantPreamble) {
                    if (isRoutineEnglishToolPreamble(pendingAssistantPreamble)) {
                      pendingAssistantPreamble = "";
                      preambleWindowOpen = false;
                    } else {
                      flushPendingAssistantPreamble();
                    }
                  } else {
                    preambleWindowOpen = false;
                  }
                  const tcId = evt.toolCallId || `tc_${Date.now()}`;
                  cmdOutputBuffers.set(tcId, "");
                  sendToClient({
                    _event: "tool_call",
                    id: tcId,
                    name: evt.name || "tool",
                    arguments: JSON.stringify(evt.args || {}),
                  });
                } else {
                  const tcId = evt.toolCallId || "";
                  const buffered = cmdOutputBuffers.get(tcId) || "";
                  cmdOutputBuffers.delete(tcId);
                  sendToClient({
                    _event: "tool_result",
                    tool_call_id: tcId,
                    result: buffered || (typeof evt.result === "string" ? evt.result : ""),
                    is_error: Boolean(evt.isError),
                  });
                }
                break;

              case "command_output":
                if (evt.phase === "delta") {
                  const tcId = evt.toolCallId || "";
                  if (tcId && cmdOutputBuffers.has(tcId)) {
                    cmdOutputBuffers.set(tcId, (cmdOutputBuffers.get(tcId) || "") + (evt.output || ""));
                  }
                } else {
                  const tcId = evt.toolCallId || "";
                  if (tcId && evt.output) {
                    cmdOutputBuffers.set(tcId, evt.output);
                  }
                }
                break;

              case "item_status":
                sendToClient({ __status: evt.progressText, _event: "agent_status", kind: "progress", label: evt.progressText });
                break;

              case "lifecycle_end":
                flushPendingAssistantPreamble();
                emitWorkspaceFiles();
                sawLifecycleEnd = true;
                sendToClientAfterDeltaQueue({ __stream_end: true });
                sendToClientAfterDeltaQueue({
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                });
                finalizeChatNormal();
                break;

              case "chat_final":
                flushPendingAssistantPreamble();
                if (evt.content && !sawAssistantDelta) {
                  const delta = evt.content.startsWith(lastChatSnapshotText)
                    ? evt.content.slice(lastChatSnapshotText.length)
                    : evt.content;
                  lastChatSnapshotText = evt.content;
                  if (delta) emitAssistantDelta(delta);
                }
                if (memAcc) {
                  console.log("[MEMORY-DEBUG] chat final, flushing memAcc, buffer len:", memAcc.getBuffer().length);
                  memAcc.flush();
                  memAcc = null;
                }
                sendToClientAfterDeltaQueue({
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                });
                markChatRunComplete(String(sessionKey || ""), activeClientRunId, "chat_final");
                if (sessionKey && chatStartedAt > 0) {
                  scheduleOpenClawToolAudit({
                    runtimeAgentId: meta.agentId,
                    sessionKey,
                    adoptId: meta.adoptId,
                    userId: meta.userId,
                    startedAtMs: chatStartedAt,
                    endedAtMs: Date.now(),
                    channel: meta.channel || "web",
                    transport: "ws",
                  });
                }
                break;

              case "error":
                sendToClient({ error: evt.message });
                markChatRunComplete(String(sessionKey || ""), activeClientRunId, "gateway_error");
                break;

              default:
                break;
            }
          }
          return;
        }

        // ── 已知 no-op 事件短路（避免触发 unmatched warn 日志噪音）──
        // 这两类事件被 normalizer (event-normalizer.ts) 显式 ignore（return []）：
        //   - lifecycle.start: agent stream 启动信号，平台不消费
        //   - chat.state=delta: cumulative message snapshot，平台文本来自 agent/assistant，不重复 append
        //   - item.start/end: item 生命周期边界，平台只消费 item.update(progressText)
        // 修改 normalizer 的 no-op 列表时记得同步这里——双层 ignore 必须保持同步，否则要么
        // 出现"normalizer 漏覆盖" warn 噪音，要么"无声 drop"再次成 bug（参考 2026-04-29 教训）
        if (normalized.kind === "noop" || normalized.kind === "ignored") {
          return;
        }
        if (normalized.kind === "unmatched") {
          console.warn("[WS] unmatched runtime event after normalizer:", {
            event: msg.event,
            stream: msg.payload?.stream,
            state: msg.payload?.state,
            phase: msg.payload?.data?.phase,
            sessionKey: msg.payload?.sessionKey,
            reason: normalized.reason,
          });
          return;
        }

        // Legacy agent/chat fallback removed: Runtime events are normalized by normalizeWsEvent above.
        // RPC response handling remains below.
        if (msg.type === "res" && msg.ok === true && ready) return;

        // ── 其他 RPC 错误 ──
        if (msg.type === "res" && msg.ok === false && ready) {
          sendToClient({ error: msg.error?.message || "RPC error" });
        }
      } catch (e) {
        console.error("[WS] parse error:", e);
      }
    });

    // ── 心跳：每 30 秒向浏览器发 ping，防止长任务期间 WS 空闲断连 ──
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const startHeartbeat = () => {
      if (heartbeatTimer) return;
      heartbeatTimer = setInterval(() => {
        if (client.readyState === WebSocket.OPEN) {
          client.ping();
        }
      }, 30000);
    };
    const stopHeartbeat = () => {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    };

    gw.on("open", () => { console.log("[WS-GW] opened for", meta.adoptId); startHeartbeat(); });
    gw.on("error", (e) => {
      console.error("[WS] gw error:", meta.adoptId, e.message);
      // 2026-04-29 批次 b（GPT round-7 修正）：clientClosed 时跳过——用户已离开不该触发 recover
      if (clientClosed) return;
      if (activeChat && !chatFinalized) {
        finalizeChatTruncated("gw_error");
      }
    });
    gw.on("close", (code) => {
      // 2026-04-29 批次 b（GPT round-7 修正）：客户端主动断 vs Gateway 异常断要分开
      // - clientClosed=true：用户关浏览器/断网，不发 __stream_truncated（用户已不可达），不算 abnormal 指标
      //   只写一条 client_closed 诊断日志，cleanup state，guard 后续 gw.error 不再 finalize
      // - clientClosed=false：真 Gateway 异常 → truncated → 前端启动 recover
      if (clientClosed) {
        if (activeChat && !chatFinalized) {
          chatFinalized = true;
          activeChat = false;
          appendLogAsync("claw-exec-detail.log", {
            ts: new Date().toISOString(),
            event: "ws_chat_client_closed",
            transport: "ws",
            adoptId: meta.adoptId,
            agentId: meta.agentId,
            userId: meta.userId,
            sessionKey,
            durationMs: chatStartedAt > 0 ? Date.now() - chatStartedAt : 0,
            sawLifecycleEnd,
            flag: process.env.SSE_TRUNCATE_DETECT || "off",
          });
        }
        return;
      }
      if (activeChat && !chatFinalized) {
        finalizeChatTruncated("gw_close");
      }
      if (client.readyState === WebSocket.OPEN) {
        const safeCode = (typeof code === "number" && code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006) ? code : 1011;
        try { client.close(safeCode); } catch { /* swallow: invalid code / already closed */ }
      }
    });

    // ── 浏览器消息 ──
    client.on("message", async (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "chat") {
          if (!sessionKey) {
            pendingBrowserMessages.push(raw.toString());
            sendToClient({
              __status: "正在初始化 OpenClaw 会话",
              _event: "agent_status",
              kind: "progress",
              label: "正在初始化 OpenClaw 会话",
            });
            return;
          }
          const rawUserMessage = String(msg.message || "");
          const gatewayMessage = buildRuntimeUserMessage(rawUserMessage);
          lastUserSendMs = Date.now();
          // 2026-04-29 批次 b：重置 chat-level state，准备追踪本轮 chat 完成态
          chatStartedAt = lastUserSendMs;
          sawLifecycleEnd = false;
          chatFinalized = false;
          activeChat = true;
          activeUserPrefersChinese = userLikelyUsesChinese(rawUserMessage);
          pendingAssistantPreamble = "";
          preambleWindowOpen = activeUserPrefersChinese;
          lastChatSnapshotText = "";
          sawAssistantDelta = false;
          deferredClientSendDelayMs = 0;
          activeClientRunId = normalizeClientRunId((msg as any).clientRunId);
          const runtimeMode = normalizeRuntimeMode((msg as any).runtimeMode);
          if (sessionKey && activeClientRunId) {
            const run = markChatRunStarted({
              sessionKey,
              clientRunId: activeClientRunId,
              transport: "ws",
              message: rawUserMessage,
            });
            if (run?.status === "in_flight") {
              sendToClient({
                __in_flight: true,
                transport: "ws",
                sessionKey,
                clientRunId: activeClientRunId,
                runId: run.run.runId,
                startedAt: run.run.startedAt,
                lastEventAt: run.run.lastEventAt,
                reason: "duplicate_ws_send",
              });
              return;
            }
          }
          sendToClient({
            __status: "已连接 OpenClaw，正在处理请求",
            _event: "agent_status",
            kind: "progress",
            label: "已连接 OpenClaw，正在处理请求",
          });
          // 每次用户发消息，创建新的记忆缓冲器
          if (memAcc) memAcc.flush(); // flush 上一轮
          memAcc = new ResponseAccumulator(meta.userId, "main-chat", rawUserMessage);

          // ── 平台意图路由（与 HTTP 路径共用 intent-agent）──
          console.log("[WS-PM] entering intent routing for:", rawUserMessage.slice(0, 30));
          try {
            const wsWriter = new WsStreamWriter(client, WebSocket.OPEN);
            console.log("[PM-DEBUG] routeMessage called, msg:", rawUserMessage.slice(0, 50));
            const handled = await routeMessage(meta.adoptId, rawUserMessage, wsWriter);
            if (handled) {
              markChatRunComplete(String(sessionKey || ""), activeClientRunId, "platform_handled");
              activeChat = false;
              chatFinalized = true;
              return;
            } // 平台已处理，不发 Gateway
          } catch (e) {
            console.error("[WS] platform router error:", e);
          }

          const chatRunId = activeClientRunId || randomUUID();
          // OpenClaw 2026.4.29 routes WebChat through chat.send. sessions.send no
          // longer carries WebChat-specific controls such as thinking/idempotency.
          const rpc = JSON.stringify({
            type: "req",
            id: randomUUID(),
            method: "chat.send",
            params: {
              sessionKey,
              message: gatewayMessage,
              idempotencyKey: chatRunId,
              thinking: runtimeMode === "plan" ? "on" : "off",
              deliver: false,
            },
          });
          if (ready && gw?.readyState === WebSocket.OPEN) gw.send(rpc);
          else pending.push(rpc);
        }
      } catch {}
    });

    client.on("close", () => {
      clientClosed = true;
      console.log("[WS] disconnected:", meta.adoptId);
      stopHeartbeat();
      gw?.close();
    });
    client.on("error", () => {
      clientClosed = true;
      stopHeartbeat();
      gw?.close();
    });
  });

  console.log("[WS-PROXY] registered at /api/claw/ws");
}
