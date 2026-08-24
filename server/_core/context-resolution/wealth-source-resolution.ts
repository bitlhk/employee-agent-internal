import { createHash } from "node:crypto";
import type { RuntimePrincipalV2 } from "../governance/contracts";
import type {
  ConcreteContextPlanV1,
  ContextResolutionReasonCodeV1,
  ContextResolutionEvidenceV1,
  ContextSourceBindingV1,
} from "../../../shared/context-resolution";
import { listContextSourceBindingContracts } from "../../db";
import { appendLogAsync } from "../helpers";
import { observeContextResolutionShadow } from "../observability/metrics";
import { resolveContextSources } from "./source-resolver";
import { wealthContextNeedPlan } from "./wealth-context-plans";

export type WealthKnowledgeSourceResolution = {
  mode: "legacy" | "binding";
  binding: ContextSourceBindingV1 | null;
  plan: ConcreteContextPlanV1 | null;
};

export type WealthContextPlanResolution = {
  mode: "legacy" | "binding";
  plan: ConcreteContextPlanV1 | null;
};

export type WealthTaskContextSnapshot = {
  plans: Partial<Record<"knowledge" | "business_data" | "memory", WealthContextPlanResolution>>;
  bindingSnapshotFingerprint?: string;
};

export type ContextBindingEvidence = {
  logicalAssetId: string;
  bindingId: string;
  bindingScope: "role_pack" | "enterprise_shared";
  bindingVersion: string;
  providerType: "llamaindex" | "mcp" | "api";
  resourceRefFingerprint: string;
};

export function contextBindingEvidence(binding: ContextSourceBindingV1 | null): ContextBindingEvidence | null {
  return binding ? {
    logicalAssetId: binding.logicalAssetId,
    bindingId: binding.bindingId,
    bindingScope: binding.bindingScope || "role_pack",
    bindingVersion: binding.bindingVersion,
    providerType: binding.providerType,
    resourceRefFingerprint: createHash("sha256").update(binding.resourceRef).digest("hex"),
  } : null;
}

export function contextResolutionEvidence(
  plans: Array<ConcreteContextPlanV1 | null | undefined>,
): ContextResolutionEvidenceV1 | undefined {
  const available = plans.filter((plan): plan is ConcreteContextPlanV1 => Boolean(plan));
  if (!available.length) return undefined;
  const unique = new Map<string, ContextResolutionEvidenceV1["needs"][number]>();
  for (const resolution of available.flatMap((plan) => plan.resolutions)) {
    const bindingEvidence = contextBindingEvidence(resolution.binding);
    unique.set(`${resolution.need.logicalAssetId}|${resolution.need.contextType}`, {
      logicalAssetId: resolution.need.logicalAssetId,
      contextType: resolution.need.contextType,
      requiredness: resolution.need.requiredness,
      resolutionStatus: resolution.status,
      ...(resolution.reasonCode ? { reasonCode: resolution.reasonCode } : {}),
      ...(bindingEvidence ? {
        bindingId: bindingEvidence.bindingId,
        bindingScope: bindingEvidence.bindingScope,
        bindingVersion: bindingEvidence.bindingVersion,
        providerType: bindingEvidence.providerType,
        resourceRefFingerprint: bindingEvidence.resourceRefFingerprint,
        rolePackId: available[0].rolePackId,
        purpose: resolution.need.purpose,
      } : {}),
    });
  }
  const needs = Array.from(unique.values()).sort((left, right) => left.logicalAssetId.localeCompare(right.logicalAssetId));
  const status = available.some((plan) => plan.status === "BLOCKED")
    ? "BLOCKED" as const
    : available.some((plan) => plan.status === "DEGRADED")
      ? "DEGRADED" as const
      : "READY" as const;
  const body = {
    schema: "ea.context-resolution-evidence.v1" as const,
    planId: available[0].planId,
    planVersion: available[0].planVersion,
    taskId: available[0].taskId,
    status,
    needs,
    bindingSnapshotFingerprint: createHash("sha256")
      .update([...new Set(available.map((plan) => plan.bindingSnapshotFingerprint))].sort().join("|"))
      .digest("hex"),
  };
  return {
    ...body,
    resolutionFingerprint: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  };
}

