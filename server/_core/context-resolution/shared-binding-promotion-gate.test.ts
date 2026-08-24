import { describe, expect, it } from "vitest";
import {
  assertSharedBindingPromotionGate,
  type SharedBindingPromotionValidationV1,
} from "./shared-binding-promotion-gate";
import { sharedBindingCandidateFingerprint } from "./shared-binding-validation-snapshot";
import type { ContextSourceBindingV1 } from "../../../shared/context-resolution";

const snapshotFingerprint = "s".repeat(64);
const bindings: ContextSourceBindingV1[] = [
  ["ctxb-profile", "customer_profile", "business_data", "mcp"],
  ["ctxb-memory", "customer_relationship_memory", "memory", "api"],
  ["ctxb-work", "governed_work_state", "memory", "api"],
].map(([bindingId, logicalAssetId, contextType, providerType]) => ({
  schema: "ea.context-source-binding.v1",
  bindingId,
  organizationId: "org-a",
  rolePackId: "*",
  bindingScope: "enterprise_shared",
  logicalAssetId,
  contextType: contextType as ContextSourceBindingV1["contextType"],
  providerType: providerType as ContextSourceBindingV1["providerType"],
  resourceRef: `${providerType}://shared/${logicalAssetId}`,
  capabilities: ["read"],
  bindingVersion: "shadow-v1",
  stage: "shadow",
  status: "active",
}));
const bindingIds = bindings.map(binding => binding.bindingId);
const providedCandidateFingerprints = () => Object.fromEntries(
  bindings.map(binding => [binding.bindingId, sharedBindingCandidateFingerprint(binding)]),
);

function evidence(overrides: Partial<SharedBindingPromotionValidationV1> = {}): SharedBindingPromotionValidationV1 {
  return {
    schema: "ea.shared-binding-promotion-validation.v1",
    validationSnapshotFingerprint: snapshotFingerprint,
    expectedBindingIds: bindingIds,
    sharedBindingIdentityCount: 3,
    expectedSharedBindingIdentityCount: 3,
    purposeIsolationPassed: true,
    eligibilityViolationCount: 0,
    roleValidations: [
      { rolePackId: "linggan-bank.wealth-manager", verifiedReleaseId: "wm-release", goldenTaskPassed: true, validationSnapshotFingerprint: snapshotFingerprint, goldenTaskReportFingerprint: "w".repeat(64), providedCandidateFingerprints: providedCandidateFingerprints() },
      { rolePackId: "linggan-insurance.insurance-advisor", verifiedReleaseId: "ia-release", goldenTaskPassed: true, validationSnapshotFingerprint: snapshotFingerprint, goldenTaskReportFingerprint: "i".repeat(64), providedCandidateFingerprints: providedCandidateFingerprints() },
    ],
    ...overrides,
  };
}

describe("shared Binding promotion gate", () => {
  it("requires both roles, 3/3 identity, actual Provided evidence, and isolation", () => {
    expect(assertSharedBindingPromotionGate(evidence(), bindings).validationFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(() => assertSharedBindingPromotionGate(undefined, bindings)).toThrow("SHARED_BINDING_MULTI_ROLE_GATE_REQUIRED");
    expect(() => assertSharedBindingPromotionGate(evidence({ purposeIsolationPassed: false }), bindings))
      .toThrow("SHARED_BINDING_ELIGIBILITY_ISOLATION_FAILED");
    expect(() => assertSharedBindingPromotionGate(evidence({ sharedBindingIdentityCount: 2 }), bindings))
      .toThrow("SHARED_BINDING_IDENTITY_GATE_FAILED");
  });

  it("rejects a role that passed without actually receiving every candidate Binding", () => {
    const invalid = evidence();
    delete invalid.roleValidations[1].providedCandidateFingerprints[bindingIds[2]];
    expect(() => assertSharedBindingPromotionGate(invalid, bindings))
      .toThrow("SHARED_BINDING_CANDIDATE_NOT_PROVIDED");
  });

  it("rejects Golden Task evidence produced against another snapshot", () => {
    const invalid = evidence();
    invalid.roleValidations[1].validationSnapshotFingerprint = "x".repeat(64);
    expect(() => assertSharedBindingPromotionGate(invalid, bindings))
      .toThrow("SHARED_BINDING_SNAPSHOT_INTEGRITY_FAILED");
  });
});
