import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtimeAttested: false,
  internalFetch: vi.fn(),
  prepareWealthAllocationContext: vi.fn(),
  prepareWealthMaturityContext: vi.fn(),
  resolveWealthPolicyBasis: vi.fn(),
}));

vi.mock("../db", () => ({
  getClawByAdoptId: vi.fn(async () => ({
    id: 1,
    userId: 7,
    adoptId: "lgj-platform",
    agentId: "jiuwen_lgj-platform",
    roleTemplate: "wealth-manager",
    permissionProfile: "plus",
    status: "active",
  })),
  getClawByAgentId: vi.fn(),
  getUserById: vi.fn(async () => ({ id: 7, groupId: 3, role: "user" })),
}));
vi.mock("../db/role-assets", () => ({ resolveEffectiveRoleAssets: vi.fn(async () => ({ mcpServers: { default: [], optional: [] } })) }));
vi.mock("./helpers", () => ({
  isAuthorizedInternalRequest: vi.fn(() => true),
  resolveRuntimeAgentId: vi.fn(),
  resolveRuntimeWorkspaceByIds: vi.fn((adoptId: string) => `/workspace/${adoptId}`),
}));
vi.mock("./audit-events", () => ({ auditRequest: vi.fn(() => ({})), recordAuditBestEffort: vi.fn() }));
vi.mock("./agent-memory", () => ({
  forgetAgentMemory: vi.fn(),
  listAgentMemoryView: vi.fn(),
  rememberExplicitPreference: vi.fn(),
}));
vi.mock("./observability/metrics", () => ({
  beginMcpCall: vi.fn(() => () => undefined),
  observeGovernanceDecision: vi.fn(),
}));
vi.mock("./fetch-timeout", () => ({ fetchWithTimeout: mocks.internalFetch }));
vi.mock("./runtime-governance-attestation", () => ({
  runtimeGovernanceIsAttested: vi.fn(() => mocks.runtimeAttested),
}));
vi.mock("./skills/skill-source", () => ({ parseSkillSourceDirectory: vi.fn(), sanitizeSkillId: vi.fn() }));
vi.mock("./skills/skill-installer", () => ({ skillInstaller: {} }));
vi.mock("./skills/skill-registry", () => ({ skillRegistry: {} }));
vi.mock("./skills/skill-store", () => ({ skillStoreRuntimeImportedDir: vi.fn() }));
vi.mock("./internal-mcp-client", () => ({
  callInternalMcpTool: vi.fn(),
  parseInternalMcpJsonResult: vi.fn(),
}));
vi.mock("./wealth-allocation-context", () => ({
  prepareWealthAllocationContext: mocks.prepareWealthAllocationContext,
}));
vi.mock("./wealth-maturity-context", () => ({
  prepareWealthMaturityContext: mocks.prepareWealthMaturityContext,
}));
vi.mock("./wealth-policy-source", () => ({
  resolveWealthPolicyBasis: mocks.resolveWealthPolicyBasis,
  resolveWealthSuitabilityPolicySource: vi.fn(),
}));

import { registerPlatformToolsMcpRoutes } from "./platform-tools-mcp";

