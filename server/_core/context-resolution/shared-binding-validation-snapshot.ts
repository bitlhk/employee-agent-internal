import { createHash } from "node:crypto";
import type { ContextSourceBindingV1 } from "../../../shared/context-resolution";

export const SHARED_BINDING_VALIDATION_SNAPSHOT_SCHEMA = "ea.shared-binding-validation-snapshot.v1" as const;

export type SharedBindingValidationSnapshotBodyV1 = {
  schema: typeof SHARED_BINDING_VALIDATION_SNAPSHOT_SCHEMA;
  organizationId: string;
  stage: "shadow";
  providerContractFingerprint: string;
  bindings: Array<Pick<ContextSourceBindingV1,
    | "bindingId"
    | "bindingScope"
    | "logicalAssetId"
    | "contextType"
    | "providerType"
    | "resourceRef"
    | "capabilities"
    | "bindingVersion"
    | "stage"
    | "status"
  >>;
  rolePackReleases: Array<{
    releaseId: string;
    rolePackId: string;
    verificationLevel: string;
    assetSetFingerprint: string;
    verifiedAt: string | null;
  }>;
  plans: Array<{
    rolePackId: string;
    planId: string;
    planVersion: string;
  }>;
};

export type SharedBindingValidationSnapshotV1 = SharedBindingValidationSnapshotBodyV1 & {
  snapshotFingerprint: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

export function sharedBindingCandidateFingerprint(
  binding: Pick<ContextSourceBindingV1,
    | "bindingId"
    | "bindingScope"
    | "logicalAssetId"
    | "contextType"
    | "providerType"
    | "resourceRef"
    | "capabilities"
    | "bindingVersion"
    | "stage"
    | "status"
  >,
): string {
  return sha256(JSON.stringify({
    bindingId: binding.bindingId,
    bindingScope: binding.bindingScope || "role_pack",
    logicalAssetId: binding.logicalAssetId,
    contextType: binding.contextType,
    providerType: binding.providerType,
    resourceRef: binding.resourceRef,
    capabilities: [...binding.capabilities].sort(),
    bindingVersion: binding.bindingVersion,
    stage: binding.stage,
    status: binding.status,
  }));
}

export function freezeSharedBindingValidationSnapshot(
  body: SharedBindingValidationSnapshotBodyV1,
): Readonly<SharedBindingValidationSnapshotV1> {
  const normalized: SharedBindingValidationSnapshotBodyV1 = {
    ...body,
    bindings: [...body.bindings]
      .map(binding => ({
        bindingId: binding.bindingId,
        bindingScope: binding.bindingScope || "role_pack",
        logicalAssetId: binding.logicalAssetId,
        contextType: binding.contextType,
        providerType: binding.providerType,
        resourceRef: binding.resourceRef,
        capabilities: [...binding.capabilities].sort(),
        bindingVersion: binding.bindingVersion,
        stage: binding.stage,
        status: binding.status,
      }))
      .sort((left, right) => left.bindingId.localeCompare(right.bindingId)),
    rolePackReleases: [...body.rolePackReleases]
      .sort((left, right) => left.rolePackId.localeCompare(right.rolePackId)),
    plans: [...body.plans]
      .sort((left, right) => left.rolePackId.localeCompare(right.rolePackId)),
  };
  return deepFreeze({ ...normalized, snapshotFingerprint: sha256(JSON.stringify(normalized)) });
}

export function assertSharedBindingValidationSnapshot(
  snapshot: SharedBindingValidationSnapshotV1,
  expectedFingerprint?: string,
): Readonly<SharedBindingValidationSnapshotV1> {
  const { snapshotFingerprint, ...body } = snapshot;
  const frozen = freezeSharedBindingValidationSnapshot(body);
  if (frozen.snapshotFingerprint !== snapshotFingerprint) {
    throw new Error("SHARED_BINDING_SNAPSHOT_FINGERPRINT_MISMATCH");
  }
  if (expectedFingerprint && snapshotFingerprint !== expectedFingerprint) {
    throw new Error("SHARED_BINDING_SNAPSHOT_NOT_FROZEN_BASELINE");
  }
  return frozen;
}
