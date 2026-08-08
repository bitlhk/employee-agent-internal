import type { ToolSideEffect } from "../tool-governance";
import { capabilitySetFingerprint } from "./capability-registry";
import {
  evaluateGovernance,
  governanceFingerprint,
  type DelegationScope,
  type GovernanceDecision,
  type RuntimePrincipal,
} from "./contracts";

const RULE_VERSION = "delegation-v1";
const ALL_SIDE_EFFECTS: ToolSideEffect[] = [
  "read", "compute", "workspace_write", "write", "external_send",
  "financial_action", "approval_action", "admin_action",
];

function normalizedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(item => String(item || "").trim()).filter(Boolean))).sort();
}

function normalizedSideEffects(value: unknown): ToolSideEffect[] {
  const allowed = new Set<ToolSideEffect>(ALL_SIDE_EFFECTS);
  return normalizedStrings(value).filter(item => allowed.has(item as ToolSideEffect)) as ToolSideEffect[];
}

function profileSideEffects(profile: string): ToolSideEffect[] {
  if (profile === "internal") return [...ALL_SIDE_EFFECTS];
  if (profile === "plus") return ["read", "compute", "workspace_write", "external_send"];
  return ["read", "compute"];
}

function intersect<T extends string>(...sets: T[][]): T[] {
  if (sets.length === 0) return [];
  return Array.from(new Set(sets[0])).filter(item => sets.slice(1).every(set => set.includes(item))).sort();
}

function capabilityIntersection(parent: string[], child: string[], task: string[]): string[] {
  const parentAllowsAll = parent.includes("*");
  return child.filter(item => (parentAllowsAll || parent.includes(item)) && task.includes(item)).sort();
}

function intersectPatternPair(left: string, right: string): string | null {
  if (left === "*") return right;
  if (right === "*") return left;
  if (left === right) return left;
  const leftPrefix = left.endsWith("*") ? left.slice(0, -1) : null;
  const rightPrefix = right.endsWith("*") ? right.slice(0, -1) : null;
  if (leftPrefix !== null && right.startsWith(leftPrefix)) return right;
  if (rightPrefix !== null && left.startsWith(rightPrefix)) return left;
  return null;
}

function resourceIntersection(...scopes: string[][]): string[] | undefined {
  const constrained = scopes.filter(scope => scope.length > 0);
  if (constrained.length === 0) return undefined;
  let effective = constrained[0];
  for (const scope of constrained.slice(1)) {
    effective = Array.from(new Set(effective.flatMap(left => (
      scope.map(right => intersectPatternPair(left, right)).filter((item): item is string => Boolean(item))
    )))).sort();
    if (effective.length === 0) break;
  }
  return effective;
}

export type DelegationPolicyResult = {
  allowed: boolean;
  decision: GovernanceDecision;
  effectiveScope: DelegationScope;
  scopeFingerprint: string;
};

