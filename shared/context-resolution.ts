export const CONTEXT_NEED_PLAN_SCHEMA = "ea.context-need-plan.v1" as const;
export const CONTEXT_SOURCE_BINDING_SCHEMA = "ea.context-source-binding.v1" as const;
export const CONTEXT_ITEM_SCHEMA = "ea.context-item.v1" as const;

export type ContextTypeV1 = "knowledge" | "business_data" | "memory";
export type ContextRequirednessV1 = "required" | "optional";
export type ContextProviderTypeV1 = "llamaindex" | "mcp" | "api";
export type ContextBindingStageV1 = "production" | "shadow";
export type ContextBindingScopeV1 = "role_pack" | "enterprise_shared";
export type ContextResolutionReasonCodeV1 =
  | "NO_BINDING"
  | "NO_SHARED_BINDING"
  | "BINDING_DISABLED"
  | "CAPABILITY_MISMATCH"
  | "AMBIGUOUS_BINDING"
  | "EXACT_BINDING_DISABLED"
  | "EXACT_BINDING_CAPABILITY_MISMATCH"
  | "AMBIGUOUS_SHARED_BINDING"
  | "NOT_ELIGIBLE"
  | "SOURCE_UNAVAILABLE"
  | "NO_USABLE_CONTEXT"
  | "STALE_ASSET";

export type ContextFreshnessV1 =
  | { mode: "realtime"; maxAgeSeconds: number }
  | { mode: "current_effective" }
  | { mode: "latest"; maxAgeSeconds?: number }
  | { mode: "version_controlled" };

export type ContextNeedV1 = {
  needId: string;
  logicalAssetId: string;
  contextType: ContextTypeV1;
  requiredness: ContextRequirednessV1;
  purpose: string;
  freshness: ContextFreshnessV1;
  authority?: "official" | "approved" | "reference";
  requiredCapabilities?: string[];
};

export type ContextNeedPlanV1 = {
  schema: typeof CONTEXT_NEED_PLAN_SCHEMA;
  planId: string;
  planVersion: string;
  rolePackId: string;
  roleTemplate: string;
  taskId: string;
  needs: ContextNeedV1[];
};

// Bindings are routing records. Asset ownership, classification, lifecycle,
// version and health remain authoritative in their existing registries.
export type ContextSourceBindingV1 = {
  schema: typeof CONTEXT_SOURCE_BINDING_SCHEMA;
  bindingId: string;
  organizationId: string;
  rolePackId: string;
  bindingScope: ContextBindingScopeV1;
  logicalAssetId: string;
  contextType: ContextTypeV1;
  providerType: ContextProviderTypeV1;
  resourceRef: string;
  capabilities: string[];
  bindingVersion: string;
  stage: ContextBindingStageV1;
  status: "active" | "disabled";
  verifiedReleaseId?: string;
};

export type ContextItemV1 = {
  schema: typeof CONTEXT_ITEM_SCHEMA;
  needId: string;
  logicalAssetId: string;
  contextType: ContextTypeV1;
  bindingId: string;
  providerType: ContextProviderTypeV1;
  assetId: string;
  assetVersion: string;
  contentHash: string;
  content?: string;
  asOf: string;
  provenance: {
    sourceDepartment?: string;
    authority?: string;
    effectiveAt?: string | null;
  };
  citation?: {
    documentId: string;
    page?: number | null;
    position?: string;
  };
  retrieval: {
    retrievedAt: string;
    score?: number;
  };
};

export type ResolvedContextNeedV1 = {
  need: ContextNeedV1;
  binding: ContextSourceBindingV1 | null;
  status: "resolved" | "missing" | "ambiguous";
  reasonCode?: ContextResolutionReasonCodeV1;
  reason?: string;
};

export type ConcreteContextPlanV1 = {
  schema: "ea.concrete-context-plan.v1";
  planId: string;
  planVersion: string;
  taskId: string;
  rolePackId: string;
  organizationId: string;
  stage: ContextBindingStageV1;
  status: "READY" | "DEGRADED" | "BLOCKED";
  resolutions: ResolvedContextNeedV1[];
  bindingSnapshotFingerprint: string;
  resolutionFingerprint: string;
};

export type ContextResolutionEvidenceV1 = {
  schema: "ea.context-resolution-evidence.v1";
  planId: string;
  planVersion: string;
  taskId: string;
  status: "READY" | "DEGRADED" | "BLOCKED";
  needs: Array<{
    logicalAssetId: string;
    contextType: ContextTypeV1;
    requiredness: ContextRequirednessV1;
    resolutionStatus: "resolved" | "missing" | "ambiguous";
    reasonCode?: ContextResolutionReasonCodeV1;
    bindingId?: string;
    bindingScope?: ContextBindingScopeV1;
    bindingVersion?: string;
    providerType?: ContextProviderTypeV1;
    resourceRefFingerprint?: string;
    rolePackId?: string;
    purpose?: string;
    eligibilityScopeFingerprint?: string;
    purposeFilter?: import("./memory-purpose").MemoryPurposeFilterEvidenceV1;
  }>;
  bindingSnapshotFingerprint: string;
  resolutionFingerprint: string;
};
