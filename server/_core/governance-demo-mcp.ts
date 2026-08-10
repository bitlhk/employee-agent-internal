import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWTPayload } from "jose";
import { createGovernanceDemoBusinessRecord, getGovernanceDemoBusinessRecord } from "../db";
import { enterpriseMcpIdentityStatus, enterpriseMcpJwks } from "./enterprise-mcp-identity";
import { resolvePublicBaseUrl } from "./public-base-url";

export const GOVERNANCE_DEMO_MCP_SERVER_ID = "wealth_governance_demo";
export const GOVERNANCE_DEMO_MCP_PATH = "/api/demo/mcp/wealth-business";
const SERVICE_NAME = "wealth-business-governance-demo-mcp";
const SERVICE_VERSION = "1.0.0-demo";

type DemoIdentity = {
  tenantId: string;
  userId: number;
  adoptId: string;
  agentId: string;
  roleKey: string;
  requestId: string;
  scopes: Set<string>;
  claims: JWTPayload;
};

type JsonRpcMessage = {
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown; arguments?: unknown };
};

function demoEnabled(): boolean {
  return String(process.env.EA_GOVERNANCE_DEMO_MCP_ENABLED || "").trim().toLowerCase() === "true";
}

function resourceUri(): string {
  const configured = String(process.env.EA_GOVERNANCE_DEMO_MCP_RESOURCE_URI || "").trim();
  const configuredBaseUrl = String(process.env.EA_GOVERNANCE_DEMO_BASE_URL || "").trim().replace(/\/$/, "");
  return configured || `${configuredBaseUrl || resolvePublicBaseUrl()}${GOVERNANCE_DEMO_MCP_PATH}`;
}

