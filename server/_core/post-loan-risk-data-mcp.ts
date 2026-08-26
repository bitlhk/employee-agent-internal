import type { Express, Request, Response } from "express";

import { getClawByAdoptId, getUserById } from "../db";
import { recordAuditBestEffort, auditRequest } from "./audit-events";
import { persistTrustedContextReceiptResult } from "./governance/context-receipt";
import { governanceFingerprint, principalFingerprint } from "./governance/contracts";
import { resolveRuntimePrincipalV2 } from "./governance/principal";
import { isAuthorizedInternalRequest } from "./helpers";
import { authorizeAndBindInternalRuntimeRequest } from "./internal-runtime-request";
import { internalMcpAudience } from "./internal-runtime-token";
import {
  executePostLoanRiskDataTool,
  POST_LOAN_RISK_DATA_SERVICE_NAME,
  POST_LOAN_RISK_DATA_SERVICE_VERSION,
  POST_LOAN_RISK_DATA_TOOLS,
  type PostLoanRiskToolResult,
} from "./post-loan-risk-data-provider";
import { attachReferenceRoleTaskReceipt } from "./reference-role-task-evidence";

const MCP_PATH = "/api/internal/post-loan-risk-data/mcp";
const HEALTH_PATH = "/api/internal/post-loan-risk-data/health";
const ROLE_TEMPLATE = "post-loan-risk-control";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function ok(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function error(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function trustedAdoptId(req: Request): string {
  return String(
    req.headers["x-agent-adopt-id"]
    || req.headers["x-workforce-agent-adopt-id"]
    || req.headers["x-jiuwen-channel-id"]
    || req.headers["x-openclaw-channel-id"]
    || "",
  ).trim();
}

function trustedSessionId(req: Request): string {
  return String(req.headers["x-linggan-session-id"] || req.headers["x-jiuwen-session-id"] || "").trim();
}

async function runtimePrincipal(req: Request) {
  const adoptId = trustedAdoptId(req);
  const adoption = adoptId ? await getClawByAdoptId(adoptId) : null;
  if (!adoption || !["active", "expiring"].includes(String(adoption.status || ""))) {
    throw new Error("active runtime adoption is required");
  }
  const user = await getUserById(Number(adoption.userId || 0));
  if (!user) throw new Error("runtime user is unavailable");
  const resolved = await resolveRuntimePrincipalV2({
    adoption,
    user,
    sessionId: trustedSessionId(req),
  });
  if (!resolved.complete) throw new Error(`runtime principal is incomplete: ${resolved.issues.join(",")}`);
  return resolved.principal;
}

function receiptResult(input: {
  result: PostLoanRiskToolResult;
  roleTemplate: string;
  toolName: string;
  principal: Awaited<ReturnType<typeof runtimePrincipal>>;
  args: JsonObject;
  requestId: string;
}): PostLoanRiskToolResult {
  const structured = input.result.structuredContent;
  const resultFingerprint = String(structured.resultFingerprint || governanceFingerprint(structured));
  return attachReferenceRoleTaskReceipt({
    result: input.result,
    roleTemplate: input.roleTemplate,
    serverId: POST_LOAN_RISK_DATA_SERVICE_NAME,
    toolName: input.toolName,
    principalFingerprint: principalFingerprint(input.principal),
    sideEffect: "read",
    capabilityVersion: POST_LOAN_RISK_DATA_SERVICE_VERSION,
    policyDecision: {
      decisionId: governanceFingerprint({
        policyCode: "EA_POST_LOAN_RISK_DATA_ROLE_SCOPE_V1",
        roleTemplate: input.roleTemplate,
        toolName: input.toolName,
      }),
      policyCode: "EA_POST_LOAN_RISK_DATA_ROLE_SCOPE_V1",
      ruleVersion: "post-loan-risk-data-role-scope-v1",
      effect: input.result.isError ? "DENY" : "ALLOW",
    },
    requestId: input.requestId,
    resultFingerprint,
    argumentsFingerprint: governanceFingerprint(input.args),
    failed: input.result.isError === true,
  });
}

async function handleMessage(req: Request, message: JsonObject) {
  const id = message.id;
  const method = String(message.method || "");
  if (method === "initialize") {
    return ok(id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: POST_LOAN_RISK_DATA_SERVICE_NAME, version: POST_LOAN_RISK_DATA_SERVICE_VERSION },
      instructions: [
        "受治理的企业贷后风控事实服务。",
        "岗位身份来自签名 Runtime Principal，工具参数不能选择岗位或扩大企业范围。",
        "完整评估必须先获取 get_post_loan_risk_snapshot；数据缺失不得按无风险处理。",
      ].join(" "),
    });
  }
  if (method === "ping") return ok(id, {});
  if (method === "resources/list") return ok(id, { resources: [] });
  if (method === "prompts/list") return ok(id, { prompts: [] });
  const principal = await runtimePrincipal(req);
  if (principal.roleTemplate !== ROLE_TEMPLATE) {
    await recordAuditBestEffort({
      action: "governance.post_loan_risk_data.blocked",
      result: "denied",
      severity: "high",
      actorType: "agent",
      actorUserId: principal.userId || null,
      actorRole: principal.roleTemplate || null,
      targetType: "mcp_server",
      targetId: POST_LOAN_RISK_DATA_SERVICE_NAME,
      source: "post_loan_risk_data_mcp",
      policyCode: "EA_POST_LOAN_RISK_DATA_ROLE_SCOPE_V1",
      ...auditRequest(req),
    });
    return error(id, -32003, "current role is not authorized for post-loan risk data");
  }
  if (method === "tools/list") return ok(id, { tools: POST_LOAN_RISK_DATA_TOOLS });
  if (method !== "tools/call") return error(id, -32601, `Method not found: ${method}`);
  const params = object(message.params);
  const toolName = String(params.name || "").trim();
  const args = object(params.arguments);
  const requestId = String(req.headers["x-request-id"] || governanceFingerprint({ id, toolName, args })).slice(0, 128);
  const result = receiptResult({
    result: executePostLoanRiskDataTool(toolName, args, principal.roleTemplate),
    roleTemplate: principal.roleTemplate,
    toolName,
    principal,
    args,
    requestId,
  });
  await persistTrustedContextReceiptResult({
    result,
    sessionId: principal.sessionId,
    adoptionId: principal.adoptionId,
    runtimeAgentId: principal.agentId,
    toolName,
  }).catch(() => false);
  return ok(id, result);
}

