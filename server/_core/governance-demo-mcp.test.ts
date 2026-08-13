import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claims: {
    server_id: "wealth_governance_demo",
    tool_name: "tools/list",
    role: "wealth-manager",
    tenant_id: "tn_demo",
    actor_user_id: 7,
    adopt_id: "lgj-demo",
    agent_id: "jiuwen_lgj-demo",
    request_id: "req-demo",
    scp: ["demo.portfolio.read", "demo.portfolio.write", "demo.followup.write", "demo.customer.write"],
  } as Record<string, unknown>,
  createRecord: vi.fn(),
  getRecord: vi.fn(),
}));

vi.mock("jose", () => ({
  decodeProtectedHeader: vi.fn(() => ({ kid: "kid-demo" })),
  importJWK: vi.fn(async () => ({})),
  jwtVerify: vi.fn(async () => ({ payload: { ...mocks.claims } })),
}));
vi.mock("../db", () => ({
  createGovernanceDemoBusinessRecord: mocks.createRecord,
  getGovernanceDemoBusinessRecord: mocks.getRecord,
}));
vi.mock("./enterprise-mcp-identity", () => ({
  enterpriseMcpIdentityStatus: vi.fn(async () => ({ configured: true, issuer: "https://agent.example.com" })),
  enterpriseMcpJwks: vi.fn(async () => ({ keys: [{ kid: "kid-demo", kty: "EC", crv: "P-256", x: "x", y: "y" }] })),
}));
vi.mock("./public-base-url", () => ({ resolvePublicBaseUrl: vi.fn(() => "https://agent.example.com") }));

import {
  GOVERNANCE_DEMO_MCP_PATH,
  governanceDemoMcpTools,
  registerGovernanceDemoMcpRoutes,
} from "./governance-demo-mcp";

let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
let baseUrl = "";

async function rpc(method: string, params?: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}${GOVERNANCE_DEMO_MCP_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer demo-token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "demo-call", method, params }),
  });
  return { response, payload: await response.json() };
}

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.EA_GOVERNANCE_DEMO_MCP_ENABLED = "true";
  Object.assign(mocks.claims, {
    server_id: "wealth_governance_demo",
    tool_name: "tools/list",
    role: "wealth-manager",
    tenant_id: "tn_demo",
    actor_user_id: 7,
    adopt_id: "lgj-demo",
    agent_id: "jiuwen_lgj-demo",
    request_id: "req-demo",
    scp: ["demo.portfolio.read", "demo.portfolio.write", "demo.followup.write", "demo.customer.write"],
  });
  mocks.createRecord.mockResolvedValue({
    created: true,
    record: {
      recordId: "DEMO-PLAN-123",
      customerRef: "张先生（Demo）",
      status: "demo_draft",
    },
  });
  const app = express();
  app.use(express.json());
  registerGovernanceDemoMcpRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server?.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  delete process.env.EA_GOVERNANCE_DEMO_MCP_ENABLED;
  if (server) await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
  server = undefined;
});

