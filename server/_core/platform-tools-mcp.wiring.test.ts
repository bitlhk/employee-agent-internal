import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtimeAttested: false,
  internalFetch: vi.fn(),
  prepareWealthAllocationContext: vi.fn(),
  prepareWealthMaturityContext: vi.fn(),
  prepareWealthPrevisitContext: vi.fn(),
  resolveWealthPolicyBasis: vi.fn(),
  resolveWealthPrevisitKnowledgeBasis: vi.fn(),
  authorizeExecutionAuthority: vi.fn(),
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
  getUserById: vi.fn(async () => ({ id: 7, groupId: 3, role: "user", organization: "Example Bank" })),
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
vi.mock("./agent-memory-retrieval", () => ({
  buildRelevantAgentMemoryContext: vi.fn(async () => ({
    context: "<ea_relevant_memory>客户更关注流动性</ea_relevant_memory>",
    selectedIds: [42],
    selectedRefs: [{
      memoryId: 42,
      kind: "preference",
      version: 3,
      contentHash: "9".repeat(64),
      sourceType: "explicit",
      asOf: "2026-08-10T00:00:00.000Z",
      usageType: "preference",
    }],
    activeCount: 1,
  })),
}));
vi.mock("./observability/metrics", () => ({
  beginMcpCall: vi.fn(() => () => undefined),
  observeGovernanceDecision: vi.fn(),
}));
vi.mock("./fetch-timeout", () => ({ fetchWithTimeout: mocks.internalFetch }));
vi.mock("./runtime-governance-attestation", () => ({
  runtimeGovernanceIsAttested: vi.fn(() => mocks.runtimeAttested),
}));
vi.mock("./governance/execution-authority", () => ({
  requiresExecutionAuthority: vi.fn((sideEffect: string) => !["read", "compute"].includes(sideEffect)),
  authorizeExecutionAuthority: mocks.authorizeExecutionAuthority,
}));
vi.mock("./governance/principal", () => {
  const principal = {
    userId: 7,
    adoptionId: "lgj-platform",
    agentId: "jiuwen_lgj-platform",
    roleTemplate: "wealth-manager",
    workspaceId: "/workspace/lgj-platform",
    permissionProfile: "plus",
    sessionId: "",
  };
  return {
    resolveRuntimePrincipal: vi.fn(() => ({ principal, complete: true, issues: [] })),
    principalSupportsSideEffect: vi.fn((resolution: { complete: boolean }, sideEffect: string) => (
      sideEffect === "read" || sideEffect === "compute" || resolution.complete
    )),
    resolveRuntimePrincipalV2: vi.fn(async () => ({
      principal: {
        ...principal,
        tenantId: "tn_test",
        organizationId: "org_test",
        authorizationSnapshotId: "authz_test",
        authorizationFingerprint: "f".repeat(64),
        identityVersion: "2",
      },
      complete: true,
      issues: [],
    })),
  };
});
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
vi.mock("./wealth-previsit-context", () => ({
  prepareWealthPrevisitContext: mocks.prepareWealthPrevisitContext,
}));
vi.mock("./wealth-policy-source", () => ({
  resolveWealthPolicyBasis: mocks.resolveWealthPolicyBasis,
  resolveWealthPrevisitKnowledgeBasis: mocks.resolveWealthPrevisitKnowledgeBasis,
  resolveWealthSuitabilityPolicySource: vi.fn(),
}));

import { registerPlatformToolsMcpRoutes } from "./platform-tools-mcp";

let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
let baseUrl = "";

