import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enforceApproval: vi.fn(),
  resolvePrincipal: vi.fn(),
  transition: vi.fn(),
}));

vi.mock("./helpers", () => ({
  assertClawOwnerOrThrow: vi.fn(async () => ({ id: 1, adoptId: "lgj-wealth", userId: 7 })),
}));
vi.mock("../db", () => ({ getUserById: vi.fn(async () => ({ id: 7, name: "财富专家", role: "user" })) }));
vi.mock("../_core/audit-events", () => ({
  auditActor: vi.fn(() => ({})),
  auditRequest: vi.fn(() => ({})),
  recordAuditRequired: vi.fn(async () => undefined),
}));
vi.mock("../_core/governance/principal", () => ({ resolveRuntimePrincipalV2: mocks.resolvePrincipal }));
vi.mock("../_core/governance/approval-service", () => ({ enforceGovernanceApproval: mocks.enforceApproval }));
vi.mock("../_core/governed-work-continuity", () => ({
  createMeetingWorkDrafts: vi.fn(),
  governedWorkView: vi.fn(),
  transitionGovernedWorkItem: mocks.transition,
}));

import { workContinuityRouter } from "./work-continuity";

const principal = {
  tenantId: "tn_demo",
  organizationId: "org_demo",
  userId: 7,
  adoptionId: "lgj-wealth",
  agentId: "wealth-agent",
  roleTemplate: "wealth-manager",
  workspaceId: "/workspace/lgj-wealth",
  permissionProfile: "plus",
  sessionId: "session-1",
  authorizationSnapshotId: "authz-1",
  authorizationFingerprint: "a".repeat(64),
  identityVersion: "2",
};

function caller() {
  return workContinuityRouter.createCaller({
    user: { id: 7, openId: "open-7", name: "财富专家", email: "expert@example.com", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { headers: {}, ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" } },
    res: {},
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolvePrincipal.mockResolvedValue({ complete: true, principal });
  mocks.transition.mockResolvedValue({
    item: { workItemId: "gwk_00000000-0000-4000-8000-000000000001", status: "done" },
    executionReceipt: { executionReceiptId: "wex_demo", approvalId: "apr_demo" },
    reused: false,
  });
});

describe("work continuity confirmation gate", () => {
  it("does not execute a direct write without an approved binding", async () => {
    mocks.enforceApproval.mockResolvedValue({
      effect: "REQUIRE_APPROVAL",
      reason: "confirmation required",
      requirement: { approvalId: "apr_pending", status: "pending", expiresAt: new Date("2026-08-23T12:00:00.000Z"), created: true },
    });
    const result = await caller().updateStatus({
      adoptId: "lgj-wealth",
      workItemId: "gwk_00000000-0000-4000-8000-000000000001",
      operation: "complete",
      idempotencyKey: "work-complete-001",
    });
    expect(result).toMatchObject({ approvalRequired: true, approvalId: "apr_pending" });
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it("executes only after the matching approval is consumed", async () => {
    mocks.enforceApproval.mockResolvedValue({ effect: "ALLOW", approval: { approvalId: "apr_approved" } });
    const result = await caller().updateStatus({
      adoptId: "lgj-wealth",
      workItemId: "gwk_00000000-0000-4000-8000-000000000001",
      operation: "complete",
      idempotencyKey: "work-complete-001",
      approvalId: "apr_approved",
    });
    expect(result).toMatchObject({ item: { status: "done" }, executionReceipt: { approvalId: "apr_demo" } });
    expect(mocks.transition).toHaveBeenCalledWith(expect.objectContaining({
      operation: "complete",
      idempotencyKey: "work-complete-001",
      approvalId: "apr_approved",
    }));
  });
});