export function applyContextResolutionEvidenceOutcomes(input: {
  evidence: ContextResolutionEvidenceV1 | undefined;
  outcomes: Array<{
    logicalAssetId: string;
    usable: boolean;
    reasonCode?: ContextResolutionReasonCodeV1;
  }>;
}): ContextResolutionEvidenceV1 | undefined {
  if (!input.evidence) return undefined;
  const outcomes = new Map(input.outcomes.map((outcome) => [outcome.logicalAssetId, outcome]));
  const needs = input.evidence.needs.map((need) => {
    const outcome = outcomes.get(need.logicalAssetId);
    if (!outcome || outcome.usable || need.resolutionStatus !== "resolved") return need;
    return {
      ...need,
      resolutionStatus: "missing" as const,
      reasonCode: outcome.reasonCode || "NO_USABLE_CONTEXT" as const,
    };
  });
  const status = needs.some((need) => need.requiredness === "required" && need.resolutionStatus !== "resolved")
    ? "BLOCKED" as const
    : needs.some((need) => need.requiredness === "optional" && need.resolutionStatus !== "resolved")
      ? "DEGRADED" as const
      : "READY" as const;
  const body = { ...input.evidence, status, needs };
  return {
    ...body,
    resolutionFingerprint: createHash("sha256")
      .update(JSON.stringify({ ...body, resolutionFingerprint: undefined }))
      .digest("hex"),
  };
}

function enabled(name: string): boolean {
  return String(process.env[name] || "").trim().toLowerCase() === "true";
}

async function concretePlan(input: {
  taskId: string;
  organizationId: string;
  stage: "production" | "shadow";
  contextType?: "knowledge" | "business_data";
  bindings?: ContextSourceBindingV1[];
}): Promise<ConcreteContextPlanV1 | null> {
  const sourcePlan = wealthContextNeedPlan(input.taskId);
  if (!sourcePlan) return null;
  const plan = input.contextType
    ? { ...sourcePlan, needs: sourcePlan.needs.filter((need) => need.contextType === input.contextType) }
    : sourcePlan;
  if (!plan.needs.length) return null;
  const bindings = input.bindings || await listContextSourceBindingContracts({
      organizationId: input.organizationId,
      rolePackId: plan.rolePackId,
      stage: input.stage,
    });
  return resolveContextSources({ plan, bindings, organizationId: input.organizationId, stage: input.stage });
}

function resolutionFlag(contextType: "knowledge" | "business_data"): string {
  return contextType === "knowledge"
    ? "EA_CONTEXT_RESOLUTION_KNOWLEDGE_ENABLED"
    : "EA_CONTEXT_RESOLUTION_BUSINESS_DATA_ENABLED";
}

export async function resolveWealthTaskContextSnapshot(input: {
  taskId: string;
  organizationId: string;
  contextTypes: Array<"knowledge" | "business_data">;
}): Promise<WealthTaskContextSnapshot> {
  const sourcePlan = wealthContextNeedPlan(input.taskId);
  if (!sourcePlan) return { plans: {} };
  const enabledTypes = input.contextTypes.filter((contextType) => enabled(resolutionFlag(contextType)));
  const plans: WealthTaskContextSnapshot["plans"] = Object.fromEntries(
    input.contextTypes.map((contextType) => [contextType, { mode: "legacy", plan: null }]),
  );
  if (!enabledTypes.length) return { plans };
  const bindings = await listContextSourceBindingContracts({
    organizationId: input.organizationId,
    rolePackId: sourcePlan.rolePackId,
    stage: "production",
  });
  for (const contextType of enabledTypes) {
    plans[contextType] = {
      mode: "binding",
      plan: await concretePlan({
        taskId: input.taskId,
        organizationId: input.organizationId,
        stage: "production",
        contextType,
        bindings,
      }),
    };
  }
  const fingerprints = Object.values(plans)
    .map((resolution) => resolution?.plan?.bindingSnapshotFingerprint)
    .filter((value): value is string => Boolean(value));
  return {
    plans,
    ...(fingerprints.length ? {
      bindingSnapshotFingerprint: createHash("sha256").update([...new Set(fingerprints)].sort().join("|")).digest("hex"),
    } : {}),
  };
}

