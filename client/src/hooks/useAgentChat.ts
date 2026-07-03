import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatEvent } from "@shared/runtime/chat-event";
import { reduceAgentChatState, type AgentChatMessage } from "@/lib/chat-state-reducer";
import { HttpChatTransport } from "@/lib/http-chat-transport";
import type { ChatTransport } from "@/lib/chat-transport";
import { WsChatTransport } from "@/lib/ws-chat-transport";

type RecoverStatusResponse =
  | { status: "pending"; elapsedMs?: number; reason?: string }
  | { status: "ready"; text: string; capturedAt?: string | number }
  | { status: "failed"; reason?: string; finalStatus?: string };

type ChatTransportName = "http" | "ws";

type FirstEventWaiter = {
  transport: ChatTransportName;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

export type UseAgentChatOptions = {
  adoptId?: string | null;
  apiBase?: string;
  channel?: string;
  conversationId?: string;
  isHermesRuntime?: boolean;
  memoryEnabled?: boolean;
  contextTurns?: number;
  runtimeMode?: "fast" | "plan";
  historyStorageKey?: string;
  now?: () => number;
};

export type UseAgentChatResult = {
  messages: AgentChatMessage[];
  isStreaming: boolean;
  connStatus: "idle" | "connected" | "reconnecting" | "error";
  send(message: string): Promise<void>;
  abort(reason?: string): void;
  clear(): void;
  restore(messages: AgentChatMessage[]): void;
  dispatchEvent(event: ChatEvent, targetMessageId?: string): void;
};

const WS_FIRST_EVENT_TIMEOUT_MS = 150000;
const STREAMING_FIRST_EVENT_IDLE_TIMEOUT_MS = 180000;
const STREAMING_IDLE_TIMEOUT_MS = 90000;
const makeLxMsgId = () => `lx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const makeClientRunId = () => `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

function timeLabel() {
  return new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function isTerminalTransportEvent(event: ChatEvent) {
  return event.type === "transport.stream_end"
    || event.type === "transport.done"
    || event.type === "transport.length_limit"
    || event.type === "transport.error"
    || event.type === "error"
    || (event.type === "finish_reason" && event.reason === "stop");
}

function isFirstChatEvent(event: ChatEvent) {
  return event.type !== "transport.connected" && event.type !== "transport.disconnected";
}

function isStreamingProgressEvent(event: ChatEvent) {
  return event.type === "delta"
    || event.type === "thinking"
    || event.type === "tool_call"
    || event.type === "command_output"
    || event.type === "item_status"
    || event.type === "workspace.files"
    || event.type === "agent.dispatch"
    || event.type === "agent.tool_update"
    || event.type === "agent.complete"
    || event.type === "perf";
}

export function useAgentChat(options: UseAgentChatOptions): UseAgentChatResult {
  const {
    adoptId,
    apiBase = import.meta.env.VITE_API_URL || "",
    channel,
    conversationId,
    isHermesRuntime = false,
    memoryEnabled,
    contextTurns,
    runtimeMode = "fast",
    historyStorageKey,
    now = Date.now,
  } = options;

  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [connStatus, setConnStatus] = useState<UseAgentChatResult["connStatus"]>("idle");

  const messagesRef = useRef(messages);
  const activeAssistantIdRef = useRef<string | undefined>(undefined);
  const abortControllerRef = useRef<AbortController | null>(null);
  const recoveryTimersRef = useRef(new Map<string, ReturnType<typeof setInterval>>());
  const httpTransportRef = useRef<ChatTransport | null>(null);
  const wsTransportRef = useRef<ChatTransport | null>(null);
  const activeTransportRef = useRef<ChatTransportName | null>(null);
  const firstEventWaiterRef = useRef<FirstEventWaiter | null>(null);
  const activeSendStartedAtRef = useRef<number | undefined>(undefined);
  const inFlightRecoveringRef = useRef(false);
  const isMountedRef = useRef(true);
  const skipNextHistoryPersistRef = useRef<string>("");
  const streamingWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (!historyStorageKey) return;
    skipNextHistoryPersistRef.current = historyStorageKey;
    try {
      const saved = localStorage.getItem(historyStorageKey);
      setMessages(saved ? JSON.parse(saved) : []);
    } catch {
      setMessages([]);
    }
  }, [historyStorageKey]);

  useEffect(() => {
    if (!historyStorageKey) return;
    if (skipNextHistoryPersistRef.current === historyStorageKey) {
      skipNextHistoryPersistRef.current = "";
      return;
    }
    try {
      if (messages.length === 0) {
        localStorage.removeItem(historyStorageKey);
      } else {
        localStorage.setItem(historyStorageKey, JSON.stringify(messages.slice(-100)));
      }
    } catch {}
  }, [messages, historyStorageKey]);

  const transports = useMemo(() => {
    const http = new HttpChatTransport(apiBase);
    const ws = new WsChatTransport(apiBase);
    httpTransportRef.current = http;
    wsTransportRef.current = ws;
    return { http, ws };
  }, [apiBase]);

  const dispatchEvent = useCallback((event: ChatEvent, explicitTargetMessageId?: string) => {
    if (!isMountedRef.current) return;

    const targetMessageId = explicitTargetMessageId
      ?? ("messageId" in event && typeof event.messageId === "string" ? event.messageId : undefined)
      ?? activeAssistantIdRef.current;

    const applyMessageEvent = () => setMessages((prev) => reduceAgentChatState(prev, event, {
      targetMessageId,
      adoptId: adoptId ?? undefined,
      nowMs: now(),
    }));
    if (isTerminalTransportEvent(event) || event.type === "transport.recovered" || event.type === "transport.recovery_failed") {
      applyMessageEvent();
    } else {
      startTransition(applyMessageEvent);
    }

    if (isTerminalTransportEvent(event)) {
      inFlightRecoveringRef.current = false;
      setIsStreaming(false);
    }
    if (event.type === "transport.recovered" || event.type === "transport.recovery_failed") {
      inFlightRecoveringRef.current = false;
      setIsStreaming(false);
    }
  }, [adoptId, now]);

  const clearStreamingWatchdog = useCallback(() => {
    if (streamingWatchdogRef.current) {
      clearTimeout(streamingWatchdogRef.current);
      streamingWatchdogRef.current = null;
    }
  }, []);

  const armStreamingWatchdog = useCallback((messageId: string | undefined, timeoutMs: number) => {
    clearStreamingWatchdog();
    if (!messageId) return;
    streamingWatchdogRef.current = setTimeout(() => {
      if (!isMountedRef.current) return;
      streamingWatchdogRef.current = null;
      const activeMessageId = activeAssistantIdRef.current ?? messageId;
      inFlightRecoveringRef.current = false;
      abortControllerRef.current?.abort("stream_timeout");
      activeTransportRef.current = null;
      httpTransportRef.current?.close("stream_timeout");
      wsTransportRef.current?.close("stream_timeout");
      firstEventWaiterRef.current?.reject(new Error("stream_timeout"));
      firstEventWaiterRef.current = null;
      dispatchEvent({ type: "transport.error", message: "stream_timeout" }, activeMessageId);
    }, timeoutMs);
  }, [clearStreamingWatchdog, dispatchEvent]);

  const startRecovery = useCallback((event: Extract<ChatEvent, { type: "transport.truncated" }>, messageId: string) => {
    if (!adoptId || typeof event.streamEndMs !== "number") {
      dispatchEvent({ type: "transport.recovery_failed", messageId, reason: "missing_recovery_fields" });
      return;
    }
    if (recoveryTimersRef.current.has(messageId)) return;

    let attempts = 0;
    const poll = async () => {
      attempts += 1;
      try {
        const response = await fetch(`${apiBase}/api/claw/recover-status`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            adoptId,
            streamEndMs: event.streamEndMs,
            chatCompletionId: event.chatCompletionId,
          }),
        });
        const data = await response.json() as RecoverStatusResponse;
        if (data.status === "ready") {
          clearInterval(timer);
          recoveryTimersRef.current.delete(messageId);
          dispatchEvent({ type: "transport.recovered", messageId, text: data.text, capturedAt: data.capturedAt });
        } else if (data.status === "failed") {
          clearInterval(timer);
          recoveryTimersRef.current.delete(messageId);
          dispatchEvent({ type: "transport.recovery_failed", messageId, reason: data.reason || data.finalStatus });
        } else if (attempts >= 60) {
          clearInterval(timer);
          recoveryTimersRef.current.delete(messageId);
          dispatchEvent({ type: "transport.recovery_failed", messageId, reason: "timeout" });
        }
      } catch (error) {
        if (attempts >= 60) {
          clearInterval(timer);
          recoveryTimersRef.current.delete(messageId);
          dispatchEvent({
            type: "transport.recovery_failed",
            messageId,
            reason: error instanceof Error ? error.message : "recover_request_failed",
          });
        }
      }
    };

    const timer = setInterval(poll, 5000);
    recoveryTimersRef.current.set(messageId, timer);
    void poll();
  }, [adoptId, apiBase, dispatchEvent]);

  const handleEvent = useCallback((event: ChatEvent) => {
    if (isTerminalTransportEvent(event) || event.type === "transport.recovered" || event.type === "transport.recovery_failed") {
      clearStreamingWatchdog();
    } else if (isStreamingProgressEvent(event)) {
      armStreamingWatchdog(activeAssistantIdRef.current, STREAMING_IDLE_TIMEOUT_MS);
    }

    if (event.type === "transport.truncated") {
      clearStreamingWatchdog();
      const messageId = event.messageId || activeAssistantIdRef.current;
      if (!messageId) return;
      const enriched = { ...event, messageId };
      dispatchEvent(enriched, messageId);
      startRecovery(enriched, messageId);
      setIsStreaming(false);
      return;
    }
    if (event.type === "transport.in_flight") {
      clearStreamingWatchdog();
      const messageId = activeAssistantIdRef.current;
      if (!messageId) return;
      inFlightRecoveringRef.current = true;
      setIsStreaming(true);
      startRecovery({
        type: "transport.truncated",
        messageId,
        transport: event.transport,
        sessionKey: event.sessionKey,
        streamEndMs: activeSendStartedAtRef.current ?? event.startedAt ?? Date.now() - 60_000,
        startedAt: event.startedAt,
        reason: event.reason || "in_flight",
      }, messageId);
      return;
    }
    if (inFlightRecoveringRef.current && (event.type === "transport.done" || event.type === "transport.stream_end")) {
      return;
    }
    dispatchEvent(event);
  }, [armStreamingWatchdog, clearStreamingWatchdog, dispatchEvent, startRecovery]);

  const settleFirstEventWaiter = useCallback((transport: ChatTransportName, event: ChatEvent) => {
    const waiter = firstEventWaiterRef.current;
    if (!waiter || waiter.transport !== transport || !isFirstChatEvent(event)) return;
    clearTimeout(waiter.timer);
    firstEventWaiterRef.current = null;
    waiter.resolve();
  }, []);

  const waitForFirstEvent = useCallback((transport: ChatTransportName, timeoutMs: number, signal?: AbortSignal) => (
    new Promise<void>((resolve, reject) => {
      firstEventWaiterRef.current?.reject(new Error("first_event_wait_replaced"));
      const timer = setTimeout(() => {
        if (firstEventWaiterRef.current?.transport === transport) {
          firstEventWaiterRef.current = null;
        }
        reject(new Error(`${transport}_first_event_timeout`));
      }, timeoutMs);
      firstEventWaiterRef.current = { transport, resolve, reject, timer };

      signal?.addEventListener("abort", () => {
        if (firstEventWaiterRef.current?.transport === transport) {
          clearTimeout(timer);
          firstEventWaiterRef.current = null;
        }
        reject(new Error("aborted"));
      }, { once: true });
    })
  ), []);

  useEffect(() => {
    const unsubscribeHttp = transports.http.subscribe((event) => {
      if (activeTransportRef.current !== "http") return;
      settleFirstEventWaiter("http", event);
      handleEvent(event);
    });
    const unsubscribeWs = transports.ws.subscribe((event) => {
      if (activeTransportRef.current !== "ws") return;
      settleFirstEventWaiter("ws", event);
      handleEvent(event);
    });
    return () => {
      unsubscribeHttp();
      unsubscribeWs();
    };
  }, [handleEvent, settleFirstEventWaiter, transports]);

  useEffect(() => () => {
    isMountedRef.current = false;
    for (const timer of recoveryTimersRef.current.values()) clearInterval(timer);
    recoveryTimersRef.current.clear();
    firstEventWaiterRef.current?.reject(new Error("unmount"));
    firstEventWaiterRef.current = null;
    abortControllerRef.current?.abort();
    httpTransportRef.current?.close("unmount");
    wsTransportRef.current?.close("unmount");
    clearStreamingWatchdog();
  }, []);

  const send = useCallback(async (message: string) => {
    if (!adoptId || !message.trim()) return;

    const userId = makeLxMsgId();
    const assistantId = makeLxMsgId();
    const clientRunId = makeClientRunId();
    activeSendStartedAtRef.current = now();
    inFlightRecoveringRef.current = false;
    activeAssistantIdRef.current = assistantId;
    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", text: message, timeLabel: timeLabel() },
      { id: assistantId, role: "assistant", text: "", timeLabel: timeLabel() },
    ]);

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsStreaming(true);
    setConnStatus("connected");
    armStreamingWatchdog(assistantId, STREAMING_FIRST_EVENT_IDLE_TIMEOUT_MS);

    const payload = {
      adoptId,
      message,
      channel,
      conversationId,
      runtimeMode,
      userMessageId: userId,
      clientRunId,
      memoryEnabled,
      contextTurns,
    };
    let keepStreamingAfterReturn = false;
    try {
      if (!isHermesRuntime) {
        try {
          activeTransportRef.current = "ws";
          const firstWsEvent = waitForFirstEvent("ws", WS_FIRST_EVENT_TIMEOUT_MS, controller.signal);
          await transports.ws.send(payload, controller.signal);
          try {
            await firstWsEvent;
          } catch (firstEventError) {
            if (controller.signal.aborted) throw firstEventError;
            // OpenClaw 2026.4.29 may take 60-120s before the first stream event.
            // Once WS send succeeds, do not HTTP-fallback and submit the same turn twice.
            console.warn("[CHAT-WS] first event wait elapsed; keeping WS active", { adoptId, clientRunId });
          }
          keepStreamingAfterReturn = true;
          return;
        } catch {
          firstEventWaiterRef.current?.reject(new Error("ws_fallback"));
          firstEventWaiterRef.current = null;
          transports.ws.close("fallback_to_http");
          setConnStatus("reconnecting");
        }
      }
      activeTransportRef.current = "http";
      await transports.http.send(payload, controller.signal);
    } catch (error) {
      setConnStatus("error");
      clearStreamingWatchdog();
      dispatchEvent({
        type: "transport.error",
        message: error instanceof Error ? error.message : "send_failed",
      }, assistantId);
    } finally {
      if (!keepStreamingAfterReturn && !inFlightRecoveringRef.current && !controller.signal.aborted) {
        clearStreamingWatchdog();
        setIsStreaming(false);
      }
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  }, [adoptId, armStreamingWatchdog, channel, clearStreamingWatchdog, contextTurns, conversationId, dispatchEvent, isHermesRuntime, memoryEnabled, now, runtimeMode, transports, waitForFirstEvent]);

  const abort = useCallback((reason?: string) => {
    clearStreamingWatchdog();
    abortControllerRef.current?.abort(reason);
    httpTransportRef.current?.close(reason);
    wsTransportRef.current?.close(reason);
    activeTransportRef.current = null;
    firstEventWaiterRef.current?.reject(new Error("aborted"));
    firstEventWaiterRef.current = null;
    inFlightRecoveringRef.current = false;
    setIsStreaming(false);
  }, [clearStreamingWatchdog]);

  const clear = useCallback(() => {
    abort("clear");
    activeAssistantIdRef.current = undefined;
    activeSendStartedAtRef.current = undefined;
    inFlightRecoveringRef.current = false;
    setMessages([]);
  }, [abort]);

  const restore = useCallback((nextMessages: AgentChatMessage[]) => {
    abort("restore");
    activeAssistantIdRef.current = undefined;
    activeSendStartedAtRef.current = undefined;
    inFlightRecoveringRef.current = false;
    setMessages(Array.isArray(nextMessages) ? nextMessages.slice(-100) : []);
  }, [abort]);

  return {
    messages,
    isStreaming,
    connStatus,
    send,
    abort,
    clear,
    restore,
    dispatchEvent,
  };
}