function ok(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function textResult(text: string, meta?: Record<string, unknown>) {
  return {
    content: [{ type: "text", text }],
    ...(meta ? { _meta: meta } : {}),
  };
}

export function governanceDemoMcpTools() {
  return [
    {
      name: "demo_get_business_record",
      description: "【Demo】查询由财富业务演示 MCP 创建的演示记录；不读取真实 CRM。",
      inputSchema: {
        type: "object",
        properties: { record_id: { type: "string", description: "DEMO 开头的演示记录编号" } },
        required: ["record_id"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "demo_create_portfolio_draft",
      description: "【Demo】创建财富配置方案草稿，仅写入隔离演示表，不连接真实 CRM。",
      inputSchema: {
        type: "object",
        properties: {
          customer_ref: { type: "string", description: "演示客户标识，例如：张先生（Demo）" },
          total_amount: { type: "number", minimum: 10000, maximum: 100000000, description: "方案总金额，单位元" },
          risk_level: { type: "string", enum: ["C1", "C2", "C3", "C4", "C5"] },
          allocation_summary: { type: "string", minLength: 10, maxLength: 2000 },
          idempotency_key: { type: "string", minLength: 8, maxLength: 191 },
        },
        required: ["customer_ref", "total_amount", "risk_level", "allocation_summary", "idempotency_key"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    {
      name: "demo_create_followup_task",
      description: "【Demo】创建客户跟进任务，仅写入隔离演示表，不连接真实 CRM。需要用户确认且必须提供幂等键。",
      inputSchema: {
        type: "object",
        properties: {
          customer_ref: { type: "string", description: "明确标注 Demo 的客户称谓，例如：张先生（Demo）" },
          objective: { type: "string", minLength: 5, maxLength: 500, description: "跟进目标" },
          due_at: { type: "string", description: "计划跟进时间，ISO 8601 格式" },
          priority: { type: "string", enum: ["high", "medium", "low"], description: "跟进优先级" },
          source_event_ref: { type: "string", maxLength: 128, description: "可选的到期事项或业务事件脱敏标识" },
          idempotency_key: { type: "string", minLength: 8, maxLength: 191 },
        },
        required: ["customer_ref", "objective", "due_at", "priority", "idempotency_key"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    {
      name: "demo_update_customer_profile",
      description: "【Demo·风险识别探针】更新演示客户标签；远端故意错误声明只读，用于证明平台策略不会被工具元数据降级。",
      inputSchema: {
        type: "object",
        properties: {
          customer_ref: { type: "string", description: "演示客户标识" },
          service_tag: { type: "string", minLength: 2, maxLength: 80 },
          idempotency_key: { type: "string", minLength: 8, maxLength: 191 },
        },
        required: ["customer_ref", "service_tag", "idempotency_key"],
      },
      // Intentionally incorrect for the governance demonstration. The EA
      // Enterprise MCP policy remains the authoritative write classification.
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
  ] as const;
}

function stringArg(args: Record<string, unknown>, name: string, maxLength = 2000): string {
  const value = String(args[name] || "").trim();
  if (!value || value.length > maxLength) throw new Error(`${name} 参数无效`);
  return value;
}

function numberArg(args: Record<string, unknown>, name: string, min: number, max: number): number {
  const value = Number(args[name]);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} 参数无效`);
  return value;
}

function demoCustomerRef(args: Record<string, unknown>): string {
  const value = stringArg(args, "customer_ref", 128);
  if (!/(?:^|[（(\s_-])demo(?:$|[）)\s_-])/i.test(value)) {
    throw new Error("Demo 工具只接受明确标注 Demo 的客户称谓");
  }
  return value;
}

function isoDateArg(args: Record<string, unknown>, name: string): string {
  const value = stringArg(args, name, 64);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${name} 参数无效`);
  return new Date(timestamp).toISOString();
}

function bearerToken(req: Request): string {
  const authorization = String(req.headers.authorization || "").trim();
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error("缺少 EA 短期身份令牌");
  return match[1].trim();
}

async function verifyIdentity(req: Request, toolName: string): Promise<DemoIdentity> {
  const token = bearerToken(req);
  const status = await enterpriseMcpIdentityStatus();
  if (!status.configured || !status.issuer) throw new Error("EA MCP 身份签发未配置");
  const protectedHeader = decodeProtectedHeader(token);
  const jwks = await enterpriseMcpJwks();
  const jwk = jwks.keys.find(key => key.kid === protectedHeader.kid);
  if (!jwk) throw new Error("身份令牌签名密钥未知");
  const key = await importJWK(jwk, "ES256");
  const verified = await jwtVerify(token, key, {
    algorithms: ["ES256"],
    issuer: status.issuer,
    audience: resourceUri(),
    clockTolerance: 5,
  });
  const claims = verified.payload;
  if (claims.server_id !== GOVERNANCE_DEMO_MCP_SERVER_ID) throw new Error("身份令牌资源不匹配");
  const tokenTool = String(claims.tool_name || "");
  if (toolName && tokenTool !== toolName && tokenTool !== "tools/list") throw new Error("身份令牌工具范围不匹配");
  const roleKey = String(claims.role || "");
  if (roleKey !== "wealth-manager" && roleKey !== "platform-admin") throw new Error("当前岗位无权访问该 Demo MCP");
  const scopes = new Set(Array.isArray(claims.scp)
    ? claims.scp.map(String)
    : String(claims.scope || "").split(/\s+/).filter(Boolean));
  const tenantId = String(claims.tenant_id || "").trim();
  const userId = Number(claims.actor_user_id || claims.user_id || 0);
  const adoptId = String(claims.adopt_id || "").trim();
  const agentId = String(claims.agent_id || "").trim();
  const requestId = String(claims.request_id || claims.jti || "").trim();
  if (!tenantId || !Number.isInteger(userId) || userId <= 0 || !adoptId || !agentId || !requestId) {
    throw new Error("身份令牌缺少完整的运行时主体");
  }
  return {
    tenantId,
    userId,
    adoptId,
    agentId,
    roleKey,
    requestId,
    scopes,
    claims,
  };
}

function requireScope(identity: DemoIdentity, scope: string): void {
  if (!identity.scopes.has(scope)) {
    throw new Error(`身份令牌缺少范围：${scope}`);
  }
}

async function callDemoTool(name: string, args: Record<string, unknown>, identity: DemoIdentity) {
  if (name === "demo_get_business_record") {
    requireScope(identity, "demo.portfolio.read");
    const recordId = stringArg(args, "record_id", 64);
    const record = await getGovernanceDemoBusinessRecord(recordId);
    if (!record || record.tenantId !== identity.tenantId) throw new Error("演示记录不存在");
    return textResult([
      "【Demo】演示业务记录",
      `记录编号：${record.recordId}`,
      `状态：${record.status}`,
      `客户：${record.customerRef}`,
      "数据边界：隔离演示表，未连接真实 CRM",
    ].join("\n"), { demo: true, recordId: record.recordId, requestId: identity.requestId });
  }

  if (!["demo_create_portfolio_draft", "demo_create_followup_task", "demo_update_customer_profile"].includes(name)) {
    throw new Error("未知 Demo 工具");
  }
  const requiredScope = name === "demo_create_portfolio_draft"
    ? "demo.portfolio.write"
    : name === "demo_create_followup_task"
      ? "demo.followup.write"
      : "demo.customer.write";
  requireScope(identity, requiredScope);
  const customerRef = demoCustomerRef(args);
  const idempotencyKey = stringArg(args, "idempotency_key", 191);
  const riskLevel = name === "demo_create_portfolio_draft" ? stringArg(args, "risk_level", 8) : null;
  if (riskLevel && !["C1", "C2", "C3", "C4", "C5"].includes(riskLevel)) {
    throw new Error("risk_level 参数无效");
  }
  const payload = name === "demo_create_portfolio_draft"
    ? {
        customerRef,
        totalAmount: numberArg(args, "total_amount", 10_000, 100_000_000),
        riskLevel,
        allocationSummary: stringArg(args, "allocation_summary", 2000),
      }
    : name === "demo_create_followup_task"
      ? {
          customerRef,
          objective: stringArg(args, "objective", 500),
          dueAt: isoDateArg(args, "due_at"),
          priority: (() => {
            const value = stringArg(args, "priority", 16);
            if (!["high", "medium", "low"].includes(value)) throw new Error("priority 参数无效");
            return value;
          })(),
          sourceEventRef: String(args.source_event_ref || "").trim().slice(0, 128) || null,
        }
      : {
        customerRef,
        serviceTag: stringArg(args, "service_tag", 80),
      };
  const recordPrefix = name === "demo_create_portfolio_draft"
    ? "DEMO-PLAN"
    : name === "demo_create_followup_task"
      ? "DEMO-FOLLOWUP"
      : "DEMO-CUST";
  const recordId = `${recordPrefix}-${randomUUID().slice(0, 12).toUpperCase()}`;
  const result = await createGovernanceDemoBusinessRecord({
    recordId,
    requestId: identity.requestId,
    tenantId: identity.tenantId,
    userId: identity.userId,
    adoptId: identity.adoptId,
    agentId: identity.agentId,
    roleKey: identity.roleKey,
    toolName: name,
    idempotencyKey,
    customerRef,
    status: name === "demo_create_portfolio_draft"
      ? "demo_draft"
      : name === "demo_create_followup_task"
        ? "demo_followup"
        : "demo_updated",
    payloadJson: payload,
  });
  const action = name === "demo_create_portfolio_draft"
    ? "资产配置方案草稿已创建"
    : name === "demo_create_followup_task"
      ? "客户跟进任务已创建"
      : "演示客户标签已更新";
  return textResult([
    `【Demo】${action}`,
    `记录编号：${result.record.recordId}`,
    `客户：${result.record.customerRef}`,
    `状态：${result.record.status}`,
    "数据边界：仅写入隔离演示表，未连接真实 CRM",
  ].join("\n"), {
    demo: true,
    recordId: result.record.recordId,
    externalRequestId: result.record.recordId,
    requestId: identity.requestId,
    created: result.created,
  });
}

async function handleMessage(req: Request, message: JsonRpcMessage) {
  const id = message?.id;
  const method = String(message?.method || "");
  if (method === "notifications/initialized") return null;
  if (method === "initialize") {
    await verifyIdentity(req, "");
    return ok(id, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVICE_NAME, version: SERVICE_VERSION },
      instructions: "Explicit Demo MCP. All writes are isolated and must remain governed by the EA Enterprise MCP gateway.",
    });
  }
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") {
    await verifyIdentity(req, "");
    return ok(id, { tools: governanceDemoMcpTools() });
  }
  if (method === "tools/call") {
    const name = String(message.params?.name || "").trim();
    const identity = await verifyIdentity(req, name);
    const args = message.params?.arguments && typeof message.params.arguments === "object" && !Array.isArray(message.params.arguments)
      ? message.params.arguments as Record<string, unknown>
      : {};
    return ok(id, await callDemoTool(name, args, identity));
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

function sendError(res: Response, id: unknown, error: unknown): void {
  const message = error instanceof Error ? error.message : "Demo MCP request failed";
  res.status(/身份|令牌|岗位|范围/.test(message) ? 401 : 400).json(rpcError(id, -32000, message));
}

export function registerGovernanceDemoMcpRoutes(app: Express): void {
  app.get(`${GOVERNANCE_DEMO_MCP_PATH}/health`, (_req, res) => {
    if (!demoEnabled()) return res.status(404).json({ status: "disabled" });
    res.json({ status: "ok", name: "财富业务演示 MCP（Demo）", version: SERVICE_VERSION, demo: true });
  });
  app.post(GOVERNANCE_DEMO_MCP_PATH, async (req, res) => {
    if (!demoEnabled()) return res.status(404).json(rpcError(req.body?.id, -32004, "Demo MCP is disabled"));
    try {
      const response = await handleMessage(req, req.body || {});
      if (response === null) return res.status(202).end();
      res.json(response);
    } catch (error) {
      sendError(res, req.body?.id, error);
    }
  });
}
