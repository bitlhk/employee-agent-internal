import { randomUUID } from "node:crypto";
import type { ContextResolutionEvidenceV1 } from "../../../shared/context-resolution";
import type { EffectiveContextSnapshotV1 } from "../../../shared/context-receipt";
import type { RuntimePrincipalV2 } from "./contracts";
import { governanceFingerprint, principalFingerprint } from "./contracts";

export type TaskReadinessStatus = "READY" | "DEGRADED" | "BLOCKED";
export type ReadinessCheckStatus = TaskReadinessStatus | "NOT_REQUIRED";

export type ReadinessCheck = {
  status: ReadinessCheckStatus;
  code: string;
  message: string;
  retryable?: boolean;
  asOf?: string;
};

export type TaskReadinessDecision = {
  taskId: string;
  status: TaskReadinessStatus;
  requestedOutcome: string;
  checks: Record<string, ReadinessCheck>;
  allowedOutcomes: string[];
  deniedOutcomes: string[];
  fallbackOutcomes: string[];
  reasons: string[];
  remediation: string[];
  decisionFingerprint: string;
};

export type TaskContextPack = {
  resolution?: ContextResolutionEvidenceV1;
  knowledge: {
    selectedAssets: Array<{
      assetId: string;
      version: string;
      contentHash: string;
      effectiveAt?: string | null;
      logicalAssetId?: string;
      bindingId?: string;
      providerType?: "llamaindex" | "mcp" | "api";
      resourceRefFingerprint?: string;
    }>;
    eligibilityFingerprint: string;
  };
  businessData: {
    sources: Array<{
      sourceSystem: string;
      entityRef: string;
      asOf: string;
      resultFingerprint: string;
      logicalAssetId?: string;
      bindingId?: string;
      providerType?: "llamaindex" | "mcp" | "api";
      resourceRefFingerprint?: string;
    }>;
  };
  memory: {
    memoryRefs: string[];
    taskStateVersion?: string;
  };
  principalFingerprint: string;
  effectiveContextSnapshot: EffectiveContextSnapshotV1;
  contextEvidenceFingerprint: string;
  assembledAt: string;
};

export type CapabilitySnapshot = {
  capabilityIds: string[];
  capabilityVersions: Record<string, string>;
  sideEffectProfiles: Record<string, string>;
  policyBindings: Record<string, string[]>;
  snapshotFingerprint: string;
  createdAt: string;
};

export type ReleaseEvidenceRef = {
  rolePackReleaseId: string;
  evalSuiteVersion: string;
  verificationStatus: "verified" | "stale" | "unverified";
  verificationLevel?: "contract" | "controlled_scenario" | "model_scenario";
  lastPassedAt?: string;
  assetSetFingerprint: string;
};

export type TaskExecutionEnvelope = {
  schema: "ea.task-execution-envelope.v1";
  envelopeId: string;
  principal: RuntimePrincipalV2;
  context: TaskContextPack;
  readiness: TaskReadinessDecision;
  capabilitySnapshot: CapabilitySnapshot;
  releaseEvidence: ReleaseEvidenceRef;
  correlationId: string;
  createdAt: string;
  envelopeFingerprint: string;
};

export function buildTaskContextPack(input: Omit<TaskContextPack, "contextEvidenceFingerprint" | "effectiveContextSnapshot"> & {
  effectiveContextSnapshot?: EffectiveContextSnapshotV1;
}): TaskContextPack {
  const snapshot = input.effectiveContextSnapshot || effectiveContextSnapshot({
    knowledge: input.knowledge.selectedAssets,
    businessData: input.businessData.sources,
    memory: input.memory.memoryRefs.map((memoryId) => ({ memoryId })),
    capturedAt: input.assembledAt,
  });
  return {
    ...input,
    effectiveContextSnapshot: snapshot,
    contextEvidenceFingerprint: governanceFingerprint({ ...input, effectiveContextSnapshot: snapshot }),
  };
}

