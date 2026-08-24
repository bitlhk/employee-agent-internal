import { createHash } from "node:crypto";
import type {
  ConcreteContextPlanV1,
  ContextBindingScopeV1,
  ContextBindingStageV1,
  ContextNeedPlanV1,
  ContextNeedV1,
  ContextResolutionReasonCodeV1,
  ContextSourceBindingV1,
  ResolvedContextNeedV1,
} from "../../../shared/context-resolution";

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function scopeOf(binding: ContextSourceBindingV1): ContextBindingScopeV1 {
  // Old immutable promotion snapshots can predate bindingScope.
  return binding.bindingScope || "role_pack";
}

function bindingKey(binding: ContextSourceBindingV1): string {
  return [
    binding.organizationId,
    scopeOf(binding),
    binding.rolePackId,
    binding.logicalAssetId,
    binding.contextType,
    binding.stage,
  ].join("|");
}

function roleBindings(input: {
  bindings: ContextSourceBindingV1[];
  organizationId: string;
  rolePackId: string;
  stage: ContextBindingStageV1;
}): ContextSourceBindingV1[] {
  const scoped = input.bindings.filter(binding => (
    scopeOf(binding) === "role_pack"
    && binding.rolePackId === input.rolePackId
    && binding.stage === input.stage
    && (binding.organizationId === input.organizationId || binding.organizationId === "*")
  ));
  const organizationOverrides = new Set(scoped
    .filter(binding => binding.organizationId === input.organizationId)
    .map(binding => `${binding.logicalAssetId}|${binding.contextType}`));
  return scoped.filter(binding => (
    binding.organizationId === input.organizationId
    || !organizationOverrides.has(`${binding.logicalAssetId}|${binding.contextType}`)
  ));
}

function sharedBindings(input: {
  bindings: ContextSourceBindingV1[];
  organizationId: string;
  stage: ContextBindingStageV1;
}): ContextSourceBindingV1[] {
  return input.bindings.filter(binding => (
    scopeOf(binding) === "enterprise_shared"
    && binding.rolePackId === "*"
    && binding.organizationId === input.organizationId
    && binding.stage === input.stage
  ));
}

function resolveTier(input: {
  need: ContextNeedV1;
  candidates: ContextSourceBindingV1[];
  stage: ContextBindingStageV1;
  tier: "exact" | "shared";
}): ResolvedContextNeedV1 {
  const active = input.candidates.filter(binding => binding.status === "active");
  const matches = active.filter(binding => (
    (input.need.requiredCapabilities || []).every(capability => binding.capabilities.includes(capability))
  ));
  if (matches.length === 1) return { need: input.need, binding: matches[0], status: "resolved" };
  if (matches.length > 1) {
    return {
      need: input.need,
      binding: null,
      status: "ambiguous",
      reasonCode: input.tier === "shared" ? "AMBIGUOUS_SHARED_BINDING" : "AMBIGUOUS_BINDING",
      reason: `Multiple active ${input.tier} bindings: ${matches.map(bindingKey).sort().join(", ")}`,
    };
  }
  const capabilityMismatch = active.length > 0;
  const reasonCode: ContextResolutionReasonCodeV1 = input.tier === "exact"
    ? capabilityMismatch ? "EXACT_BINDING_CAPABILITY_MISMATCH" : "EXACT_BINDING_DISABLED"
    : capabilityMismatch ? "CAPABILITY_MISMATCH" : "BINDING_DISABLED";
  return {
    need: input.need,
    binding: null,
    status: "missing",
    reasonCode,
    reason: capabilityMismatch
      ? `The active ${input.tier} ${input.stage} binding lacks required capabilities`
      : `The ${input.tier} ${input.stage} binding is disabled`,
  };
}

