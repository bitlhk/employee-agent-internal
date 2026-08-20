import type { ContextResolutionEvidenceV1 } from "./context-resolution";

export const CONTEXT_RECEIPT_SCHEMA = "ea.context-receipt.v1" as const;

export type ContextReceiptReadiness = {
  status: "READY" | "DEGRADED" | "BLOCKED";
  requestedOutcome: string;
  allowedOutcomes: string[];
  deniedOutcomes: string[];
  reasons: string[];
  remediation: string[];
  presentation: {
    completed: string[];
    unavailable: string[];
    nextSteps: string[];
  };
  decisionFingerprint: string;
};

export type EffectiveContextSnapshotV1 = {
  capturedAt: string;
  items: Array<{
    contextType: "knowledge" | "business_data" | "memory";
    logicalAssetId?: string;
    assetId: string;
    version: string;
    asOf?: string;
    effectiveAt?: string | null;
  }>;
  snapshotFingerprint: string;
};

export type ContextReceiptV1 = {
  schema: typeof CONTEXT_RECEIPT_SCHEMA;
  receiptId: string;
  taskId: string;
  taskLabel: string;
  envelopeId?: string;
  correlationId?: string;
  principalFingerprint: string;
  resolution?: ContextResolutionEvidenceV1;
  effectiveContextSnapshot: EffectiveContextSnapshotV1;
  provided: {
    knowledge: Array<{
      assetId: string;
      label: string;
      version: string;
      contentHash: string;
      effectiveAt?: string | null;
      logicalAssetId?: string;
      bindingId?: string;
      providerType?: "llamaindex" | "mcp" | "api";
      resourceRefFingerprint?: string;
    }>;
    businessData: Array<{
      sourceSystem: string;
      label: string;
      entityRef: string;
      asOf: string;
      resultFingerprint: string;
      logicalAssetId?: string;
      bindingId?: string;
      providerType?: "llamaindex" | "mcp" | "api";
      resourceRefFingerprint?: string;
    }>;
    memory: Array<{
      memoryId: string;
      kind?: string;
      version: number;
      contentHash: string;
      sourceType?: string;
      asOf?: string;
      usageType: "preference" | "relationship_observation" | "procedure" | "inference";
      assurance: "REFERENCE_ONLY";
    }>;
    capabilities: Array<{
      capabilityId: string;
      label: string;
      version: string;
      sideEffect: string;
    }>;
  };
  cited: {
    knowledgeAssetIds: string[];
  };
  applied: {
    policyDecisions: Array<{
      decisionId?: string;
      policyCode: string;
      ruleVersion: string;
      effect: "ALLOW" | "DENY" | "REQUIRE_APPROVAL";
    }>;
    capabilityExecutions: Array<{
      capabilityId: string;
      label: string;
      operation: string;
      status: "planned" | "approval_required" | "completed" | "blocked" | "failed";
      requestId?: string;
      externalRequestId?: string;
      approvalId?: string;
      idempotencyProtected?: boolean;
    }>;
  };
  excluded: Array<{
    category: "knowledge" | "business_data" | "memory" | "capability" | "product";
    reasonCode: string;
    count: number;
    message: string;
    disclosure: "exact_count" | "aggregate_only" | "hidden";
  }>;
  readiness: ContextReceiptReadiness;
  createdAt: string;
  receiptFingerprint: string;
};

export function isContextReceiptV1(value: unknown): value is ContextReceiptV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<ContextReceiptV1>;
  return receipt.schema === CONTEXT_RECEIPT_SCHEMA
    && typeof receipt.receiptId === "string"
    && typeof receipt.taskId === "string"
    && typeof receipt.receiptFingerprint === "string"
    && Boolean(receipt.provided && receipt.applied && receipt.readiness);
}
