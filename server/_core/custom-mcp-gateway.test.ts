import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtimeAttested: true,
  reserve: vi.fn(),
  complete: vi.fn(),
  remoteCall: vi.fn(),
  guardEgress: vi.fn(),
  audit: vi.fn(),
  enforceApproval: vi.fn(),
}));

const connection = {
  id: 12,
  userId: 7,
  adoptId: "lgj-custom",
  displayName: "客户系统",
  endpointUrl: "https://mcp.example.com/mcp",
  authType: "none",
  authHeaderName: null,
  enabled: true,
  healthStatus: "ready",
  toolsJson: [{
    name: "update_customer",
    description: "更新客户",
    inputSchema: { type: "object", properties: { customer_id: { type: "string" } }, required: ["customer_id"] },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }],
  selectedToolNames: ["update_customer"],
};

vi.mock("../db", () => ({
  completeCustomMcpCall: mocks.complete,
  getClawByAdoptId: vi.fn(async () => ({
    id: 1,
    adoptId: "lgj-custom",
    agentId: "jiuwen_lgj-custom",
    userId: 7,
    roleTemplate: "wealth-manager",
    permissionProfile: "plus",
    status: "active",
  })),
  getClawByAgentId: vi.fn(async () => null),
  listCustomMcpConnections: vi.fn(async () => [connection]),
  revealCustomMcpCredential: vi.fn(() => ""),
  revealCustomMcpOAuthData: vi.fn(() => null),
  reserveCustomMcpCall: mocks.reserve,
}));

