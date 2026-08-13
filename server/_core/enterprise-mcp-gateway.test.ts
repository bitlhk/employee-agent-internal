import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizationStatus: "active" as "active" | "revoked",
  policy: {
    toolName: "list_customer_profiles",
    enabled: 1,
    sideEffect: "read",
    requiredScopes: ["insurance.customer.read"],
    allowedRoles: ["insurance-advisor"],
    identityModeOverride: null,
    approvalMode: "never",
    auditLevel: "strong",
    idempotencyRequired: 0,
    argumentPolicyJson: null as Record<string, unknown> | null,
  },
  reserve: vi.fn(),
  complete: vi.fn(),
  remoteCall: vi.fn(),
  guardEgress: vi.fn(),
  audit: vi.fn(),
  enforceApproval: vi.fn(),
}));

vi.mock("../db", () => ({
  completeEnterpriseMcpCall: mocks.complete,
  getUserById: vi.fn(async () => ({ id: 7, email: "user@example.com", organization: "Example Bank" })),
  listEnterpriseMcpConnections: vi.fn(async () => [{
    serverId: "insurance_customer_profile",
    displayName: "客户画像",
    endpointUrl: "https://mcp.example.com/insurance/customer-profile/mcp",
    resourceUri: "https://mcp.example.com/insurance/customer-profile/mcp",
    lifecycleState: "shadow",
    healthStatus: "ready",
    authMode: "none_shadow",
    identityMode: "user",
    timeoutMs: 30_000,
    toolsJson: [{ name: "list_customer_profiles", description: "查询客户画像", inputSchema: { type: "object" } }],
  }]),
  listEnterpriseMcpToolPolicies: vi.fn(async () => [{ ...mocks.policy }]),
  resolveEffectiveRoleAssets: vi.fn(async () => ({})),
  resolvePersistedAgentMcpSelection: vi.fn(async () => ({ enabledServerIds: ["insurance_customer_profile"] })),
  reserveEnterpriseMcpCall: mocks.reserve,
  revealEnterpriseMcpCredential: vi.fn(() => null),
}));

vi.mock("../db/claw", () => ({
  getClawByAdoptId: vi.fn(async () => ({
    adoptId: "lgj-insurance",
    agentId: "jiuwen_lgj-insurance",
    userId: 7,
    roleTemplate: "insurance-advisor",
    permissionProfile: "plus",
    status: "active",
  })),
  getClawByAgentId: vi.fn(async () => null),
}));
vi.mock("../db/runtime-principal", () => ({
  resolveOrCreateAuthorizationSnapshot: vi.fn(async () => ({
    tenantId: "tn-test", organizationId: "org-test",
    authorizationSnapshotId: "auth-current", authorizationFingerprint: "a".repeat(64),
  })),
  getRuntimeAuthorizationSnapshot: vi.fn(async () => ({
    id: 1, snapshotId: "auth-current", authorizationFingerprint: "a".repeat(64),
    tenantId: "tn-test", organizationId: "org-test", userId: 7, adoptionId: "lgj-insurance",
    agentId: "jiuwen_lgj-insurance", roleTemplate: "insurance-advisor", workspaceId: "/workspace/lgj-insurance",
    permissionProfile: "plus", status: mocks.authorizationStatus, createdAt: new Date(),
    revokedAt: mocks.authorizationStatus === "revoked" ? new Date() : null,
    authorityJson: {
      tenantId: "tn-test", organizationId: "org-test", userId: 7, adoptionId: "lgj-insurance",
      agentId: "jiuwen_lgj-insurance", roleTemplate: "insurance-advisor", workspaceId: "/workspace/lgj-insurance",
      permissionProfile: "plus", groupIds: [], membershipVersion: 1,
    },
  })),
}));

vi.mock("./audit-events", () => ({
  auditActor: vi.fn(() => ({})),
  auditRequest: vi.fn(() => ({})),
  recordAuditRequired: mocks.audit,
}));

