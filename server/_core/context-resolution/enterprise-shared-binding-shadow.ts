import { createHash } from "node:crypto";
import type { ContextNeedPlanV1, ContextSourceBindingV1 } from "../../../shared/context-resolution";
import { resolveContextSources } from "./source-resolver";

export const ENTERPRISE_SHARED_SHADOW_CONTEXTS = [
  "customer_profile",
  "customer_relationship_memory",
  "governed_work_state",
] as const;

type SharedLogicalContextId = typeof ENTERPRISE_SHARED_SHADOW_CONTEXTS[number];

export type SharedBindingEligibilityEvidenceV1 = {
  logicalAssetId: SharedLogicalContextId;
  eligibilityScopeFingerprint: string;
  providedItemFingerprints: string[];
  deniedItemFingerprints: string[];
};

export type SharedBindingShadowConsumerV1 = {
  plan: ContextNeedPlanV1;
  principalFingerprint: string;
  eligibility: SharedBindingEligibilityEvidenceV1[];
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function percentile95(values: number[]): number {
  if (!values.length) return 0;
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
}

export function verifyEnterpriseSharedBindingShadow(input: {
  organizationId: string;
  bindings: ContextSourceBindingV1[];
  consumers: SharedBindingShadowConsumerV1[];
}) {
  const errors: string[] = [];
  const latencies: number[] = [];
  const principalFingerprints = new Set(input.consumers.map(item => item.principalFingerprint));
  if (input.consumers.length < 2) errors.push("Shared Binding Shadow requires at least two Role Pack consumers");
  if (principalFingerprints.size !== input.consumers.length) errors.push("Each Role Pack consumer requires a distinct Principal fingerprint");

  const consumers = input.consumers.map(consumer => {
    const needs = consumer.plan.needs.filter(need => (
      ENTERPRISE_SHARED_SHADOW_CONTEXTS.includes(need.logicalAssetId as SharedLogicalContextId)
    ));
    const missingNeeds = ENTERPRISE_SHARED_SHADOW_CONTEXTS.filter(logicalAssetId => (
      !needs.some(need => need.logicalAssetId === logicalAssetId)
    ));
    if (missingNeeds.length) errors.push(`${consumer.plan.rolePackId}: missing shared Context Need ${missingNeeds.join(", ")}`);
    const plan = { ...consumer.plan, needs };
    const startedAt = performance.now();
    const resolved = resolveContextSources({
      plan,
      bindings: input.bindings,
      organizationId: input.organizationId,
      stage: "shadow",
    });
    latencies.push(performance.now() - startedAt);
    const eligibility = new Map(consumer.eligibility.map(item => [item.logicalAssetId, item]));
    const resolutions = resolved.resolutions.map(resolution => {
      const evidence = eligibility.get(resolution.need.logicalAssetId as SharedLogicalContextId);
      if (!resolution.need.purpose.trim()) errors.push(`${consumer.plan.rolePackId}/${resolution.need.logicalAssetId}: Purpose is required`);
      if (!resolution.binding || resolution.status !== "resolved") {
        errors.push(`${consumer.plan.rolePackId}/${resolution.need.logicalAssetId}: shared Binding did not resolve`);
      } else if ((resolution.binding.bindingScope || "role_pack") !== "enterprise_shared") {
        errors.push(`${consumer.plan.rolePackId}/${resolution.need.logicalAssetId}: resolved Binding is not enterprise_shared`);
      }
      if (!evidence?.eligibilityScopeFingerprint) {
        errors.push(`${consumer.plan.rolePackId}/${resolution.need.logicalAssetId}: Eligibility scope fingerprint is missing`);
      }
      const leaked = evidence
        ? evidence.providedItemFingerprints.filter(item => evidence.deniedItemFingerprints.includes(item))
        : [];
      if (leaked.length) errors.push(`${consumer.plan.rolePackId}/${resolution.need.logicalAssetId}: denied Context was provided`);
      return {
        logicalAssetId: resolution.need.logicalAssetId,
        purpose: resolution.need.purpose,
        status: resolution.status,
        reasonCode: resolution.reasonCode,
        bindingId: resolution.binding?.bindingId,
        bindingScope: resolution.binding?.bindingScope,
        providerType: resolution.binding?.providerType,
        resourceRefFingerprint: resolution.binding ? sha256(resolution.binding.resourceRef) : undefined,
        principalFingerprint: consumer.principalFingerprint,
        eligibilityScopeFingerprint: evidence?.eligibilityScopeFingerprint,
        providedItemCount: evidence?.providedItemFingerprints.length || 0,
      };
    });
    return { rolePackId: consumer.plan.rolePackId, status: resolved.status, resolutions };
  });

  const identity = ENTERPRISE_SHARED_SHADOW_CONTEXTS.map(logicalAssetId => {
    const rows = consumers.flatMap(consumer => (
      consumer.resolutions.filter(item => item.logicalAssetId === logicalAssetId)
    ));
    const signatures = new Set(rows.map(row => [
      row.bindingId,
      row.bindingScope,
      row.providerType,
      row.resourceRefFingerprint,
    ].join("|")));
    const matched = rows.length === input.consumers.length
      && signatures.size === 1
      && rows.every(row => row.bindingId && row.bindingScope === "enterprise_shared");
    if (!matched) errors.push(`${logicalAssetId}: Shared Binding identity mismatch`);
    return { logicalAssetId, matched, bindingId: matched ? rows[0].bindingId : undefined };
  });
  const identityCount = identity.filter(item => item.matched).length;
  const body = {
    schema: "ea.enterprise-shared-binding-shadow-report.v1" as const,
    organizationId: input.organizationId,
    stage: "shadow" as const,
    status: errors.length ? "FAIL" as const : "PASS" as const,
    sharedBindingIdentityCount: identityCount,
    expectedSharedBindingIdentityCount: ENTERPRISE_SHARED_SHADOW_CONTEXTS.length,
    sharedBindingIdentityRate: identityCount / ENTERPRISE_SHARED_SHADOW_CONTEXTS.length,
    eligibilityViolationCount: errors.filter(error => error.includes("denied Context")).length,
    resolverP95Ms: Number(percentile95(latencies).toFixed(3)),
    identity,
    consumers,
    errors,
  };
  return { ...body, reportFingerprint: sha256(JSON.stringify(body)) };
}
