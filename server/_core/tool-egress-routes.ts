import type { Express, Request } from "express";
import { isAuthorizedInternalRequest } from "./helpers";
import {
  guardToolEgress,
  type ToolEgressDecision,
} from "./tool-egress-policy";

type JiuwenPreToolInput = {
  event?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  session_id?: unknown;
};

const OUTBOUND_TOOL_NAME_RE =
  /(?:^|[_-])(?:mcp|a2a|browser|fetch|http|web|search|request|notify|webhook|email|mail|feishu|ding|wechat)(?:$|[_-])/i;
const SHELL_TOOL_NAME_RE =
  /(?:^|[_-])(?:bash|shell|terminal|exec|exec_command|create_terminal)(?:$|[_-])/i;
const NETWORK_COMMAND_RE =
  /(?:^|[\s;&|])(?:curl|wget|nc|ncat|netcat|scp|sftp|ftp|ssh)\b|https?:\/\//i;
const URL_FIELD_RE = /(?:^|_)(?:url|uri|endpoint|webhook)(?:$|_)/i;

function stableText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value ?? "");
  } catch {
    return String(value ?? "");
  }
}

function findDestinationUrl(value: unknown, depth = 0): string | null {
  if (depth > 4 || !value) return null;
  if (typeof value === "string") {
    const match = value.match(/https?:\/\/[^\s"'<>]+/i);
    return match?.[0] || null;
  }
  if (typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDestinationUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      URL_FIELD_RE.test(key) &&
      typeof item === "string" &&
      /^https?:\/\//i.test(item.trim())
    ) {
      return item.trim();
    }
    const nested = findDestinationUrl(item, depth + 1);
    if (nested) return nested;
  }
  return null;
}

export function isLikelyOutboundToolCall(
  toolName: unknown,
  toolInput: unknown
): boolean {
  const name = String(toolName || "").trim();
  if (SHELL_TOOL_NAME_RE.test(name)) {
    return NETWORK_COMMAND_RE.test(stableText(toolInput));
  }
  return OUTBOUND_TOOL_NAME_RE.test(name);
}

export async function evaluateJiuwenPreToolUse(
  body: JiuwenPreToolInput
): Promise<
  | { decision: "allow" }
  | { decision: "block"; reason: string; policyCode: string }
> {
  const toolName = String(body.tool_name || "").trim();
  if (!isLikelyOutboundToolCall(toolName, body.tool_input)) {
    return { decision: "allow" };
  }
  const decision: ToolEgressDecision = await guardToolEgress({
    channel: "jiuwen_pre_tool",
    payload: body.tool_input,
    adoptId: String(body.session_id || "").trim() || null,
    toolName,
    destinationUrl: findDestinationUrl(body.tool_input),
  });
  if (decision.ok) return { decision: "allow" };
  return {
    decision: "block",
    reason: decision.error || "工具参数未通过出站数据护栏。",
    policyCode: "EA_TOOL_EGRESS_V1",
  };
}

export function registerToolEgressRoutes(app: Express): void {
  app.post("/api/internal/security/pre-tool", async (req: Request, res) => {
    if (!isAuthorizedInternalRequest(req)) {
      res.status(401).json({ decision: "block", reason: "unauthorized" });
      return;
    }
    try {
      res.json(await evaluateJiuwenPreToolUse(req.body || {}));
    } catch {
      res.status(503).json({
        decision: "allow",
        warning: "tool egress policy temporarily unavailable",
      });
    }
  });
}