export function resolveContextSources(input: {
  plan: ContextNeedPlanV1;
  bindings: ContextSourceBindingV1[];
  organizationId: string;
  stage?: ContextBindingStageV1;
}): ConcreteContextPlanV1 {
  const stage = input.stage || "production";
  const exact = roleBindings({
    bindings: input.bindings,
    organizationId: input.organizationId,
    rolePackId: input.plan.rolePackId,
    stage,
  });
  const shared = sharedBindings({ bindings: input.bindings, organizationId: input.organizationId, stage });
  const hasSharedScope = shared.length > 0;
  const resolutions: ResolvedContextNeedV1[] = input.plan.needs.map(need => {
    const exactCandidates = exact.filter(binding => (
      binding.logicalAssetId === need.logicalAssetId && binding.contextType === need.contextType
    ));
    if (exactCandidates.length) return resolveTier({ need, candidates: exactCandidates, stage, tier: "exact" });

    const sharedCandidates = shared.filter(binding => (
      binding.logicalAssetId === need.logicalAssetId && binding.contextType === need.contextType
    ));
    if (sharedCandidates.length) return resolveTier({ need, candidates: sharedCandidates, stage, tier: "shared" });

    return {
      need,
      binding: null,
      status: "missing",
      reasonCode: hasSharedScope ? "NO_SHARED_BINDING" : "NO_BINDING",
      reason: hasSharedScope
        ? `No exact or enterprise-shared ${stage} binding exists`
        : `No ${stage} binding exists`,
    };
  });
  const requiredFailure = resolutions.some(item => item.need.requiredness === "required" && item.status !== "resolved");
  const optionalFailure = resolutions.some(item => item.need.requiredness === "optional" && item.status !== "resolved");
  const snapshotBindings = [...exact, ...shared];
  const body = {
    schema: "ea.concrete-context-plan.v1" as const,
    planId: input.plan.planId,
    planVersion: input.plan.planVersion,
    taskId: input.plan.taskId,
    rolePackId: input.plan.rolePackId,
    organizationId: input.organizationId,
    stage,
    status: requiredFailure ? "BLOCKED" as const : optionalFailure ? "DEGRADED" as const : "READY" as const,
    resolutions,
    bindingSnapshotFingerprint: fingerprint(snapshotBindings
      .map(binding => ({
        bindingId: binding.bindingId,
        bindingScope: scopeOf(binding),
        bindingVersion: binding.bindingVersion,
        logicalAssetId: binding.logicalAssetId,
        contextType: binding.contextType,
        providerType: binding.providerType,
        resourceRef: binding.resourceRef,
        capabilities: [...binding.capabilities].sort(),
        status: binding.status,
      }))
      .sort((left, right) => left.bindingId.localeCompare(right.bindingId))),
  };
  return { ...body, resolutionFingerprint: fingerprint(body) };
}

export function applyContextResolutionOutcomes(input: {
  plan: ConcreteContextPlanV1 | null;
  outcomes: Array<{
    logicalAssetId: string;
    usable: boolean;
    reasonCode?: ContextResolutionReasonCodeV1;
  }>;
}): ConcreteContextPlanV1 | null {
  if (!input.plan) return null;
  const outcomes = new Map(input.outcomes.map(outcome => [outcome.logicalAssetId, outcome]));
  const resolutions = input.plan.resolutions.map(resolution => {
    const outcome = outcomes.get(resolution.need.logicalAssetId);
    if (!outcome || outcome.usable || resolution.status !== "resolved") return resolution;
    return {
      ...resolution,
      status: "missing" as const,
      reasonCode: outcome.reasonCode || "NO_USABLE_CONTEXT" as const,
      reason: "The resolved source did not provide usable Context",
    };
  });
  const requiredFailure = resolutions.some(item => item.need.requiredness === "required" && item.status !== "resolved");
  const optionalFailure = resolutions.some(item => item.need.requiredness === "optional" && item.status !== "resolved");
  const body = {
    ...input.plan,
    status: requiredFailure ? "BLOCKED" as const : optionalFailure ? "DEGRADED" as const : "READY" as const,
    resolutions,
  };
  return { ...body, resolutionFingerprint: fingerprint({ ...body, resolutionFingerprint: undefined }) };
}