beforeEach(async () => {
  process.env.JWT_SECRET = "platform-mcp-context-receipt-test-secret";
  vi.clearAllMocks();
  mocks.runtimeAttested = false;
  mocks.authorizeExecutionAuthority.mockResolvedValue({
    effect: "ALLOW",
    policyCode: "EA_EXECUTION_AUTHORITY_INTERSECTION_V1",
    ruleVersion: "execution-authority-v1",
    reason: "allowed",
    effectivePrincipal: {
      tenantId: "tn_test", organizationId: "org_test", userId: 7,
      adoptionId: "lgj-platform", agentId: "jiuwen_lgj-platform", roleTemplate: "wealth-manager",
      workspaceId: "/workspace/lgj-platform", permissionProfile: "plus", sessionId: "",
      authorizationSnapshotId: "authz_test", authorizationFingerprint: "e".repeat(64), identityVersion: "2",
    },
    taskSnapshotId: "authz_test",
    currentSnapshotId: "authz_current",
    effectiveAuthorityFingerprint: "e".repeat(64),
  });
  mocks.prepareWealthMaturityContext.mockResolvedValue({
    schema: "ea.wealth-maturity-context.v1",
    status: "ready",
    window: { from: "2026-08-10T00:00:00.000Z", to: "2026-09-09T00:00:00.000Z", days: 30 },
    summary: { customersScanned: 2, customersFailed: 0, matchingItems: 1, returnedItems: 1, truncated: false },
    items: [{ customerId: "C-001", customerName: "演示客户", productId: "P-001", priority: "high" }],
    guidance: { productRecommendationAllowed: false, writeRequiresSeparateConfirmation: true, message: "仅用于跟进" },
    evidence: { sourceTools: ["wealth_assistant_customer_list", "wealth_assistant_customer_detail"], scope: "current-user-authorized-customers", dataAsOf: ["2026-08-10T00:00:00.000Z"], generatedAt: "2026-08-10T00:00:00.000Z" },
  });
  mocks.prepareWealthPrevisitContext.mockResolvedValue({
    schema: "ea.wealth-previsit-context.v1",
    status: "ready",
    customer: { customerId: "C-001", name: "演示客户", dataAsOf: "2026-08-10T00:00:00.000Z" },
    knowledgeBasis: {
      status: "ready",
      evaluatedAt: "2026-08-10T00:00:00.000Z",
      selected: { sourceAssetId: "wm-previsit-sop", documentId: "doc-previsit", versionLabel: "V1.0", contentHash: "b".repeat(64), sourceDepartment: "财富管理部" },
      eligibilityFingerprint: "c".repeat(64),
      userMessage: "已就绪",
    },
    evidence: { customerId: "C-001", customerDataAsOf: "2026-08-10T00:00:00.000Z", customerResultFingerprint: "d".repeat(64), scopeVerified: true },
  });
  mocks.resolveWealthPolicyBasis.mockResolvedValue({
    schema: "ea.wealth-policy-basis.v1",
    status: "ready",
    roleTemplate: "wealth-manager",
    evaluatedAt: "2026-08-10T00:00:00.000Z",
    selected: {
      sourceAssetId: "doc-v22",
      contentHash: "e".repeat(64),
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
    evidence: {
      ruleVersion: "wealth-suitability-v1",
      customerDataAsOf: "2026-08-10T00:00:00.000Z",
      productDataAsOf: ["2026-08-10T00:00:00.000Z"],
      policyDecisionIds: ["pdec_allow", "pdec_deny"],
      decisions: [
        { productId: "P-R2", effect: "ALLOW", policyCode: "WEALTH_SUITABILITY_MATCH:ELIGIBLE", policyDecisionId: "pdec_allow" },
        { productId: "P-R4", effect: "DENY", policyCode: "WEALTH_SUITABILITY_MATCH:RISK_MISMATCH", policyDecisionId: "pdec_deny" },
      ],
    },
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
    const body = await response.json() as { result?: { isError?: boolean; content?: Array<{ text: string }>; _meta?: {
      eaContextReceipt?: { schema?: string };
    } } };
    expect(response.status).toBe(200);
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("EA_WEALTH_POLICY_BASIS");
    expect(body.result?.content?.[0]?.text).toContain("V2.2");
    expect(body.result?.content?.[0]?.text).not.toContain("contextReceipt");
    expect(body.result?.content?.[0]?.text).not.toContain("executionEnvelope");
    expect(body.result?.content?.[0]?.text).not.toContain("decisionFingerprint");
    expect(body.result?._meta?.eaContextReceipt?.schema).toBe("ea.context-receipt.v1");
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
    const body = await response.json() as { result?: { isError?: boolean; content?: Array<{ text: string }>; _meta?: {
      eaContextReceipt?: { schema?: string; taskId?: string };
    } } };
    expect(response.status).toBe(200);
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("EA_WEALTH_ALLOCATION_CONTEXT");
    expect(body.result?._meta?.eaContextReceipt?.taskId).toBe("WM-GT-02");
    expect(body.result?.content?.[0]?.text).not.toContain("contextReceipt");
    expect(body.result?.content?.[0]?.text).not.toContain("executionEnvelope");
    expect(body.result?.content?.[0]?.text).not.toContain("decisionFingerprint");
    expect(body.result?._meta?.eaContextReceipt?.schema).toBe("ea.context-receipt.v1");
    expect(body.result?.content?.[0]?.text).toContain("P-R2");
    expect(mocks.prepareWealthAllocationContext).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ customerId: "C-001", amount: 500000, horizonMonths: 36, channel: "branch" }),
    }));
  });

  it("assembles a principal-bound previsit context and task readiness", async () => {
    const response = await fetch(`${baseUrl}/api/internal/platform-tools/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-agent-adopt-id": "lgj-platform" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "wealth-previsit",
        method: "tools/call",
        params: { name: "prepare_wealth_previsit_context", arguments: { customer_id: "C-001" } },
      }),
    });
    const body = await response.json() as { result?: { isError?: boolean; content?: Array<{ text: string }>; _meta?: {
      eaContextReceipt?: { taskId?: string; provided?: { memory?: Array<{ memoryId?: string; version?: number }> } };
      eaInteractionGrant?: { schema?: string };
    } } };
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("EA_WEALTH_PREVISIT_CONTEXT");
    expect(body.result?._meta?.eaContextReceipt?.taskId).toBe("WM-GT-01");
    expect(body.result?.content?.[0]?.text).not.toContain("contextReceipt");
    expect(body.result?.content?.[0]?.text).not.toContain("executionEnvelope");
    expect(body.result?.content?.[0]?.text).not.toContain("eaInteractionGrant");
    expect(body.result?.content?.[0]?.text).not.toContain("receiptFingerprint");
    expect(body.result?.content?.[0]?.text).not.toContain("eligibilityFingerprint");
    expect(body.result?._meta?.eaContextReceipt?.provided?.memory?.[0]).toMatchObject({ memoryId: "42", version: 3 });
    expect(body.result?._meta?.eaInteractionGrant?.schema).toBe("ea.context-interaction-grant.v1");
    expect(body.result?.content?.[0]?.text).toContain('"status":"READY"');
    expect(mocks.prepareWealthPrevisitContext).toHaveBeenCalledWith(expect.objectContaining({ customerId: "C-001" }));
  });

  it("returns a usable degraded previsit result when customer data is temporarily unavailable", async () => {
    mocks.prepareWealthPrevisitContext.mockRejectedValueOnce(new Error("upstream unavailable"));
    const response = await fetch(`${baseUrl}/api/internal/platform-tools/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-agent-adopt-id": "lgj-platform" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "wealth-previsit-degraded", method: "tools/call",
        params: { name: "prepare_wealth_previsit_context", arguments: { customer_id: "C-001" } },
      }),
    });
    const body = await response.json() as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.content?.[0]?.text).toContain('"status":"degraded"');
    expect(body.result?.content?.[0]?.text).toContain("generic_previsit_checklist");
  });

  it("returns blocked formal recommendation with safe fallbacks instead of an MCP protocol error", async () => {
    mocks.prepareWealthAllocationContext.mockRejectedValueOnce(new Error("product upstream unavailable"));
    const response = await fetch(`${baseUrl}/api/internal/platform-tools/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-agent-adopt-id": "lgj-platform" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "wealth-allocation-blocked", method: "tools/call",
        params: { name: "prepare_wealth_allocation_context", arguments: { customer_id: "C-001" } },
      }),
    });
    const body = await response.json() as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.content?.[0]?.text).toContain('"status":"blocked"');
    expect(body.result?.content?.[0]?.text).toContain("verified_customer_analysis");
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

  it("never reaches the platform executor when execution authority was revoked", async () => {
    mocks.runtimeAttested = true;
    mocks.authorizeExecutionAuthority.mockResolvedValueOnce({
      effect: "DENY",
      policyCode: "EA_EXECUTION_AUTHORITY_REVOKED",
      ruleVersion: "execution-authority-v1",
      reason: "任务授权或当前授权已失效，已停止执行。",
      effectivePrincipal: {},
      taskSnapshotId: "authz_task",
      currentSnapshotId: "authz_current",
      effectiveAuthorityFingerprint: "d".repeat(64),
    });
    const response = await fetch(`${baseUrl}/api/internal/platform-tools/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-agent-adopt-id": "lgj-platform",
        "x-ea-runtime-id": "jiuwenswarm-local",
        "x-ea-authorization-snapshot-id": "authz_task",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "platform-authority-denied", method: "tools/call",
        params: { name: "create_scheduled_task", arguments: { name: "日报", message: "生成日报", cron_expr: "0 9 * * *" } },
      }),
    });
    const body = await response.json() as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("授权已失效");
    expect(mocks.internalFetch).not.toHaveBeenCalled();
  });

  it("creates a one-time task through the identity-scoped platform scheduler", async () => {
    mocks.runtimeAttested = true;
    mocks.internalFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const runAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const response = await fetch(`${baseUrl}/api/internal/platform-tools/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-agent-adopt-id": "lgj-platform",
        "x-ea-runtime-id": "jiuwenswarm-local",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "platform-once",
        method: "tools/call",
        params: {
          name: "create_scheduled_task",
          arguments: { name: "拜访提醒", message: "提醒我准备客户拜访", run_at: runAt },
        },
      }),
    });
    const body = await response.json() as { result?: { isError?: boolean; content?: Array<{ text: string }> } };

    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("one-time");
    const init = mocks.internalFetch.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(init.body)) as { job: { schedule: unknown } };
    expect(payload.job.schedule).toEqual({ kind: "once", runAt, display: runAt });
  });

  it("forwards the bounded task authorization snapshot to the A2A task route", async () => {
    mocks.runtimeAttested = true;
    mocks.internalFetch.mockResolvedValue(new Response(JSON.stringify({ taskId: "agt_test" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const response = await fetch(`${baseUrl}/api/internal/platform-tools/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-agent-adopt-id": "lgj-platform",
        "x-ea-runtime-id": "jiuwenswarm-local",
        "x-ea-authorization-snapshot-id": "authz_task",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "platform-a2a", method: "tools/call",
        params: { name: "submit_agent_task", arguments: { agent_id: "expert-1", task: "分析材料" } },
      }),
    });
    const body = await response.json() as { result?: { isError?: boolean } };
    expect(body.result?.isError).not.toBe(true);
    const init = mocks.internalFetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("x-ea-authorization-snapshot-id")).toBe("authz_test");
    const payload = JSON.parse(String(init.body)) as { sourceMessageId?: string };
    expect(payload.sourceMessageId).toMatch(/^mcp:[a-f0-9]{64}$/);
  });

  it("rejects ambiguous scheduled task input before execution", async () => {
    mocks.runtimeAttested = true;
    const response = await fetch(`${baseUrl}/api/internal/platform-tools/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-agent-adopt-id": "lgj-platform",
        "x-ea-runtime-id": "jiuwenswarm-local",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "platform-ambiguous",
        method: "tools/call",
        params: {
          name: "create_scheduled_task",
          arguments: {
            name: "冲突任务",
            message: "不应执行",
            run_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            cron_expr: "0 9 * * *",
          },
        },
      }),
    });
    const body = await response.json() as { result?: { isError?: boolean; content?: Array<{ text: string }> } };

    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("且仅提供");
    expect(mocks.internalFetch).not.toHaveBeenCalled();
  });
});
