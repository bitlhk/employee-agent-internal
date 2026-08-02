import { createHash } from "node:crypto";
import {
  beginMcpCall,
  beginSearchToolCall,
  recordSearchResultOptimization,
  type McpKind,
} from "./observability/metrics";

const JIUWEN_MCP_METRIC_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ACTIVE_JIUWEN_MCP_METRICS = 1000;

export type JiuwenMcpMetricToolEvent = {
  isResult: boolean;
  callId: string;
  toolName: string;
  isError: boolean;
  resultPayload?: unknown;
};

type JiuwenMcpMetricSpan = {
  finish: ReturnType<typeof beginMcpCall>;
  finishSearch?: ReturnType<typeof beginSearchToolCall>;
  timer: ReturnType<typeof setTimeout>;
};

const activeJiuwenMcpMetrics = new Map<string, JiuwenMcpMetricSpan>();
const SEARCH_TOOL_RE =
  /(?:^|_)(?:financial_news|company_announcements|fetch_webpage|web_search|free_search|paid_search|news|announcement|search)(?:_|$)/i;

export function extractSearchOptimizationStats(value: unknown): {
  originalChars: number;
  compactChars: number;
} | null {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (!text.includes("_ea_search_optimized")) return null;
  const original = text.match(/["']original_chars["']\s*:\s*(\d+)/i);
  const originalChars = Number(original?.[1] || 0);
  if (!Number.isFinite(originalChars) || originalChars <= 0) return null;
  return { originalChars, compactChars: text.length };
}

export function inferMcpServerForJiuwenTool(toolName: string): string | null {
  const name = String(toolName || "").trim();
  if (!name) return null;
  const mcpTool = name.match(/^mcp_([a-zA-Z0-9_]+)__[a-zA-Z0-9_]+$/);
  if (mcpTool?.[1]) return mcpTool[1];

  const flattened = name.match(/^mcp_([a-zA-Z0-9_]+)$/)?.[1];
  if (!flattened) return null;
  const customUser = flattened.match(/^(custom_user_\d+)_/);
  if (customUser?.[1]) return customUser[1];
  for (const knownServer of ["custom_mcp_gateway", "platform_tools"]) {
    if (flattened.startsWith(`${knownServer}_`)) return knownServer;
  }

  const parts = flattened.split("_");
  for (let width = Math.floor(parts.length / 2); width > 0; width -= 1) {
    const prefix = parts.slice(0, width);
    if (prefix.every((part, index) => parts[width + index] === part)) {
      return prefix.join("_");
    }
  }
  return null;
}

function jiuwenMcpKind(serverId: string): McpKind {
  return serverId.startsWith("custom_user_") || serverId === "custom_mcp_gateway" ? "custom" : "platform";
}

function metricKey(args: {
  agentId: string;
  sessionId: string;
  requestId: string;
  tool: JiuwenMcpMetricToolEvent;
}): string {
  return createHash("sha256").update([
    args.agentId,
    args.sessionId,
    args.requestId,
    args.tool.callId || args.tool.toolName,
    args.tool.toolName,
  ].join("|")).digest("hex");
}

function finishOldestMetric(): void {
  const oldest = activeJiuwenMcpMetrics.entries().next().value as [string, JiuwenMcpMetricSpan] | undefined;
  if (!oldest) return;
  const [key, span] = oldest;
  clearTimeout(span.timer);
  span.finish("cancelled");
  span.finishSearch?.("cancelled");
  activeJiuwenMcpMetrics.delete(key);
}

export function recordJiuwenMcpMetricEvent(args: {
  agentId: string;
  sessionId: string;
  requestId: string;
  tool: JiuwenMcpMetricToolEvent;
}): boolean {
  if (!args.tool.toolName.startsWith("mcp_")) return false;
  const mcpServer = inferMcpServerForJiuwenTool(args.tool.toolName) || "jiuwenswarm_mcp";
  const kind = jiuwenMcpKind(mcpServer);
  const key = metricKey(args);

  if (args.tool.isResult) {
    const span = activeJiuwenMcpMetrics.get(key);
    if (span) {
      clearTimeout(span.timer);
      activeJiuwenMcpMetrics.delete(key);
      span.finish(args.tool.isError ? "error" : "success");
      span.finishSearch?.(args.tool.isError ? "error" : "success");
    } else {
      beginMcpCall(kind)(args.tool.isError ? "error" : "success");
      if (SEARCH_TOOL_RE.test(args.tool.toolName)) {
        beginSearchToolCall()(args.tool.isError ? "error" : "success");
      }
    }
    const optimization = extractSearchOptimizationStats(args.tool.resultPayload);
    if (optimization) recordSearchResultOptimization(optimization);
    return true;
  }

  const previous = activeJiuwenMcpMetrics.get(key);
  if (previous) {
    clearTimeout(previous.timer);
    previous.finish("cancelled");
    previous.finishSearch?.("cancelled");
    activeJiuwenMcpMetrics.delete(key);
  }
  while (activeJiuwenMcpMetrics.size >= MAX_ACTIVE_JIUWEN_MCP_METRICS) {
    finishOldestMetric();
  }

  const finish = beginMcpCall(kind);
  const finishSearch = SEARCH_TOOL_RE.test(args.tool.toolName) ? beginSearchToolCall() : undefined;
  const timer = setTimeout(() => {
    const current = activeJiuwenMcpMetrics.get(key);
    if (!current || current.finish !== finish) return;
    activeJiuwenMcpMetrics.delete(key);
    finish("timeout");
    finishSearch?.("timeout");
  }, JIUWEN_MCP_METRIC_TIMEOUT_MS);
  timer.unref?.();
  activeJiuwenMcpMetrics.set(key, { finish, finishSearch, timer });
  return true;
}