vi.mock("./custom-mcp-client", () => ({
  callCustomMcpTool: mocks.remoteCall,
  customMcpGatewayToolName: (connectionId: number, toolName: string) => `custom_${connectionId}_${toolName}`,
  discoverCustomMcpTools: vi.fn(),
  MAX_CUSTOM_MCP_CONNECTIONS: 10,
  MAX_CUSTOM_MCP_SELECTED_TOOLS: 50,
  parseCustomMcpEndpoint: vi.fn(),
  validateCustomMcpAuth: vi.fn(),
}));
vi.mock("./helpers", () => ({
  isAuthorizedInternalRequest: vi.fn(() => true),
  isJiuwenClawAdoptId: vi.fn(() => true),
  readSessionEpoch: vi.fn(() => 1),
  requireClawOwner: vi.fn(),
  resolveRequesterUserId: vi.fn(),
  resolveRuntimeAgentId: vi.fn(),
  resolveRuntimeWorkspaceByIds: vi.fn((adoptId: string) => `/workspace/${adoptId}`),
}));
vi.mock("./audit-events", () => ({
  auditRequest: vi.fn(() => ({})),
  recordAuditBestEffort: mocks.audit,
}));
vi.mock("./observability/metrics", () => ({
  beginMcpCall: vi.fn(() => () => undefined),
  observeGovernanceDecision: vi.fn(),
}));
vi.mock("./tool-egress-policy", () => ({ guardToolEgress: mocks.guardEgress }));
vi.mock("./governance/approval-service", () => ({
  enforceGovernanceApproval: mocks.enforceApproval,
  approvalRequiredToolResult: (input: { approvalId: string }) => ({
    content: [{ type: "text", text: `该操作需要人工确认。确认编号：${input.approvalId}` }],
    isError: true,
  }),
}));
vi.mock("./runtime-governance-attestation", () => ({
  runtimeGovernanceIsAttested: vi.fn(() => mocks.runtimeAttested),
}));
vi.mock("./security", () => ({ strictLimiter: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("./jiuwenswarm-runtime-refresh", () => ({ refreshJiuwenRuntimeCapabilities: vi.fn() }));
vi.mock("./role-templates", () => ({ resolveAgentRoleTemplate: vi.fn() }));
vi.mock("../routers/role-runtime-adapters", () => ({ getRoleRuntimeAdapter: vi.fn() }));
vi.mock("./custom-mcp-oauth", () => ({ finishCustomMcpOAuth: vi.fn(), startCustomMcpOAuth: vi.fn() }));
vi.mock("./public-base-url", () => ({ resolvePublicBaseUrl: vi.fn(() => "https://agent.example.com") }));

import { registerCustomMcpRoutes } from "./custom-mcp";

type GatewayResponse = {
  result?: {
    tools?: Array<{ inputSchema: Record<string, unknown>; annotations: Record<string, unknown> }>;
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
};

let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
let baseUrl = "";

async function rpc(method: string, params: Record<string, unknown>): Promise<GatewayResponse> {
  const response = await fetch(`${baseUrl}/api/internal/custom-mcp/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-agent-adopt-id": "lgj-custom",
      "x-ea-runtime-id": "jiuwenswarm-local",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "test-call", method, params }),
  });
  expect(response.status).toBe(200);
  return await response.json() as GatewayResponse;
}

async function callGateway(args: Record<string, unknown>): Promise<GatewayResponse> {
  return await rpc("tools/call", { name: "custom_12_update_customer", arguments: args });
}

function resultText(response: GatewayResponse): string {
  return response.result?.content?.map(part => part.text).join("\n") || "";
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.runtimeAttested = true;
  mocks.guardEgress.mockResolvedValue({ ok: true });
  mocks.enforceApproval.mockImplementation(async ({ decision }: { decision: { effect: string; reason: string } }) => (
    decision.effect === "DENY"
      ? { effect: "DENY", reason: decision.reason, approval: null }
      : { effect: "ALLOW", approval: { approvalId: "apr-test" } }
  ));
  mocks.reserve.mockResolvedValue({ reserved: true, conflict: false, receipt: { requestId: "cmcp-test" } });
  mocks.remoteCall.mockResolvedValue({ content: [{ type: "text", text: "updated" }] });
  const app = express();
  app.use(express.json());
  registerCustomMcpRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server?.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
  server = undefined;
});

describe("custom MCP gateway enforcement", () => {
  it("publishes platform-normalized risk and requires a gateway idempotency key", async () => {
    const response = await rpc("tools/list", {});
    const tool = response.result?.tools?.[0];
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    expect(tool?.inputSchema.required).toContain("idempotency_key");
  });

  it("blocks a side-effect tool without an idempotency key before approval or execution", async () => {
    const response = await callGateway({ customer_id: "customer-1" });
    expect(response.result?.isError).toBe(true);
    expect(resultText(response)).toMatch(/idempotency_key/);
    expect(mocks.enforceApproval).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.remoteCall).not.toHaveBeenCalled();
  });

  it("never calls the remote executor when governance denies the route", async () => {
    mocks.runtimeAttested = false;
    const response = await callGateway({ customer_id: "customer-1", idempotency_key: "idem-denied-1" });
    expect(response.result?.isError).toBe(true);
    expect(resultText(response)).toMatch(/治理挂钩/);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.remoteCall).not.toHaveBeenCalled();
  });

  it("reserves a durable receipt and strips gateway-only keys before remote execution", async () => {
    const response = await callGateway({ customer_id: "customer-1", idempotency_key: "idem-success-1" });
    expect(resultText(response)).toBe("updated");
    expect(mocks.reserve).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: 12,
      toolName: "update_customer",
      idempotencyKey: "idem-success-1",
    }));
    expect(mocks.remoteCall).toHaveBeenCalledWith(expect.anything(), "update_customer", { customer_id: "customer-1" });
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("blocks duplicate and conflicting idempotency keys before remote execution", async () => {
    mocks.reserve.mockResolvedValueOnce({ reserved: false, conflict: false, receipt: { requestId: "cmcp-original" } });
    const duplicate = await callGateway({ customer_id: "customer-1", idempotency_key: "idem-duplicate-1" });
    expect(resultText(duplicate)).toContain("cmcp-original");
    expect(mocks.remoteCall).not.toHaveBeenCalled();

    mocks.reserve.mockResolvedValueOnce({ reserved: false, conflict: true, receipt: { requestId: "cmcp-conflict" } });
    const conflict = await callGateway({ customer_id: "customer-2", idempotency_key: "idem-duplicate-1" });
    expect(resultText(conflict)).toMatch(/不同参数/);
    expect(mocks.remoteCall).not.toHaveBeenCalled();
  });

  it("records a remote business error as a failed call", async () => {
    mocks.remoteCall.mockResolvedValueOnce({
      content: [{ type: "text", text: "remote rejected" }],
      isError: true,
    });
    const response = await callGateway({ customer_id: "customer-1", idempotency_key: "idem-remote-error-1" });
    expect(response.result?.isError).toBe(true);
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      errorCode: "REMOTE_TOOL_ERROR",
    }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "agent.custom_mcp.called",
      result: "failed",
    }));
  });
});
