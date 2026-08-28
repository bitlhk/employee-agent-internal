import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserById: vi.fn(),
  resolvePrincipal: vi.fn(),
  createClient: vi.fn(),
  evaluateWriteAccess: vi.fn(),
  productionReady: vi.fn(),
  enforceApproval: vi.fn(),
  writeFollowupTask: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("../db", () => ({ getUserById: mocks.getUserById }));
vi.mock("./governance/principal", () => ({
  resolveRuntimePrincipalV2: mocks.resolvePrincipal,
}));
vi.mock("./customer-context-twenty-access", () => ({
  createConfiguredTwentyCustomerClient: mocks.createClient,
  evaluateTwentyCustomerWriteAccess: mocks.evaluateWriteAccess,
  twentyCustomerContextProductionReady: mocks.productionReady,
}));
vi.mock("./governance/approval-service", () => ({
  enforceGovernanceApproval: mocks.enforceApproval,
  approvalRequiredToolResult: (input: Record<string, unknown>) => ({
    content: [{ type: "text", text: "approval required" }],
    isError: true,
    _meta: { eaGovernance: { code: "EA_APPROVAL_REQUIRED", ...input } },
  }),
}));
vi.mock("./audit-events", () => ({
  auditRequest: vi.fn(() => ({})),
  recordAuditRequired: mocks.recordAudit,
}));

import {
  CUSTOMER_CRM_PLATFORM_TOOLS,
  handleCustomerCrmPlatformTool,
} from "./customer-crm-platform-tools";

const principal = {
  tenantId: "tn_demo",
  organizationId: "org_demo",
  userId: 59,
  adoptionId: "lgj-lihongkun",
  agentId: "wealth-agent",
  roleTemplate: "wealth-manager",
  workspaceId: "/workspace/lgj-lihongkun",
  permissionProfile: "plus",
  sessionId: "session-1",
  authorizationSnapshotId: "authz-1",
  authorizationFingerprint: "a".repeat(64),
  identityVersion: "2",
};

const allowed = {
  allowed: true,
  reasonCode: "ALLOW",
  globalCustomerId: "CUST-000201",
  assignmentKey: "role-adoption:lgj-lihongkun:CUST-000201",
  assignmentPrincipalType: "role_adoption",
  assignmentPrincipalRef: "lgj-lihongkun",
  authorizationEvidenceId: "e".repeat(64),
};

const request = {
  headers: {},
  ip: "127.0.0.1",
  socket: { remoteAddress: "127.0.0.1" },
} as any;

function call(args: Record<string, unknown>) {
  return handleCustomerCrmPlatformTool({
    req: request,
    name: "create_customer_followup_task",
    args,
    adoption: { userId: 59 } as any,
    adoptId: "lgj-lihongkun",
    sessionId: "session-1",
  });
}

const args = {
  customer_id: "CUST-000201",
  objective: "明天下午联系客户确认配置方案",
  due_at: "2026-08-29T08:00:00.000Z",
  idempotency_key: "followup-c005-20260829",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.EA_CUSTOMER_CRM_WRITEBACK_ENABLED = "true";
  mocks.productionReady.mockReturnValue(true);
  mocks.getUserById.mockResolvedValue({ id: 59, name: "李文华", email: "liwenhua@example.com" });
  mocks.resolvePrincipal.mockResolvedValue({ complete: true, principal });
  mocks.createClient.mockReturnValue({ writeFollowupTask: mocks.writeFollowupTask });
  mocks.evaluateWriteAccess.mockResolvedValue(allowed);
  mocks.recordAudit.mockResolvedValue(undefined);
  mocks.writeFollowupTask.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.EA_CUSTOMER_CRM_WRITEBACK_ENABLED;
});

describe("customer CRM platform write tool", () => {
  it("uses the platform confirmation instead of a conversational confirmation", () => {
    expect(CUSTOMER_CRM_PLATFORM_TOOLS[0].description).toContain("call this tool immediately");
    expect(CUSTOMER_CRM_PLATFORM_TOOLS[0].description).toContain("do not ask for confirmation in chat first");
    expect(CUSTOMER_CRM_PLATFORM_TOOLS[0].description).toContain("single official confirmation request");
  });

  it("does not write a public customer without an explicit assignment", async () => {
    mocks.evaluateWriteAccess.mockResolvedValue({
      ...allowed,
      allowed: false,
      reasonCode: "CUSTOMER_NOT_ASSIGNED",
      assignmentKey: null,
      assignmentPrincipalType: null,
      assignmentPrincipalRef: null,
    });
    const result = await call(args);
    expect(result).toMatchObject({ isError: true, reasonCode: "CUSTOMER_NOT_ASSIGNED" });
    expect(result.content[0]?.text).toContain("只可查看");
    expect(mocks.enforceApproval).not.toHaveBeenCalled();
    expect(mocks.writeFollowupTask).not.toHaveBeenCalled();
  });

  it("asks once for approval before writing", async () => {
    mocks.enforceApproval.mockResolvedValue({
      effect: "REQUIRE_APPROVAL",
      reason: "需要确认",
      requirement: {
        approvalId: "apr_00000000-0000-4000-8000-000000000001",
        expiresAt: new Date("2026-08-29T07:00:00.000Z"),
      },
    });
    const result = await call(args);
    expect(result).toMatchObject({
      isError: true,
      _meta: { eaGovernance: { code: "EA_APPROVAL_REQUIRED" } },
    });
    expect(mocks.writeFollowupTask).not.toHaveBeenCalled();
  });

  it("rechecks assignment after approval and writes an idempotent CRM task", async () => {
    mocks.enforceApproval.mockResolvedValue({
      effect: "ALLOW",
      approval: { approvalId: "apr_00000000-0000-4000-8000-000000000001" },
    });
    const result = await call({
      ...args,
      approval_id: "apr_00000000-0000-4000-8000-000000000001",
    });
    expect(mocks.evaluateWriteAccess).toHaveBeenCalledTimes(2);
    expect(mocks.writeFollowupTask).toHaveBeenCalledWith(expect.objectContaining({
      globalCustomerId: "CUST-000201",
      subject: "明天下午联系客户确认配置方案",
      lastIdempotencyKey: "followup-c005-20260829",
      ownerPrincipalId: "role_adoption:lgj-lihongkun",
    }));
    expect(result).toMatchObject({
      externalRequestId: expect.stringMatching(/^crm_followup_[a-f0-9]{40}$/),
      executionReceipt: {
        schema: "ea.customer-crm-execution-receipt.v1",
        status: "completed",
        globalCustomerId: "CUST-000201",
        assignmentKey: "role-adoption:lgj-lihongkun:CUST-000201",
        idempotencyKey: "followup-c005-20260829",
      },
    });
    expect(mocks.recordAudit).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the assignment is revoked after confirmation", async () => {
    mocks.enforceApproval.mockResolvedValue({
      effect: "ALLOW",
      approval: { approvalId: "apr_00000000-0000-4000-8000-000000000001" },
    });
    mocks.evaluateWriteAccess
      .mockResolvedValueOnce(allowed)
      .mockResolvedValueOnce({
        ...allowed,
        allowed: false,
        reasonCode: "CUSTOMER_NOT_ASSIGNED",
        assignmentKey: null,
      });
    const result = await call({
      ...args,
      approval_id: "apr_00000000-0000-4000-8000-000000000001",
    });
    expect(result).toMatchObject({ isError: true, reasonCode: "CUSTOMER_NOT_ASSIGNED" });
    expect(result.content[0]?.text).toContain("服务关系已变化");
    expect(mocks.writeFollowupTask).not.toHaveBeenCalled();
  });
});
