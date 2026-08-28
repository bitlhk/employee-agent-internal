import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApproval: vi.fn(),
  listApprovals: vi.fn(),
  requireOwner: vi.fn(),
  auditRequired: vi.fn(),
  auditBestEffort: vi.fn(),
  decide: vi.fn(),
  customReceipt: vi.fn(),
  enterpriseReceipt: vi.fn(),
  demoRecord: vi.fn(),
  executeCustomerCrm: vi.fn(),
}));

vi.mock("../db", () => ({
  getGovernanceApproval: mocks.getApproval,
  listGovernanceApprovals: mocks.listApprovals,
  getClawByAdoptId: vi.fn(async () => ({
    adoptId: "lgj-owner",
    agentId: "jiuwen_lgj-owner",
    roleTemplate: "wealth-manager",
    permissionProfile: "plus",
  })),
  getUserById: vi.fn(async () => ({ id: 7, name: "演示财富经理", email: "demo@example.com" })),
  getCustomMcpCallReceiptByApprovalId: mocks.customReceipt,
  getEnterpriseMcpCallReceiptByApprovalId: mocks.enterpriseReceipt,
  getCustomMcpConnection: vi.fn(async () => null),
  getEnterpriseMcpConnection: vi.fn(async () => ({
    serverId: "wealth_governance_demo",
    displayName: "财富业务演示 MCP（Demo）",
  })),
  getGovernanceDemoBusinessRecord: mocks.demoRecord,
}));
vi.mock("./helpers", () => ({ requireClawOwner: mocks.requireOwner }));
vi.mock("./audit-events", () => ({
  auditActor: vi.fn(() => ({ actorType: "user", actorUserId: 7 })),
  auditRequest: vi.fn(() => ({})),
  recordAuditRequired: mocks.auditRequired,
  recordAuditBestEffort: mocks.auditBestEffort,
}));
vi.mock("./governance/approval-service", () => ({ decideApproval: mocks.decide }));
vi.mock("./customer-crm-platform-tools", () => ({
  handleCustomerCrmPlatformTool: mocks.executeCustomerCrm,
}));

import { registerGovernanceApprovalRoutes } from "./governance-approval-routes";

const approvalId = "apr_00000000-0000-4000-8000-000000000001";
const pending = {
  id: 1,
  approvalId,
  status: "pending",
  policyDecisionId: "pdec_1",
  policyCode: "EA_TEST",
  ruleVersion: "v1",
  principalFingerprint: "a".repeat(64),
  userId: 7,
  adoptId: "lgj-owner",
  capabilityId: "enterprise.mcp",
  operation: "update_customer",
  resource: "enterprise-mcp:crm",
  reason: "approval required",
  decisionReason: null,
  expiresAt: new Date(Date.now() + 60_000),
  approvedAt: null,
  rejectedAt: null,
  consumedAt: null,
  createdAt: new Date(),
};

let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
let baseUrl = "";

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.requireOwner.mockResolvedValue({ userId: 7, adoptId: "lgj-owner" });
  mocks.getApproval.mockResolvedValue(pending);
  mocks.auditRequired.mockResolvedValue({ id: 1 });
  mocks.auditBestEffort.mockResolvedValue({ id: 2 });
  mocks.decide.mockResolvedValue({ ...pending, status: "approved", approvedAt: new Date() });
  mocks.customReceipt.mockResolvedValue(null);
  mocks.enterpriseReceipt.mockResolvedValue(null);
  mocks.demoRecord.mockResolvedValue(null);
  mocks.executeCustomerCrm.mockResolvedValue({
    content: [{ type: "text", text: "completed" }],
    executionReceipt: { schema: "ea.customer-crm-execution-receipt.v1", status: "completed", executionReceiptId: "crmex_1" },
  });
  const app = express();
  app.use(express.json());
  registerGovernanceApprovalRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server?.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
  server = undefined;
});