export async function evaluateDelegationPolicy(input: {
  principal: RuntimePrincipal;
  childCapabilityIds: unknown;
  endpointConfig?: Record<string, unknown>;
  requestedScope?: unknown;
}): Promise<DelegationPolicyResult> {
  const endpointConfig = input.endpointConfig || {};
  const configuredChild = endpointConfig.delegationScope && typeof endpointConfig.delegationScope === "object"
    ? endpointConfig.delegationScope as Record<string, unknown>
    : {};
  const requested = input.requestedScope && typeof input.requestedScope === "object"
    ? input.requestedScope as Record<string, unknown>
    : {};
  const parent = input.principal.delegationScope || {
    capabilityIds: input.principal.permissionProfile === "starter" ? [] : ["*"],
    sideEffects: profileSideEffects(input.principal.permissionProfile),
  };
  const advertisedChildCapabilities = normalizedStrings(input.childCapabilityIds);
  const configuredChildCapabilities = normalizedStrings(configuredChild.capabilityIds);
  const childCapabilityIds = configuredChildCapabilities.length > 0
    ? capabilityIntersection(["*"], advertisedChildCapabilities, configuredChildCapabilities)
    : advertisedChildCapabilities;
  const effectiveChildCapabilities = childCapabilityIds.length > 0
    ? childCapabilityIds
    : advertisedChildCapabilities.length === 0 && configuredChildCapabilities.length === 0
      ? ["agent"]
      : [];
  const requestedCapabilities = normalizedStrings(requested.capabilityIds);
  const taskCapabilityIds = requestedCapabilities.length > 0 ? requestedCapabilities : effectiveChildCapabilities;

  let childSideEffects = normalizedSideEffects(configuredChild.sideEffects);
  if (childSideEffects.length === 0) childSideEffects = ["read", "compute"];
  if (endpointConfig.governanceAttested !== true) {
    childSideEffects = childSideEffects.filter(item => item === "read" || item === "compute");
  }
  const requestedSideEffects = normalizedSideEffects(requested.sideEffects);
  const taskSideEffects = requestedSideEffects.length > 0 ? requestedSideEffects : childSideEffects;
  const effectiveResources = resourceIntersection(
    normalizedStrings(parent.resourcePatterns),
    normalizedStrings(configuredChild.resourcePatterns),
    normalizedStrings(requested.resourcePatterns),
  );
  const effectiveScope: DelegationScope = {
    capabilityIds: capabilityIntersection(parent.capabilityIds, effectiveChildCapabilities, taskCapabilityIds),
    sideEffects: intersect(parent.sideEffects, childSideEffects, taskSideEffects),
    ...(effectiveResources ? { resourcePatterns: effectiveResources } : {}),
  };
  const scopeFingerprint = governanceFingerprint(effectiveScope);
  const parentCanDelegate = parent.sideEffects.includes("external_send");
  const completePrincipal = Boolean(
    input.principal.userId > 0
    && input.principal.adoptionId
    && input.principal.agentId
    && input.principal.roleTemplate
    && input.principal.workspaceId
    && input.principal.permissionProfile,
  );
  const resourceScopeRequested = [
    normalizedStrings(parent.resourcePatterns),
    normalizedStrings(configuredChild.resourcePatterns),
    normalizedStrings(requested.resourcePatterns),
  ].some(scope => scope.length > 0);
  const resourcesCompatible = !resourceScopeRequested || Boolean(effectiveResources?.length);
  const allowed = completePrincipal
    && parentCanDelegate
    && effectiveScope.capabilityIds.length > 0
    && resourcesCompatible;
  const decision = await evaluateGovernance({
    principal: input.principal,
    operation: {
      capabilityId: "a2a.task",
      operation: "delegate",
      sideEffect: "external_send",
      payloadHash: scopeFingerprint,
    },
  }, [{
    id: "delegation-policy",
    evaluate: () => ({
      effect: allowed ? "ALLOW" : "DENY",
      policyCode: allowed ? "EA_DELEGATION_SCOPE_V1" : "EA_DELEGATION_SCOPE_DENIED",
      ruleVersion: RULE_VERSION,
      reason: allowed
        ? "Delegation scope is a non-expanding intersection."
        : !completePrincipal
          ? "Runtime principal is incomplete."
          : !parentCanDelegate
            ? "The parent principal cannot delegate external work."
            : !resourcesCompatible
              ? "No resource remains after delegation scope intersection."
              : "No child capability remains after scope intersection.",
      obligations: [
        { type: "AUDIT", level: "strong" },
        { type: "EGRESS_GUARD" },
      ],
    }),
  }], {
    effect: "DENY",
    policyCode: "EA_DELEGATION_POLICY_UNAVAILABLE",
    ruleVersion: RULE_VERSION,
    reason: "Delegation policy is unavailable.",
    obligations: [{ type: "AUDIT", level: "strong" }],
  });
  return { allowed, decision, effectiveScope, scopeFingerprint };
}

export function delegationScopeFromMetadata(metadata: unknown): DelegationScope | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const governance = (metadata as Record<string, unknown>)["ea.governance"];
  if (!governance || typeof governance !== "object") return undefined;
  const scope = (governance as Record<string, unknown>).effectiveScope;
  if (!scope || typeof scope !== "object") return undefined;
  return {
    capabilityIds: normalizedStrings((scope as Record<string, unknown>).capabilityIds),
    sideEffects: normalizedSideEffects((scope as Record<string, unknown>).sideEffects),
    ...(normalizedStrings((scope as Record<string, unknown>).resourcePatterns).length > 0
      ? { resourcePatterns: normalizedStrings((scope as Record<string, unknown>).resourcePatterns) }
      : {}),
  };
}

export function delegationEvidence(result: DelegationPolicyResult): Record<string, unknown> {
  return {
    version: "1.0.0",
    policyDecisionId: result.decision.decisionId,
    ruleVersion: result.decision.ruleVersion,
    principalFingerprint: result.decision.principalFingerprint,
    scopeFingerprint: result.scopeFingerprint,
    capabilitySetFingerprint: capabilitySetFingerprint(),
    effectiveScope: result.effectiveScope,
  };
}