export async function resolveWealthContextPlan(input: {
  taskId: string;
  organizationId: string;
  contextType: "knowledge" | "business_data";
}): Promise<WealthContextPlanResolution> {
  const flag = resolutionFlag(input.contextType);
  if (!enabled(flag)) return { mode: "legacy", plan: null };
  return {
    mode: "binding",
    plan: await concretePlan({
      taskId: input.taskId,
      organizationId: input.organizationId,
      stage: "production",
      contextType: input.contextType,
    }),
  };
}

export function resolvedContextBinding(
  plan: ConcreteContextPlanV1 | null,
  logicalAssetId: string,
): ContextSourceBindingV1 | null {
  const resolution = plan?.resolutions.find((item) => item.need.logicalAssetId === logicalAssetId);
  return resolution?.status === "resolved" ? resolution.binding : null;
}

export function wealthKnowledgeSourceFromPlan(
  resolution: WealthContextPlanResolution | undefined,
  logicalAssetId: string,
): WealthKnowledgeSourceResolution {
  if (!resolution || resolution.mode === "legacy") return { mode: "legacy", binding: null, plan: null };
  return {
    mode: "binding",
    binding: resolvedContextBinding(resolution.plan, logicalAssetId),
    plan: resolution.plan,
  };
}

export async function resolveWealthKnowledgeSource(input: {
  taskId: string;
  logicalAssetId: string;
  principal: RuntimePrincipalV2;
}): Promise<WealthKnowledgeSourceResolution> {
  const resolved = await resolveWealthContextPlan({
    taskId: input.taskId,
    organizationId: input.principal.organizationId,
    contextType: "knowledge",
  });
  if (resolved.mode === "legacy") return { mode: "legacy", binding: null, plan: null };
  return {
    mode: "binding",
    binding: resolvedContextBinding(resolved.plan, input.logicalAssetId),
    plan: resolved.plan,
  };
}

export async function observeWealthContextResolutionShadow(input: {
  taskId: string;
  principal: Pick<RuntimePrincipalV2, "organizationId" | "adoptionId" | "agentId">;
  observed: Array<{ logicalAssetId: string; providerType: "llamaindex" | "mcp" | "api"; resourceRef: string }>;
}): Promise<void> {
  if (!enabled("EA_CONTEXT_RESOLUTION_SHADOW_ENABLED")) return;
  const startedAt = Date.now();
  try {
    const plan = await concretePlan({
      taskId: input.taskId,
      organizationId: input.principal.organizationId,
      stage: "shadow",
    });
    if (!plan) return;
    const comparisons = plan.resolutions.map((resolution) => {
      const actual = input.observed.find((item) => item.logicalAssetId === resolution.need.logicalAssetId);
      const expected = resolution.binding;
      const sourceMatch = actual && expected
        ? actual.providerType === expected.providerType && actual.resourceRef === expected.resourceRef
        : !actual && !expected;
      return {
        logicalAssetId: resolution.need.logicalAssetId,
        requiredness: resolution.need.requiredness,
        resolutionStatus: resolution.status,
        observed: Boolean(actual),
        sourceMatch,
      };
    });
    appendLogAsync("context-resolution-shadow.log", {
      ts: new Date().toISOString(),
      event: "context_resolution.shadow_compared",
      taskId: input.taskId,
      adoptId: input.principal.adoptionId,
      agentId: input.principal.agentId,
      planStatus: plan.status,
      resolutionFingerprint: plan.resolutionFingerprint,
      comparisons,
      durationMs: Date.now() - startedAt,
    });
    observeContextResolutionShadow({
      taskId: input.taskId,
      outcome: "success",
      durationMs: Date.now() - startedAt,
      comparisons,
    });
  } catch (error) {
    appendLogAsync("context-resolution-shadow.log", {
      ts: new Date().toISOString(),
      event: "context_resolution.shadow_failed",
      taskId: input.taskId,
      adoptId: input.principal.adoptionId,
      agentId: input.principal.agentId,
      error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      durationMs: Date.now() - startedAt,
    });
    observeContextResolutionShadow({
      taskId: input.taskId,
      outcome: "error",
      durationMs: Date.now() - startedAt,
    });
  }
}