vi.mock("./custom-mcp-client", () => ({ callCustomMcpTool: mocks.remoteCall }));
vi.mock("./enterprise-mcp-identity", () => ({
  enterpriseMcpIdentityStatus: vi.fn(async () => ({ configured: false })),
  enterpriseMcpJwks: vi.fn(async () => ({ keys: [] })),
  enterpriseMcpTenantId: vi.fn(() => "tn_test"),
  issueEnterpriseMcpAccessToken: vi.fn(),
}));
vi.mock("./helpers", () => ({
  isAuthorizedInternalRequest: vi.fn(() => true),
  resolveRuntimeWorkspaceByIds: vi.fn((adoptId: string) => `/workspace/${adoptId}`),
}));
vi.mock("./observability/metrics", () => ({
  beginMcpCall: vi.fn(() => () => undefined),
  observeGovernanceDecision: vi.fn(),
}));
vi.mock("./tool-egress-policy", () => ({ guardToolEgress: mocks.guardEgress }));
vi.mock("./governance/approval-service", () => ({
  enforceGovernanceApproval: mocks.enforceApproval,
  approvalRequiredToolResult: (input: { approvalId: string; expiresAt: Date }) => ({
    content: [{ type: "text", text: `该操作需要人工确认。确认编号：${input.approvalId}` }],
    isError: true,
    _meta: { eaGovernance: { code: "EA_APPROVAL_REQUIRED", approvalId: input.approvalId } },
  }),
}));
vi.mock("./runtime-governance-attestation", () => ({ runtimeGovernanceIsAttested: vi.fn(() => true) }));

import { enterpriseMcpGatewayToolName, registerEnterpriseMcpGatewayRoutes } from "./enterprise-mcp-gateway";

type GatewayResponse = {
  result?: { content?: Array<{ type: string; text: string }>; isError?: boolean; tools?: Array<{ name: string; description: string }> };
  error?: { code: number; message: string };
};

let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
let baseUrl = "";