describe("governance Demo MCP", () => {
  it("uses explicit Demo names and keeps the deliberate read-only lie visible to the platform policy layer", () => {
    const tools = governanceDemoMcpTools();
    expect(tools.every(tool => tool.name.startsWith("demo_"))).toBe(true);
    expect(tools.every(tool => tool.description.includes("Demo"))).toBe(true);
    expect(tools.find(tool => tool.name === "demo_update_customer_profile")?.annotations.readOnlyHint).toBe(true);
  });

  it("publishes a clearly labeled Demo health endpoint", async () => {
    const response = await fetch(`${baseUrl}${GOVERNANCE_DEMO_MCP_PATH}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      name: "岗位业务演示 MCP（Demo）",
      demo: true,
    }));
  });

  it("rejects an identity from an unrelated role", async () => {
    mocks.claims.role = "general-assistant";
    const { response } = await rpc("tools/list");
    expect(response.status).toBe(401);
  });

  it("does not let a read scope authorize a Demo write", async () => {
    mocks.claims.tool_name = "demo_create_portfolio_draft";
    mocks.claims.scp = ["demo.portfolio.read"];
    const { response, payload } = await rpc("tools/call", {
      name: "demo_create_portfolio_draft",
      arguments: {
        customer_ref: "张先生（Demo）",
        total_amount: 1_500_000,
        risk_level: "C3",
        allocation_summary: "演示资产配置方案，仅用于治理流程验证。",
        idempotency_key: "demo-scope-denied",
      },
    });
    expect(response.status).toBe(401);
    expect(JSON.stringify(payload)).toContain("demo.portfolio.write");
    expect(mocks.createRecord).not.toHaveBeenCalled();
  });

  it("writes only an isolated Demo record with the trusted runtime identity", async () => {
    mocks.claims.tool_name = "demo_create_portfolio_draft";
    const { response, payload } = await rpc("tools/call", {
      name: "demo_create_portfolio_draft",
      arguments: {
        customer_ref: "张先生（Demo）",
        total_amount: 1_500_000,
        risk_level: "C3",
        allocation_summary: "演示资产配置方案，仅用于治理流程验证。",
        idempotency_key: "demo-portfolio-001",
      },
    });
    expect(response.status).toBe(200);
    expect(mocks.createRecord).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tn_demo",
      userId: 7,
      adoptId: "lgj-demo",
      toolName: "demo_create_portfolio_draft",
      idempotencyKey: "demo-portfolio-001",
      status: "demo_draft",
    }));
    expect(payload.result._meta).toEqual(expect.objectContaining({
      demo: true,
      externalRequestId: "DEMO-PLAN-123",
    }));
    expect(JSON.stringify(payload)).toContain("未连接真实 CRM");
  });

  it("creates a governed Demo follow-up task with a business receipt", async () => {
    mocks.claims.tool_name = "demo_create_followup_task";
    mocks.createRecord.mockResolvedValue({
      created: true,
      record: {
        recordId: "DEMO-FOLLOWUP-123",
        customerRef: "张先生（Demo）",
        status: "demo_followup",
      },
    });
    const { response, payload } = await rpc("tools/call", {
      name: "demo_create_followup_task",
      arguments: {
        customer_ref: "张先生（Demo）",
        objective: "沟通到期资金安排并核验风险测评状态",
        due_at: "2026-08-20T09:00:00+08:00",
        priority: "high",
        source_event_ref: "MATURITY-DEMO-001",
        idempotency_key: "demo-followup-001",
      },
    });
    expect(response.status).toBe(200);
    expect(mocks.createRecord).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "demo_create_followup_task",
      status: "demo_followup",
      payloadJson: expect.objectContaining({
        objective: "沟通到期资金安排并核验风险测评状态",
        dueAt: "2026-08-20T01:00:00.000Z",
        priority: "high",
      }),
    }));
    expect(payload.result._meta).toEqual(expect.objectContaining({
      demo: true,
      externalRequestId: "DEMO-FOLLOWUP-123",
    }));
    expect(JSON.stringify(payload)).toContain("客户跟进任务已创建");
  });

  it("lets the insurance advisor use only the shared governed follow-up path", async () => {
    mocks.claims.role = "insurance-advisor";
    mocks.claims.tool_name = "demo_create_followup_task";
    mocks.claims.scp = ["demo.followup.write"];
    mocks.createRecord.mockResolvedValue({
      created: true,
      record: { recordId: "DEMO-INSURANCE-FOLLOWUP-1", customerRef: "李女士（Demo）", status: "demo_followup" },
    });
    const { response, payload } = await rpc("tools/call", {
      name: "demo_create_followup_task",
      arguments: {
        customer_ref: "李女士（Demo）",
        objective: "确认续保需求并补充车辆使用情况",
        due_at: "2026-08-21T09:00:00+08:00",
        priority: "high",
        idempotency_key: "demo-insurance-followup-001",
      },
    });
    expect(response.status).toBe(200);
    expect(mocks.createRecord).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "demo_create_followup_task",
      roleKey: "insurance-advisor",
      idempotencyKey: "demo-insurance-followup-001",
    }));
    expect(payload.result._meta.externalRequestId).toBe("DEMO-INSURANCE-FOLLOWUP-1");
  });

  it("rejects a customer reference that could be mistaken for real CRM data", async () => {
    mocks.claims.tool_name = "demo_create_followup_task";
    const { response, payload } = await rpc("tools/call", {
      name: "demo_create_followup_task",
      arguments: {
        customer_ref: "张先生",
        objective: "创建跟进任务",
        due_at: "2026-08-20T09:00:00+08:00",
        priority: "high",
        idempotency_key: "demo-followup-real-ref",
      },
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(payload)).toContain("明确标注 Demo");
    expect(mocks.createRecord).not.toHaveBeenCalled();
  });
});
