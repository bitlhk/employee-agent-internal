import { createHash } from "node:crypto";
import type {
  ConcreteContextPlanV1,
  ContextBindingStageV1,
  ContextNeedPlanV1,
  ContextResolutionReasonCodeV1,
  ContextSourceBindingV1,
  ResolvedContextNeedV1,
} from "../../../shared/context-resolution";

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function bindingKey(binding: ContextSourceBindingV1): string {
  return [binding.organizationId, binding.rolePackId, binding.logicalAssetId, binding.contextType, binding.stage].join("|");
}

function eligibleBindings(input: {
  bindings: ContextSourceBindingV1[];
  organizationId: string;
  rolePackId: string;
  stage: ContextBindingStageV1;
}): ContextSourceBindingV1[] {
  const scoped = input.bindings.filter((binding) => (
    binding.rolePackId === input.rolePackId
    && binding.stage === input.stage
    && (binding.organizationId === input.organizationId || binding.organizationId === "*")
  ));
  const exactLogicalAssets = new Set(scoped
    .filter((binding) => binding.organizationId === input.organizationId)
    .map((binding) => `${binding.logicalAssetId}|${binding.contextType}`));
  return scoped.filter((binding) => binding.status === "active").filter((binding) => (
    binding.organizationId === input.organizationId
    || !exactLogicalAssets.has(`${binding.logicalAssetId}|${binding.contextType}`)
  ));
}

function relevantBindings(input: {
  bindings: ContextSourceBindingV1[];
  organizationId: string;
  rolePackId: string;
  stage: ContextBindingStageV1;
}): ContextSourceBindingV1[] {
  return input.bindings.filter((binding) => (
    binding.rolePackId === input.rolePackId
    && binding.stage === input.stage
    && (binding.organizationId === input.organizationId || binding.organizationId === "*")
  ));
}

export function resolveContextSources(input: {
  plan: ContextNeedPlanV1;
  bindings: ContextSourceBindingV1[];
  organizationId: string;
  stage?: ContextBindingStageV1;
}): ConcreteContextPlanV1 {
  const stage = input.stage || "production";
  const relevant = relevantBindings({
    bindings: input.bindings,
    organizationId: input.organizationId,
    rolePackId: input.plan.rolePackId,
    stage,
  });
  const bindings = eligibleBindings({
    bindings: input.bindings,
    organizationId: input.organizationId,
    rolePackId: input.plan.rolePackId,
    stage,
  });
  const resolutions: ResolvedContextNeedV1[] = input.plan.needs.map((need) => {
    const logicalCandidates = relevant.filter((binding) => (
      binding.logicalAssetId === need.logicalAssetId
      && binding.contextType === need.contextType
    ));
    const matches = bindings.filter((binding) => (
      binding.logicalAssetId === need.logicalAssetId
      && binding.contextType === need.contextType
      && (need.requiredCapabilities || []).every((capability) => binding.capabilities.includes(capability))
    ));
    if (matches.length === 1) return { need, binding: matches[0], status: "resolved" };
    if (!matches.length) {
      const reasonCode = logicalCandidates.some((binding) => binding.status === "disabled")
        ? "BINDING_DISABLED" as const
        : logicalCandidates.some((binding) => binding.status === "active")
          ? "CAPABILITY_MISMATCH" as const
          : "NO_BINDING" as const;
      return {
        need,
        binding: null,
        status: "missing",
        reasonCode,
        reason: reasonCode === "BINDING_DISABLED"
          ? `The ${stage} binding is disabled`
          : reasonCode === "CAPABILITY_MISMATCH"
            ? `The active ${stage} binding lacks required capabilities`
            : `No ${stage} binding exists`,
      };
    }
    return {
      need,
      binding: null,
      status: "ambiguous",
      reasonCode: "AMBIGUOUS_BINDING",
      reason: `Multiple active bindings: ${matches.map(bindingKey).sort().join(", ")}`,
    };
  });
  const requiredFailure = resolutions.some((item) => item.need.requiredness === "required" && item.status !== "resolved");
  const optionalFailure = resolutions.some((item) => item.need.requiredness === "optional" && item.status !== "resolved");
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
    bindingSnapshotFingerprint: fingerprint(relevant
      .map((binding) => ({
        bindingId: binding.bindingId,
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
  const outcomes = new Map(input.outcomes.map((outcome) => [outcome.logicalAssetId, outcome]));
  const resolutions = input.plan.resolutions.map((resolution) => {
    const outcome = outcomes.get(resolution.need.logicalAssetId);
    if (!outcome || outcome.usable || resolution.status !== "resolved") return resolution;
    return {
      ...resolution,
      status: "missing" as const,
      reasonCode: outcome.reasonCode || "NO_USABLE_CONTEXT" as const,
      reason: "The resolved source did not provide usable Context",
    };
  });
  const requiredFailure = resolutions.some((item) => item.need.requiredness === "required" && item.status !== "resolved");
  const optionalFailure = resolutions.some((item) => item.need.requiredness === "optional" && item.status !== "resolved");
  const body = {
    ...input.plan,
    status: requiredFailure ? "BLOCKED" as const : optionalFailure ? "DEGRADED" as const : "READY" as const,
    resolutions,
  };
  return { ...body, resolutionFingerprint: fingerprint({ ...body, resolutionFingerprint: undefined }) };
}