let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
let baseUrl = "";

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.runtimeAttested = false;
  mocks.prepareWealthMaturityContext.mockResolvedValue({
    schema: "ea.wealth-maturity-context.v1",
    status: "ready",
    window: { from: "2026-08-10T00:00:00.000Z", to: "2026-09-09T00:00:00.000Z", days: 30 },
    summary: { customersScanned: 2, customersFailed: 0, matchingItems: 1, returnedItems: 1, truncated: false },
    items: [{ customerId: "C-001", customerName: "演示客户", productId: "P-001", priority: "high" }],
    guidance: { productRecommendationAllowed: false, writeRequiresSeparateConfirmation: true, message: "仅用于跟进" },
    evidence: { sourceTools: ["wealth_assistant_customer_list", "wealth_assistant_customer_detail"], scope: "current-user-authorized-customers", dataAsOf: ["2026-08-10T00:00:00.000Z"], generatedAt: "2026-08-10T00:00:00.000Z" },
  });
  mocks.resolveWealthPolicyBasis.mockResolvedValue({
    schema: "ea.wealth-policy-basis.v1",
    status: "ready",
    roleTemplate: "wealth-manager",
    evaluatedAt: "2026-08-10T00:00:00.000Z",
    selected: {
      sourceAssetId: "doc-v22",
      documentName: "财富产品适当性销售管理细则（V2.2现行）.md",
      versionLabel: "V2.2",
      sourceDepartment: "财富管理部",
      effectiveAt: "2026-07-01T00:00:00.000Z",
      sourceLocator: "4.1 风险等级匹配",
    },
    governance: {
      eligibilityFingerprint: "a".repeat(64),
      historicalVersionFiltered: true,
      filteredForValidity: 1,
      unavailableDocuments: 0,
      accessRestricted: false,
    },
    userMessage: "当前适用依据为 V2.2，已过滤历史版本。",
  });
  mocks.prepareWealthAllocationContext.mockResolvedValue({
    schema: "ea.wealth-allocation-context.v1",
    status: "ready",
    customer: { customerId: "C-001", name: "演示客户", riskLevel: "C3" },
    eligibleProducts: [{ productId: "P-R2", name: "稳健产品", policyDecisionId: "pdec_allow", policyCode: "WEALTH_SUITABILITY_MATCH:ELIGIBLE" }],
    excludedProducts: [{ productId: "P-R4", name: "高风险产品", reason: "风险等级不匹配", policyDecisionId: "pdec_deny", policyCode: "WEALTH_SUITABILITY_MATCH:RISK_MISMATCH" }],
    policySource: { ready: true, sourceAssetId: "doc-v22", versionLabel: "V2.2", sourceLocator: "4.1", eligibilityFingerprint: "a".repeat(64) },
    evidence: { ruleVersion: "wealth-suitability-v1", customerDataAsOf: "2026-08-10T00:00:00.000Z", productDataAsOf: ["2026-08-10T00:00:00.000Z"], policyDecisionIds: ["pdec_allow", "pdec_deny"] },
  });
  const app = express();
  app.use(express.json());
  registerPlatformToolsMcpRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server?.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
  server = undefined;
});

describe("platform MCP PEP wiring", () => {
  it("returns a governed current-policy basis without depending on business MCP", async () => {
    const response = await fetch(`${baseUrl}/api/internal/platform-tools/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-agent-adopt-id": "lgj-platform" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "wealth-policy-basis",
        method: "tools/call",
        params: { name: "get_wealth_policy_basis", arguments: {} },
      }),
    });
    const body = await response.json() as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(response.status).toBe(200);
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("EA_WEALTH_POLICY_BASIS");
    expect(body.result?.content?.[0]?.text).toContain("V2.2");
    expect(mocks.resolveWealthPolicyBasis).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      groupId: 3,
      roleTemplate: "wealth-manager",
    }));
    expect(mocks.prepareWealthAllocationContext).not.toHaveBeenCalled();
  });

  it("routes formal wealth candidates through the governed context assembler", async () => {
    const response = await fetch(`${baseUrl}/api/internal/platform-tools/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-agent-adopt-id": "lgj-platform" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "wealth-context",
        method: "tools/call",
        params: {
          name: "prepare_wealth_allocation_context",
          arguments: { customer_id: "C-001", amount: 500000, horizon_months: 36, channel: "branch" },
        },
      }),
    });
    const body = await response.json() as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(response.status).toBe(200);
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("EA_WEALTH_ALLOCATION_CONTEXT");
    expect(body.result?.content?.[0]?.text).toContain("P-R2");
    expect(mocks.prepareWealthAllocationContext).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ customerId: "C-001", amount: 500000, horizonMonths: 36, channel: "branch" }),
    }));
  });

  it("routes bounded maturity operations through the authorized context assembler", async () => {
    const response = await fetch(`${baseUrl}/api/internal/platform-tools/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-agent-adopt-id": "lgj-platform" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "wealth-maturity",
        method: "tools/call",
        params: { name: "prepare_wealth_maturity_context", arguments: { window_days: 30, max_customers: 20, max_items: 30 } },
      }),
    });
    const body = await response.json() as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(response.status).toBe(200);
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("EA_WEALTH_MATURITY_CONTEXT");
    expect(mocks.prepareWealthMaturityContext).toHaveBeenCalledWith(expect.objectContaining({
      roleTemplate: "wealth-manager",
      request: { windowDays: 30, maxCustomers: 20, maxItems: 30 },
    }));
  });

  it("never reaches the platform executor when governance denies a write", async () => {
    const response = await fetch(`${baseUrl}/api/internal/platform-tools/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-agent-adopt-id": "lgj-platform",
        "x-ea-runtime-id": "jiuwenswarm-local",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "platform-denied",
        method: "tools/call",
        params: {
          name: "create_scheduled_task",
          arguments: { name: "日报", message: "生成日报", cron_expr: "0 9 * * *" },
        },
      }),
    });
    const body = await response.json() as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(response.status).toBe(200);
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toMatch(/治理挂钩/);
    expect(mocks.internalFetch).not.toHaveBeenCalled();
  });
});
