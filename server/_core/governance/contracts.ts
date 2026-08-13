import { createHash, randomUUID } from "node:crypto";
import type { ToolSideEffect } from "../tool-governance";
import { observeGovernanceDecision } from "../observability/metrics";

export type GovernanceEffect = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";

export type DelegationScope = {
  capabilityIds: string[];
  sideEffects: ToolSideEffect[];
  resourcePatterns?: string[];
};

export type RuntimePrincipal = {
  userId: number;
  adoptionId: string;
  agentId: string;
  roleTemplate: string;
  workspaceId: string;
  permissionProfile: string;
  sessionId: string;
  taskId?: string;
  delegationScope?: DelegationScope;
};

export type RuntimePrincipalV2 = RuntimePrincipal & {
  tenantId: string;
  organizationId: string;
  authorizationSnapshotId: string;
  authorizationFingerprint: string;
  identityVersion: "2";
};

export type GovernanceOperation = {
  capabilityId: string;
  operation: string;
  sideEffect: ToolSideEffect;
  resource?: string;
  payloadHash?: string;
};

export type GovernanceObligation =
  | { type: "AUDIT"; level: "normal" | "strong" | "highest" }
  | { type: "APPROVAL"; mode: "conditional" | "always" }
  | { type: "IDEMPOTENCY_KEY" }
  | { type: "WORKSPACE_BOUNDARY"; workspaceId: string }
  | { type: "EGRESS_GUARD" };

export type GovernanceDecision = {
  decisionId: string;
  effect: GovernanceEffect;
  policyCode: string;
  ruleVersion: string;
  reason: string;
  obligations: GovernanceObligation[];
  principalFingerprint: string;
  operationFingerprint: string;
};

export type GovernanceDecisionDraft = Omit<
  GovernanceDecision,
  "decisionId" | "principalFingerprint" | "operationFingerprint"
>;

export type GovernanceRequest = {
  principal: RuntimePrincipal;
  operation: GovernanceOperation;
  context?: Record<string, unknown>;
};

export type GovernancePolicyAdapter = {
  id: string;
  evaluate(request: GovernanceRequest): Promise<GovernanceDecisionDraft | null> | GovernanceDecisionDraft | null;
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>).sort().reduce((result, key) => {
    result[key] = canonicalValue((value as Record<string, unknown>)[key]);
    return result;
  }, {} as Record<string, unknown>);
}

export function governanceFingerprint(value: unknown): string {
  let serialized = "";
  try {
    serialized = JSON.stringify(canonicalValue(value)) ?? String(value ?? "");
  } catch {
    serialized = String(value ?? "");
  }
  return createHash("sha256").update(serialized).digest("hex");
}

export function principalFingerprint(principal: RuntimePrincipal | RuntimePrincipalV2): string {
  const v2 = "identityVersion" in principal ? principal : null;
  return governanceFingerprint({
    tenantId: v2?.tenantId || null,
    organizationId: v2?.organizationId || null,
    authorizationSnapshotId: v2?.authorizationSnapshotId || null,
    authorizationFingerprint: v2?.authorizationFingerprint || null,
    identityVersion: v2?.identityVersion || "1",
    userId: principal.userId,
    adoptionId: principal.adoptionId,
    agentId: principal.agentId,
    roleTemplate: principal.roleTemplate,
    workspaceId: principal.workspaceId,
    permissionProfile: principal.permissionProfile,
    sessionId: principal.sessionId,
    taskId: principal.taskId || null,
    delegationScope: principal.delegationScope || null,
  });
}

export function finalizeGovernanceDecision(
  request: GovernanceRequest,
  draft: GovernanceDecisionDraft,
): GovernanceDecision {
  const decision = {
    ...draft,
    decisionId: `pdec_${randomUUID()}`,
    principalFingerprint: principalFingerprint(request.principal),
    operationFingerprint: governanceFingerprint(request.operation),
  };
  observeGovernanceDecision({ capabilityId: request.operation.capabilityId, effect: decision.effect });
  return decision;
}

export async function evaluateGovernance(
  request: GovernanceRequest,
  adapters: readonly GovernancePolicyAdapter[],
  fallback: GovernanceDecisionDraft,
): Promise<GovernanceDecision> {
  for (const adapter of adapters) {
    const decision = await adapter.evaluate(request);
    if (decision) return finalizeGovernanceDecision(request, decision);
  }
  return finalizeGovernanceDecision(request, fallback);
}
