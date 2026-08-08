import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consumeGovernanceApproval: vi.fn(),
  createGovernanceApproval: vi.fn(),
  decideGovernanceApproval: vi.fn(),
  getActiveGovernanceApproval: vi.fn(),
  getGovernanceApproval: vi.fn(),
}));

vi.mock("../../db/governance-approvals", () => mocks);

import {
  enforceGovernanceApproval,
  governanceApprovalBinding,
} from "./approval-service";
import {
  finalizeGovernanceDecision,
  type GovernanceOperation,
  type RuntimePrincipal,
} from "./contracts";

const principal: RuntimePrincipal = {
  userId: 7,
  adoptionId: "lgj-test-user",
  agentId: "jiuwen_lgj-test-user",
  roleTemplate: "wealth-manager",
  workspaceId: "/workspace/lgj-test-user",
  permissionProfile: "plus",
  sessionId: "session-1",
};

const operation: GovernanceOperation = {
  capabilityId: "enterprise.mcp",
  operation: "update_customer",
  sideEffect: "write",
  resource: "enterprise-mcp:crm",
  payloadHash: "a".repeat(64),
};

function decision(effect: "ALLOW" | "DENY" | "REQUIRE_APPROVAL") {
  return finalizeGovernanceDecision({ principal, operation }, {
    effect,
    policyCode: "EA_TEST_POLICY",
    ruleVersion: "test-v1",
    reason: "test decision",
    obligations: [],
  });
}

function approval(status: "pending" | "approved" | "consumed" = "pending") {
  const currentDecision = decision("REQUIRE_APPROVAL");
  return {
    id: 1,
    approvalId: "apr_00000000-0000-4000-8000-000000000001",
    activeBindingKey: governanceApprovalBinding({ principal, operation, idempotencyKey: "idem-1" }),
    status,
    policyDecisionId: currentDecision.decisionId,
    policyCode: currentDecision.policyCode,
    ruleVersion: currentDecision.ruleVersion,
    principalFingerprint: currentDecision.principalFingerprint,
    userId: principal.userId,
    adoptId: principal.adoptionId,
    capabilityId: operation.capabilityId,
    operation: operation.operation,
    resource: operation.resource || null,
    payloadHash: operation.payloadHash!,
    idempotencyKey: "idem-1",
    reason: "test decision",
    decisionReason: null,
    expiresAt: new Date(Date.now() + 60_000),
    decidedBy: null,
    approvedAt: status === "approved" ? new Date() : null,
    rejectedAt: null,
    consumedAt: status === "consumed" ? new Date() : null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("governance approval service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not touch approval storage for an allowed operation", async () => {
    await expect(enforceGovernanceApproval({
      decision: decision("ALLOW"), principal, operation,
    })).resolves.toEqual({ effect: "ALLOW", approval: null });
    expect(mocks.getActiveGovernanceApproval).not.toHaveBeenCalled();
  });

  it("reuses a pending approval for the same stable action binding", async () => {
    const pending = approval("pending");
    mocks.getActiveGovernanceApproval.mockResolvedValue(pending);
    const result = await enforceGovernanceApproval({
      decision: decision("REQUIRE_APPROVAL"),
      principal,
      operation,
      idempotencyKey: "idem-1",
    });
    expect(result).toMatchObject({
      effect: "REQUIRE_APPROVAL",
      requirement: { approvalId: pending.approvalId, created: false },
    });
    expect(mocks.createGovernanceApproval).not.toHaveBeenCalled();
  });

  it("atomically consumes an approved action with the current principal fingerprint", async () => {
    const approved = approval("approved");
    const currentDecision = decision("REQUIRE_APPROVAL");
    approved.principalFingerprint = currentDecision.principalFingerprint;
    mocks.getActiveGovernanceApproval.mockResolvedValue(approved);
    mocks.consumeGovernanceApproval.mockResolvedValue({ ...approved, status: "consumed" });
    const result = await enforceGovernanceApproval({
      decision: currentDecision,
      principal,
      operation,
      idempotencyKey: "idem-1",
    });
    expect(result).toMatchObject({ effect: "ALLOW", approval: { status: "consumed" } });
    expect(mocks.consumeGovernanceApproval).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: approved.approvalId,
      principalFingerprint: currentDecision.principalFingerprint,
      capabilityId: operation.capabilityId,
      payloadHash: operation.payloadHash,
    }));
  });

  it("fails closed when another caller consumes the approval first", async () => {
    const approved = approval("approved");
    mocks.getActiveGovernanceApproval.mockResolvedValue(approved);
    mocks.consumeGovernanceApproval.mockResolvedValue(null);
    await expect(enforceGovernanceApproval({
      decision: decision("REQUIRE_APPROVAL"),
      principal,
      operation,
      idempotencyKey: "idem-1",
    })).resolves.toMatchObject({ effect: "DENY" });
  });

  it("changes the binding when authority or payload changes", () => {
    const baselineDecision = decision("REQUIRE_APPROVAL");
    const baseline = governanceApprovalBinding({
      principal, operation, decision: baselineDecision, idempotencyKey: "idem-1",
    });
    expect(governanceApprovalBinding({
      principal: { ...principal, permissionProfile: "starter" },
      operation,
      decision: baselineDecision,
      idempotencyKey: "idem-1",
    })).not.toBe(baseline);
    expect(governanceApprovalBinding({
      principal,
      operation: { ...operation, payloadHash: "b".repeat(64) },
      decision: baselineDecision,
      idempotencyKey: "idem-1",
    })).not.toBe(baseline);
    expect(governanceApprovalBinding({
      principal,
      operation: { ...operation, resource: "enterprise-mcp:another-server" },
      decision: baselineDecision,
      idempotencyKey: "idem-1",
    })).not.toBe(baseline);
    expect(governanceApprovalBinding({
      principal,
      operation,
      decision: { ...baselineDecision, ruleVersion: "test-v2" },
      idempotencyKey: "idem-1",
    })).not.toBe(baseline);
  });
});
