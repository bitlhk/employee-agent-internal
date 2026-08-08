import { randomUUID } from "node:crypto";
import type { GovernanceApproval } from "../../../drizzle/schema";
import {
  consumeGovernanceApproval,
  createGovernanceApproval,
  decideGovernanceApproval,
  getActiveGovernanceApproval,
  getGovernanceApproval,
} from "../../db/governance-approvals";
import type { GovernanceDecision, GovernanceOperation, RuntimePrincipal } from "./contracts";
import { governanceFingerprint } from "./contracts";
import { observeGovernanceApprovalTransition } from "../observability/metrics";

const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000;
const MAX_APPROVAL_TTL_MS = 60 * 60 * 1000;

export type ApprovalRequirement = {
  approvalId: string;
  status: "pending" | "approved";
  expiresAt: Date;
  created: boolean;
};

export type ApprovalEnforcement =
  | { effect: "ALLOW"; approval: GovernanceApproval | null }
  | { effect: "DENY"; reason: string; approval: GovernanceApproval | null }
  | { effect: "REQUIRE_APPROVAL"; reason: string; requirement: ApprovalRequirement };

export function governanceApprovalBinding(input: {
  principal: RuntimePrincipal;
  operation: GovernanceOperation;
  decision?: Pick<GovernanceDecision, "policyCode" | "ruleVersion">;
  idempotencyKey?: string | null;
}): string {
  return governanceFingerprint({
    principal: {
      userId: input.principal.userId,
      adoptionId: input.principal.adoptionId,
      agentId: input.principal.agentId,
      workspaceId: input.principal.workspaceId,
      roleTemplate: input.principal.roleTemplate,
      permissionProfile: input.principal.permissionProfile,
    },
    operation: {
      capabilityId: input.operation.capabilityId,
      operation: input.operation.operation,
      resource: input.operation.resource || null,
      payloadHash: input.operation.payloadHash || "",
    },
    idempotencyKey: input.idempotencyKey || null,
    policyCode: input.decision?.policyCode || null,
    ruleVersion: input.decision?.ruleVersion || null,
  });
}

export async function requestGovernanceApproval(input: {
  decision: GovernanceDecision;
  principal: RuntimePrincipal;
  operation: GovernanceOperation;
  idempotencyKey?: string | null;
  ttlMs?: number;
}): Promise<ApprovalRequirement> {
  const ttlMs = Math.min(Math.max(input.ttlMs || DEFAULT_APPROVAL_TTL_MS, 60_000), MAX_APPROVAL_TTL_MS);
  const activeBindingKey = governanceApprovalBinding(input);
  const result = await createGovernanceApproval({
    approvalId: `apr_${randomUUID()}`,
    activeBindingKey,
    policyDecisionId: input.decision.decisionId,
    policyCode: input.decision.policyCode,
    ruleVersion: input.decision.ruleVersion,
    principalFingerprint: input.decision.principalFingerprint,
    userId: input.principal.userId,
    adoptId: input.principal.adoptionId,
    capabilityId: input.operation.capabilityId,
    operation: input.operation.operation,
    resource: input.operation.resource || null,
    payloadHash: input.operation.payloadHash || governanceFingerprint(null),
    idempotencyKey: input.idempotencyKey || null,
    reason: input.decision.reason,
    decisionReason: null,
    expiresAt: new Date(Date.now() + ttlMs),
    decidedBy: null,
    approvedAt: null,
    rejectedAt: null,
    consumedAt: null,
  });
  observeGovernanceApprovalTransition(result.created ? "created" : "reused");
  return {
    approvalId: result.approval.approvalId,
    status: result.approval.status === "approved" ? "approved" : "pending",
    expiresAt: result.approval.expiresAt,
    created: result.created,
  };
}

export async function enforceGovernanceApproval(input: {
  decision: GovernanceDecision;
  principal: RuntimePrincipal;
  operation: GovernanceOperation;
  approvalId?: string | null;
  idempotencyKey?: string | null;
  ttlMs?: number;
}): Promise<ApprovalEnforcement> {
  if (input.decision.effect === "ALLOW") return { effect: "ALLOW", approval: null };
  if (input.decision.effect === "DENY") {
    return { effect: "DENY", reason: input.decision.reason, approval: null };
  }

  const activeBindingKey = governanceApprovalBinding(input);
  const approval = input.approvalId
    ? await getGovernanceApproval(input.approvalId)
    : await getActiveGovernanceApproval(activeBindingKey);
  if (approval?.status === "approved") {
    const consumed = await consumeGovernanceApproval({
      approvalId: approval.approvalId,
      principalFingerprint: input.decision.principalFingerprint,
      userId: input.principal.userId,
      adoptId: input.principal.adoptionId,
      capabilityId: input.operation.capabilityId,
      operation: input.operation.operation,
      resource: input.operation.resource || null,
      payloadHash: input.operation.payloadHash || governanceFingerprint(null),
      policyCode: input.decision.policyCode,
      ruleVersion: input.decision.ruleVersion,
    });
    if (consumed) {
      observeGovernanceApprovalTransition("consumed");
      return { effect: "ALLOW", approval: consumed };
    }
    observeGovernanceApprovalTransition("consume_conflict", "failed");
    return { effect: "DENY", reason: "审批已失效、已消费或与当前动作不匹配。", approval };
  }
  if (approval && approval.status !== "pending") {
    return { effect: "DENY", reason: `审批当前状态为 ${approval.status}，不能执行该动作。`, approval };
  }
  const requirement = approval ? {
    approvalId: approval.approvalId,
    status: "pending" as const,
    expiresAt: approval.expiresAt,
    created: false,
  } : await requestGovernanceApproval(input);
  return { effect: "REQUIRE_APPROVAL", reason: input.decision.reason, requirement };
}

export async function decideApproval(input: {
  approvalId: string;
  userId: number;
  adoptId: string;
  decision: "approved" | "rejected";
  reason?: string | null;
}): Promise<GovernanceApproval | null> {
  const approval = await decideGovernanceApproval({
    approvalId: input.approvalId,
    userId: input.userId,
    adoptId: input.adoptId,
    decision: input.decision,
    decisionReason: input.reason || null,
  });
  observeGovernanceApprovalTransition(input.decision, approval ? "success" : "failed");
  return approval;
}

export function approvalRequiredToolResult(input: {
  approvalId: string;
  expiresAt: Date;
  reason: string;
}) {
  return {
    content: [{
      type: "text",
      text: `该操作需要人工审批。审批编号：${input.approvalId}。审批通过后，以相同参数重试即可继续。`,
    }],
    isError: true,
    _meta: {
      eaGovernance: {
        code: "EA_APPROVAL_REQUIRED",
        approvalId: input.approvalId,
        expiresAt: input.expiresAt.toISOString(),
        reason: input.reason,
      },
    },
  };
}
