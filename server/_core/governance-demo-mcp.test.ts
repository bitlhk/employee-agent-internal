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
    scp: ["demo.portfolio.read", "demo.portfolio.write", "demo.customer.write"],
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
    scp: ["demo.portfolio.read", "demo.portfolio.write", "demo.customer.write"],
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
      name: "财富业务演示 MCP（Demo）",
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
});