async function callGateway(args: Record<string, unknown> = {}): Promise<GatewayResponse> {
  const exposedName = enterpriseMcpGatewayToolName("insurance_customer_profile", "list_customer_profiles");
  const response = await fetch(`${baseUrl}/api/internal/enterprise-mcp/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agent-adopt-id": "lgj-insurance" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "test-call", method: "tools/call", params: { name: exposedName, arguments: args } }),
  });
  expect(response.status).toBe(200);
  return await response.json() as GatewayResponse;
}

function resultText(response: GatewayResponse): string {
  return response.result?.content?.map(part => part.text).join("\n") || "";
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.authorizationStatus = "active";
  process.env.ENTERPRISE_MCP_ALLOW_UNAUTHENTICATED_SHADOW = "true";
  Object.assign(mocks.policy, {
    enabled: 1,
    sideEffect: "read",
    requiredScopes: ["insurance.customer.read"],
    allowedRoles: ["insurance-advisor"],
    identityModeOverride: null,
    approvalMode: "never",
    auditLevel: "strong",
    idempotencyRequired: 0,
    argumentPolicyJson: null,
  });
  mocks.reserve.mockResolvedValue({ reserved: true, receipt: { requestId: "emcp_new" } });
  mocks.complete.mockResolvedValue(undefined);
  mocks.guardEgress.mockResolvedValue({ ok: true });
  mocks.audit.mockResolvedValue(undefined);
  mocks.remoteCall.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
  mocks.enforceApproval.mockResolvedValue({ effect: "ALLOW", approval: null });
  const app = express();
  app.use(express.json());
  registerEnterpriseMcpGatewayRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server?.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  delete process.env.ENTERPRISE_MCP_ALLOW_UNAUTHENTICATED_SHADOW;
  if (!server) return;
  await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
  server = undefined;
});

describe("enterprise MCP gateway", () => {
  it("builds stable bounded names without exposing the server id", () => {
    const first = enterpriseMcpGatewayToolName("insurance_customer_profile", "get customer/profile");
    const second = enterpriseMcpGatewayToolName("insurance_customer_profile", "get customer/profile");
    expect(first).toBe(second);
    expect(first).toMatch(/^enterprise_[a-f0-9]{8}_get_customer_profile_[a-f0-9]{8}$/);
    expect(first).not.toContain("insurance_customer_profile");
    expect(enterpriseMcpGatewayToolName("server", "x".repeat(500)).length).toBeLessThanOrEqual(128);
  });

  it("allows the internal runtime to register a safe catalog before user context exists", async () => {
    const response = await fetch(`${baseUrl}/api/internal/enterprise-mcp/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "catalog", method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as GatewayResponse;
    expect(payload.result?.tools).toEqual([
      expect.objectContaining({
        name: enterpriseMcpGatewayToolName("insurance_customer_profile", "list_customer_profiles"),
        description: "[客户画像] 查询客户画像",
      }),
    ]);
  });

  it("never executes a catalog tool without trusted Agent identity", async () => {
    const response = await fetch(`${baseUrl}/api/internal/enterprise-mcp/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "anonymous-call",
        method: "tools/call",
        params: {
          name: enterpriseMcpGatewayToolName("insurance_customer_profile", "list_customer_profiles"),
          arguments: {},
        },
      }),
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as GatewayResponse;
    expect(payload.error?.message).toContain("trusted Agent identity is missing");
    expect(mocks.remoteCall).not.toHaveBeenCalled();
  });

  it("blocks tools not granted to the current role", async () => {
    mocks.policy.allowedRoles = ["wealth-manager"];
    const response = await callGateway();
    expect(response.result?.isError).toBe(true);
    expect(resultText(response)).toMatch(/未授权|不属于当前岗位/);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.remoteCall).not.toHaveBeenCalled();
  });

  it("blocks arguments rejected by the tool policy", async () => {
    mocks.policy.argumentPolicyJson = { blockedFields: ["password"] };
    const response = await callGateway({ password: "must-not-leave" });
    expect(response.result?.isError).toBe(true);
    expect(resultText(response)).toMatch(/password/);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.remoteCall).not.toHaveBeenCalled();
  });

  it("blocks a write call without an idempotency key", async () => {
    mocks.policy.sideEffect = "write";
    mocks.policy.idempotencyRequired = 1;
    const response = await callGateway({ customerId: "customer-1" });
    expect(response.result?.isError).toBe(true);
    expect(resultText(response)).toMatch(/idempotency_key/);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.remoteCall).not.toHaveBeenCalled();
  });

  it("fails closed when durable approval is required", async () => {
    mocks.policy.sideEffect = "write";
    mocks.policy.approvalMode = "always";
    mocks.enforceApproval.mockResolvedValue({
      effect: "REQUIRE_APPROVAL",
      reason: "需要人工确认",
      requirement: {
        approvalId: "apr_00000000-0000-4000-8000-000000000001",
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000),
        created: true,
      },
    });
    const response = await callGateway({ idempotency_key: "idem-1" });
    expect(response.result?.isError).toBe(true);
    expect(resultText(response)).toMatch(/人工确认/);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.remoteCall).not.toHaveBeenCalled();
  });

  it("blocks payloads rejected by the data egress guard", async () => {
    mocks.guardEgress.mockResolvedValue({ ok: false, error: "检测到敏感凭据" });
    const response = await callGateway({ note: "secret" });
    expect(response.result?.isError).toBe(true);
    expect(resultText(response)).toContain("检测到敏感凭据");
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.remoteCall).not.toHaveBeenCalled();
  });

  it("blocks a duplicate idempotent request before execution", async () => {
    mocks.policy.sideEffect = "write";
    mocks.policy.idempotencyRequired = 1;
    mocks.reserve.mockResolvedValue({ reserved: false, receipt: { requestId: "emcp_original" } });
    const response = await callGateway({ idempotency_key: "idem-reused" });
    expect(response.result?.isError).toBe(true);
    expect(resultText(response)).toContain("emcp_original");
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.remoteCall).not.toHaveBeenCalled();
  });

  it("does not execute an enterprise write after current authority is revoked", async () => {
    mocks.policy.sideEffect = "write";
    mocks.policy.idempotencyRequired = 1;
    mocks.authorizationStatus = "revoked";
    const response = await callGateway({ idempotency_key: "idem-revoked" });
    expect(response.result?.isError).toBe(true);
    expect(resultText(response)).toMatch(/授权已失效|停止执行/);
    expect(mocks.enforceApproval).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.remoteCall).not.toHaveBeenCalled();
  });
});
