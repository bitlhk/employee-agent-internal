import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtimeAttested: false,
  internalFetch: vi.fn(),
  prepareWealthAllocationContext: vi.fn(),
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
vi.mock("./wealth-policy-source", () => ({ resolveWealthSuitabilityPolicySource: vi.fn() }));

import { registerPlatformToolsMcpRoutes } from "./platform-tools-mcp";

let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
let baseUrl = "";

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.runtimeAttested = false;
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