export function effectiveContextSnapshot(input: {
  knowledge: TaskContextPack["knowledge"]["selectedAssets"];
  businessData: TaskContextPack["businessData"]["sources"];
  memory?: Array<{ memoryId: string; version?: number; asOf?: string }>;
  capturedAt: string;
}): EffectiveContextSnapshotV1 {
  const items: EffectiveContextSnapshotV1["items"] = [
    ...input.knowledge.map((item) => ({
      contextType: "knowledge" as const,
      ...(item.logicalAssetId ? { logicalAssetId: item.logicalAssetId } : {}),
      assetId: item.assetId,
      version: item.version,
      ...(item.effectiveAt !== undefined ? { effectiveAt: item.effectiveAt } : {}),
    })),
    ...input.businessData.map((item) => ({
      contextType: "business_data" as const,
      ...(item.logicalAssetId ? { logicalAssetId: item.logicalAssetId } : {}),
      assetId: `${item.sourceSystem}:${item.entityRef}`,
      version: item.asOf,
      asOf: item.asOf,
    })),
    ...(input.memory || []).map((item) => ({
      contextType: "memory" as const,
      assetId: String(item.memoryId),
      version: item.version ? String(item.version) : "referenced",
      ...(item.asOf ? { asOf: item.asOf } : {}),
    })),
  ].sort((left, right) => {
    const leftLogicalAsset = "logicalAssetId" in left ? left.logicalAssetId || "" : "";
    const rightLogicalAsset = "logicalAssetId" in right ? right.logicalAssetId || "" : "";
    return `${left.contextType}:${leftLogicalAsset}:${left.assetId}`
      .localeCompare(`${right.contextType}:${rightLogicalAsset}:${right.assetId}`);
  });
  const body = { capturedAt: input.capturedAt, items };
  return { ...body, snapshotFingerprint: governanceFingerprint(body) };
}

export function buildCapabilitySnapshot(
  input: Omit<CapabilitySnapshot, "snapshotFingerprint" | "createdAt"> & { createdAt?: string },
): CapabilitySnapshot {
  const createdAt = input.createdAt || new Date().toISOString();
  const value = {
    capabilityIds: Array.from(new Set(input.capabilityIds)).sort(),
    capabilityVersions: input.capabilityVersions,
    sideEffectProfiles: input.sideEffectProfiles,
    policyBindings: input.policyBindings,
    createdAt,
  };
  return { ...value, snapshotFingerprint: governanceFingerprint(value) };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

export function buildTaskExecutionEnvelope(input: {
  principal: RuntimePrincipalV2;
  context: TaskContextPack;
  readiness: TaskReadinessDecision;
  capabilitySnapshot: CapabilitySnapshot;
  releaseEvidence: ReleaseEvidenceRef;
  correlationId?: string;
  now?: Date;
}): Readonly<TaskExecutionEnvelope> {
  if (!input.principal.authorizationSnapshotId || !input.principal.authorizationFingerprint) {
    throw new Error("Task execution requires a durable Runtime Principal V2 authorization snapshot");
  }
  const expectedPrincipalFingerprint = principalFingerprint(input.principal);
  if (input.context.principalFingerprint !== expectedPrincipalFingerprint) {
    throw new Error("Task context principal binding does not match the execution principal");
  }
  const createdAt = (input.now || new Date()).toISOString();
  const envelopeId = `tenv_${randomUUID()}`;
  const correlationId = String(input.correlationId || `corr_${randomUUID()}`).trim();
  const body = {
    schema: "ea.task-execution-envelope.v1" as const,
    envelopeId,
    principal: input.principal,
    context: input.context,
    readiness: input.readiness,
    capabilitySnapshot: input.capabilitySnapshot,
    releaseEvidence: input.releaseEvidence,
    correlationId,
    createdAt,
  };
  return deepFreeze({ ...body, envelopeFingerprint: governanceFingerprint(body) });
}
