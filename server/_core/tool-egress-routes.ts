import { randomUUID } from "node:crypto";
import type { Express, Request } from "express";
import { recordAuditBestEffort } from "./audit-events";
import { isAuthorizedInternalRequest } from "./helpers";
import {
  guardToolEgress,
  type ToolEgressDecision,
} from "./tool-egress-policy";
import {
  resolveToolGovernance,
  shouldBlockWithoutPolicyCore,
  stableToolInputHash,
  type ToolGovernanceProfile,
} from "./tool-governance";
import { capabilitySetFingerprint } from "./governance/capability-registry";
import { RUNTIME_GOVERNANCE_RULE_VERSION, recordRuntimeGovernanceInvocation } from "./runtime-governance-attestation";

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
const DEFAULT_TRUSTED_TOOL_PREFIXES = [
  "mcp_platform_tools_",
  "mcp_enterprise_mcp_gateway_",
  "mcp_role_mcp_gateway_",
  "mcp_wind_",
  "mcp_wealth_assistant_",
  "mcp_market_data__",
];

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

function isTrustedPlatformTool(toolName: string): boolean {
  const configured = String(process.env.EA_TOOL_EGRESS_TRUSTED_TOOL_PREFIXES || "")
    .split(",").map(item => item.trim().toLowerCase()).filter(Boolean);
  const prefixes = configured.length > 0 ? configured : DEFAULT_TRUSTED_TOOL_PREFIXES;
  const normalized = toolName.toLowerCase();
  return prefixes.some(prefix => normalized.startsWith(prefix));
}

async function auditGovernanceDecision(input: {
  body: JiuwenPreToolInput;
  profile: ToolGovernanceProfile;
  decision: "allow" | "block";
  policyCode: string;
  policyDecisionId: string;
}): Promise<void> {
  await recordAuditBestEffort({
    action: input.decision === "allow" ? "governance.tool.allowed" : "governance.tool.blocked",
    result: input.decision === "allow" ? "success" : "denied",
    severity: input.decision === "allow" ? "info" : "high",
    actorType: "agent",
    targetType: "runtime_tool",
    targetId: input.profile.tool || "unknown",
    targetName: input.profile.tool || "unknown",
    agentInstanceId: String(input.body.session_id || "").trim() || null,
    source: "tool_governance",
    channel: "jiuwen_pre_tool",
    toolName: input.profile.tool || null,
    policyCode: input.policyCode,
    metadata: {
      policyDecisionId: input.policyDecisionId,
      ruleVersion: RUNTIME_GOVERNANCE_RULE_VERSION,
      capabilitySetFingerprint: capabilitySetFingerprint(),
      sideEffect: input.profile.sideEffect,
      policyRequired: input.profile.policyRequired,
      approvalMode: input.profile.approvalMode,
      auditLevel: input.profile.auditLevel,
      governanceSource: input.profile.source,
      registered: input.profile.registered,
      toolInputHash: stableToolInputHash(input.body.tool_input),
    },
  });
}

export function policyUnavailableDecision(
  body: JiuwenPreToolInput
): { decision: "allow" } | { decision: "block"; reason: string; policyCode: string } {
  const profile = resolveToolGovernance(body.tool_name);
  if (!isLikelyOutboundToolCall(body.tool_name, body.tool_input) && !shouldBlockWithoutPolicyCore(profile)) {
    return { decision: "allow" };
  }
  return {
    decision: "block",
    reason: "工具安全检查暂时不可用，请稍后重试。",
    policyCode: "EA_TOOL_GOVERNANCE_UNAVAILABLE",
  };
}

export async function evaluateJiuwenPreToolUse(
  body: JiuwenPreToolInput
): Promise<
  | { decision: "allow" }
  | { decision: "block"; reason: string; policyCode: string }
> {
  const toolName = String(body.tool_name || "").trim();
  const profile = resolveToolGovernance(toolName);
  const policyDecisionId = `pdec_${randomUUID()}`;
  if (isLikelyOutboundToolCall(toolName, body.tool_input)) {
    const decision: ToolEgressDecision = await guardToolEgress({
      channel: "jiuwen_pre_tool",
      payload: body.tool_input,
      adoptId: String(body.session_id || "").trim() || null,
      toolName,
      destinationUrl: findDestinationUrl(body.tool_input),
      destinationTrust: isTrustedPlatformTool(toolName) ? "platform" : "unknown",
    });
    if (!decision.ok) {
      await auditGovernanceDecision({ body, profile, decision: "block", policyCode: "EA_TOOL_EGRESS_V1", policyDecisionId });
      return {
        decision: "block",
        reason: decision.error || "工具参数未通过出站数据护栏。",
        policyCode: "EA_TOOL_EGRESS_V1",
      };
    }
  }
  if (shouldBlockWithoutPolicyCore(profile)) {
    await auditGovernanceDecision({ body, profile, decision: "block", policyCode: "EA_TOOL_GOVERNANCE_UNREGISTERED", policyDecisionId });
    return {
      decision: "block",
      reason: "该工具可能产生业务副作用，但尚未登记治理规则，已阻止执行。",
      policyCode: "EA_TOOL_GOVERNANCE_UNREGISTERED",
    };
  }
  await auditGovernanceDecision({ body, profile, decision: "allow", policyCode: "EA_TOOL_GOVERNANCE_V1", policyDecisionId });
  return { decision: "allow" };
}

export function registerToolEgressRoutes(app: Express): void {
  app.post("/api/internal/security/pre-tool", async (req: Request, res) => {
    if (!isAuthorizedInternalRequest(req)) {
      res.status(401).json({ decision: "block", reason: "unauthorized" });
      return;
    }
    recordRuntimeGovernanceInvocation({
      runtimeId: req.headers["x-linggan-runtime-id"],
      hookVersion: req.headers["x-linggan-hook-version"],
    });
    try {
      res.json(await evaluateJiuwenPreToolUse(req.body || {}));
    } catch {
      const decision = policyUnavailableDecision(req.body || {});
      res.status(decision.decision === "block" ? 503 : 200).json(decision);
    }
  });
}
