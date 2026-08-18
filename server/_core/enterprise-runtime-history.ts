import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import {
  buildEnterpriseHistoryParams,
  resolveEnterpriseRuntimeRoute,
  type EnterpriseRuntimeRoute,
} from "./enterprise-runtime-adapter";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_COMPAT_HISTORY_MAX_PAGES = 20;
const MAX_COMPAT_HISTORY_MAX_PAGES = 40;

export type EnterpriseRuntimeHistorySession = {
  session_id?: string;
  channel_id?: string;
  title?: string;
  message_count?: number;
  created_at?: number;
  last_message_at?: number;
  [key: string]: unknown;
};

export function resolveEnterpriseHistoryMaxPages(
  maxMessages: number,
  configuredValue: string | undefined = process.env.EA_ENTERPRISE_HISTORY_COMPAT_MAX_PAGES,
): number {
  const logicalMessagePages = Math.max(1, Math.ceil(Math.min(Math.max(maxMessages, 1), 500) / 50));
  const configured = Number(configuredValue || DEFAULT_COMPAT_HISTORY_MAX_PAGES);
  const compatibilityPages = Number.isFinite(configured)
    ? Math.min(MAX_COMPAT_HISTORY_MAX_PAGES, Math.max(1, Math.floor(configured)))
    : DEFAULT_COMPAT_HISTORY_MAX_PAGES;
  return Math.max(logicalMessagePages, compatibilityPages);
}

function parseFrame(raw: RawData): any | null {
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

function gatewayOrigin(rawUrl: string): string {
  const url = new URL(rawUrl);
  return `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`;
}

function framePayload(frame: any): Record<string, any> {
  return frame?.payload && typeof frame.payload === "object" && !Array.isArray(frame.payload)
    ? frame.payload
    : {};
}

async function gatewayRequest(args: {
  route: EnterpriseRuntimeRoute;
  method: "session.list" | "history.get";
  params: Record<string, unknown>;
}): Promise<{ payload: Record<string, any>; messages: any[] }> {
  const requestId = `ea-history-${randomUUID()}`;
  const timeoutMs = Math.max(1_000, Number(process.env.EA_ENTERPRISE_HISTORY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS));
  return new Promise((resolve, reject) => {
    const messages: any[] = [];
    let settled = false;
    const ws = new WebSocket(args.route.wsUrl, { headers: { Origin: gatewayOrigin(args.route.wsUrl) } });
    const timer = setTimeout(() => finish(new Error(`enterprise ${args.method} timed out`)), timeoutMs);

    const finish = (error?: Error, payload: Record<string, any> = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (error) reject(error);
      else resolve({ payload, messages });
    };

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "req", id: requestId, method: args.method, params: args.params }));
    });
    ws.on("message", (raw) => {
      const frame = parseFrame(raw);
      if (!frame) return;
      const isResponse = frame.type === "res" && frame.id === requestId;
      const isEvent = frame.type === "event" && frame.request_id === requestId;
      if (!isResponse && !isEvent) return;
      const payload = framePayload(frame);
      if (frame.ok === false || String(frame.event || payload.event_type || "") === "chat.error") {
        finish(new Error(String(frame.error || payload.error || `${args.method} failed`)));
        return;
      }
      if (args.method === "session.list" && isResponse && Array.isArray(payload.sessions)) {
        finish(undefined, payload);
        return;
      }
      if (args.method === "history.get") {
        if (Array.isArray(payload.messages)) messages.push(...payload.messages);
        if (payload.message && typeof payload.message === "object") messages.push(payload.message);
        if (payload.status === "done" || (isResponse && Array.isArray(payload.messages))) {
          finish(undefined, payload);
        }
      }
    });
    ws.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    ws.on("close", () => {
      if (!settled) finish(new Error(`enterprise ${args.method} connection closed`));
    });
  });
}

async function enterpriseRoute(adoptId: string): Promise<EnterpriseRuntimeRoute | null> {
  const decision = await resolveEnterpriseRuntimeRoute(adoptId);
  return decision.target === "enterprise" ? decision.route : null;
}

export async function listEnterpriseRuntimeHistorySessions(args: {
  adoptId: string;
  agentId: string;
  limit: number;
}): Promise<EnterpriseRuntimeHistorySession[] | null> {
  const route = await enterpriseRoute(args.adoptId);
  if (!route) return null;
  const result = await gatewayRequest({
    route,
    method: "session.list",
    params: buildEnterpriseHistoryParams({
      route,
      adoptId: args.adoptId,
      agentId: args.agentId,
      limit: args.limit,
    }),
  });
  return Array.isArray(result.payload.sessions) ? result.payload.sessions : [];
}

export async function readEnterpriseRuntimeHistoryRecords(args: {
  adoptId: string;
  agentId: string;
  sessionId: string;
  maxMessages: number;
}): Promise<any[] | null> {
  const route = await enterpriseRoute(args.adoptId);
  if (!route) return null;
  const records: any[] = [];
  // Pre-compaction enterprise sessions may contain thousands of streaming frames for
  // one logical answer. New sessions still stop after page 1 via total_pages.
  const maxPages = resolveEnterpriseHistoryMaxPages(args.maxMessages);
  for (let pageIdx = 1; pageIdx <= maxPages; pageIdx += 1) {
    const result = await gatewayRequest({
      route,
      method: "history.get",
      params: buildEnterpriseHistoryParams({
        route,
        adoptId: args.adoptId,
        agentId: args.agentId,
        sessionId: args.sessionId,
        pageIdx,
        pageSize: 500,
      }),
    });
    records.push(...result.messages);
    const totalPages = Number(result.payload.total_pages || pageIdx);
    if (!Number.isFinite(totalPages) || pageIdx >= totalPages) break;
  }
  return records.reverse();
}