async function decide() {
  return await fetch(`${baseUrl}/api/claw/governance/approvals/${approvalId}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ adoptId: "lgj-owner", decision: "approved" }),
  });
}

describe("governance approval routes", () => {
  it("writes required audit evidence before changing approval state", async () => {
    const response = await decide();
    expect(response.status).toBe(200);
    expect(mocks.auditRequired.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.decide.mock.invocationCallOrder[0]);
    expect(mocks.decide).toHaveBeenCalledWith(expect.objectContaining({
      approvalId,
      userId: 7,
      adoptId: "lgj-owner",
      decision: "approved",
    }));
  });

  it("fails closed without changing state when required audit storage is unavailable", async () => {
    mocks.auditRequired.mockRejectedValue(new Error("audit unavailable"));
    const response = await decide();
    expect(response.status).toBe(503);
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it("executes a bound CRM follow-up directly after the one approval", async () => {
    const crmPending = {
      ...pending,
      policyCode: "EA_CUSTOMER_CRM_FOLLOWUP_WRITE_V1",
      capabilityId: "enterprise.crm",
      operation: "create_followup",
      resource: "customer:CUST-000201",
      operationPayloadJson: {
        globalCustomerId: "CUST-000201",
        objective: "回访客户",
        dueAt: "2026-09-08T01:00:00.000Z",
        idempotencyKey: "followup-cust-201",
        runtimeSessionId: "session-original",
      },
    };
    const approved = { ...crmPending, status: "approved", approvedAt: new Date() };
    const consumed = { ...approved, status: "consumed", consumedAt: new Date() };
    mocks.getApproval.mockResolvedValueOnce(crmPending).mockResolvedValueOnce(consumed);
    mocks.decide.mockResolvedValue(approved);
    const response = await decide();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      item: { status: "consumed" },
      execution: { status: "completed", executionReceipt: { executionReceiptId: "crmex_1" } },
    });
    expect(mocks.executeCustomerCrm).toHaveBeenCalledWith(expect.objectContaining({
      name: "create_customer_followup_task",
      args: expect.objectContaining({
        customer_id: "CUST-000201",
        objective: "回访客户",
        idempotency_key: "followup-cust-201",
        approval_id: approvalId,
      }),
      sessionId: "session-original",
    }));
  });

  it("does not disclose or decide another adoption's approval", async () => {
    mocks.getApproval.mockResolvedValue({ ...pending, adoptId: "lgj-other" });
    const response = await decide();
    expect(response.status).toBe(409);
    expect(mocks.auditRequired).not.toHaveBeenCalled();
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it("returns a safe Demo execution evidence view without raw tool arguments", async () => {
    mocks.getApproval.mockResolvedValue({
      ...pending,
      status: "consumed",
      approvedAt: new Date("2026-08-09T01:00:00.000Z"),
      consumedAt: new Date("2026-08-09T01:00:01.000Z"),
      payloadHash: "b".repeat(64),
      decidedBy: 7,
    });
    mocks.enterpriseReceipt.mockResolvedValue({
      requestId: "emcp_demo",
      approvalId,
      serverId: "wealth_governance_demo",
      toolName: "demo_create_portfolio_draft",
      idempotencyKey: "secret-idempotency-key",
      argsHash: "c".repeat(64),
      resultHash: "d".repeat(64),
      externalRequestId: "DEMO-PLAN-123",
      status: "succeeded",
      durationMs: 18,
      errorCode: null,
      startedAt: new Date(),
      completedAt: new Date(),
    });
    mocks.demoRecord.mockResolvedValue({
      recordId: "DEMO-PLAN-123",
      status: "demo_draft",
      customerRef: "张先生（Demo）",
      createdAt: new Date(),
    });
    const response = await fetch(`${baseUrl}/api/claw/governance/approvals/${approvalId}/evidence?adoptId=lgj-owner`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.item.connector).toEqual(expect.objectContaining({
      name: "财富业务演示 MCP（Demo）",
      demo: true,
    }));
    expect(payload.item.businessOutcome.recordId).toBe("DEMO-PLAN-123");
    expect(payload.item.receipt.idempotencyFingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(payload)).not.toContain("secret-idempotency-key");
  });
});