export function registerPostLoanRiskDataMcpRoutes(app: Express): void {
  const audience = internalMcpAudience(MCP_PATH);
  app.get(HEALTH_PATH, (req: Request, res: Response) => {
    if (!isAuthorizedInternalRequest(req)) return res.status(401).json({ error: "unauthorized" });
    return res.json({
      status: "ok",
      name: POST_LOAN_RISK_DATA_SERVICE_NAME,
      version: POST_LOAN_RISK_DATA_SERVICE_VERSION,
      assuranceMode: "demo",
    });
  });
  app.get(MCP_PATH, async (req: Request, res: Response) => {
    if (!(await authorizeAndBindInternalRuntimeRequest(req, audience))) {
      return res.status(401).json(error(null, -32001, "unauthorized"));
    }
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Mcp-Session-Id", `post-loan-risk-data-${trustedAdoptId(req)}`);
    res.flushHeaders?.();
    res.write(": post-loan risk data stream ready\n\n");
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25_000);
    req.on("close", () => clearInterval(heartbeat));
  });
  app.delete(MCP_PATH, async (req: Request, res: Response) => {
    if (!(await authorizeAndBindInternalRuntimeRequest(req, audience))) {
      return res.status(401).json(error(null, -32001, "unauthorized"));
    }
    return res.status(204).end();
  });
  app.post(MCP_PATH, async (req: Request, res: Response) => {
    if (!(await authorizeAndBindInternalRuntimeRequest(req, audience))) {
      return res.status(401).json(error(null, -32001, "unauthorized"));
    }
    try {
      const body = req.body || {};
      const response = Array.isArray(body)
        ? (await Promise.all(body.map((item) => handleMessage(req, object(item))))).filter(Boolean)
        : await handleMessage(req, object(body));
      if (!response || (Array.isArray(response) && response.length === 0)) return res.status(202).json({});
      res.setHeader("Mcp-Session-Id", `post-loan-risk-data-${trustedAdoptId(req)}`);
      return res.json(response);
    } catch (cause) {
      return res.json(error(object(req.body).id, -32000, cause instanceof Error ? cause.message : String(cause)));
    }
  });
}
