import { createHash } from "node:crypto";
import type { ContextSourceBindingV1 } from "../../../shared/context-resolution";
import { sharedBindingCandidateFingerprint } from "./shared-binding-validation-snapshot";

export type SharedBindingRoleValidationV1 = {
  rolePackId: string;
  verifiedReleaseId: string;
  goldenTaskPassed: boolean;
  validationSnapshotFingerprint: string;
  goldenTaskReportFingerprint: string;
  providedCandidateFingerprints: Record<string, string>;
};

export type SharedBindingPromotionValidationV1 = {
  schema: "ea.shared-binding-promotion-validation.v1";
  validationSnapshotFingerprint: string;
  expectedBindingIds: string[];
  sharedBindingIdentityCount: number;
  expectedSharedBindingIdentityCount: number;
  purposeIsolationPassed: boolean;
  eligibilityViolationCount: number;
  roleValidations: SharedBindingRoleValidationV1[];
};

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function assertSharedBindingPromotionGate(
  evidence: SharedBindingPromotionValidationV1 | undefined,
  shadowBindings: ContextSourceBindingV1[],
) {
  if (!evidence) throw new Error("SHARED_BINDING_MULTI_ROLE_GATE_REQUIRED");
  const shadowBindingIds = shadowBindings.map(binding => binding.bindingId);
  const expected = unique(evidence.expectedBindingIds);
  const actual = unique(shadowBindingIds);
  if (!actual.length || JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("SHARED_BINDING_CANDIDATE_SET_MISMATCH");
  }
  if (evidence.roleValidations.length < 2) throw new Error("SHARED_BINDING_AFFECTED_ROLES_INCOMPLETE");
  if (unique(evidence.roleValidations.map(item => item.rolePackId)).length !== evidence.roleValidations.length) {
    throw new Error("SHARED_BINDING_ROLE_VALIDATION_DUPLICATE");
  }
  if (
    evidence.expectedSharedBindingIdentityCount !== actual.length
    || evidence.sharedBindingIdentityCount !== evidence.expectedSharedBindingIdentityCount
  ) {
    throw new Error("SHARED_BINDING_IDENTITY_GATE_FAILED");
  }
  if (!evidence.purposeIsolationPassed || evidence.eligibilityViolationCount !== 0) {
    throw new Error("SHARED_BINDING_ELIGIBILITY_ISOLATION_FAILED");
  }
  for (const role of evidence.roleValidations) {
    if (!role.goldenTaskPassed || !role.verifiedReleaseId || !role.goldenTaskReportFingerprint) {
      throw new Error("SHARED_BINDING_ROLE_GOLDEN_TASK_FAILED");
    }
    if (role.validationSnapshotFingerprint !== evidence.validationSnapshotFingerprint) {
      throw new Error("SHARED_BINDING_SNAPSHOT_INTEGRITY_FAILED");
    }
    for (const binding of shadowBindings) {
      if (role.providedCandidateFingerprints[binding.bindingId] !== sharedBindingCandidateFingerprint(binding)) {
        throw new Error("SHARED_BINDING_CANDIDATE_NOT_PROVIDED");
      }
    }
  }
  const normalized = {
    ...evidence,
    expectedBindingIds: expected,
    roleValidations: [...evidence.roleValidations]
      .sort((left, right) => left.rolePackId.localeCompare(right.rolePackId)),
  };
  return {
    normalized,
    validationFingerprint: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
  };
}
