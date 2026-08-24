import type {
  ContextResolutionEvidenceV1,
  ContextSourceBindingV1,
} from "../../../shared/context-resolution";
import type { MemoryRetrievalScopeV1 } from "../../../shared/memory-purpose";
import { buildPurposeScopedRelevantAgentMemoryContext } from "../agent-memory-retrieval";
import { buildContextReceipt } from "../governance/context-receipt";
import { governanceFingerprint, principalFingerprint, type RuntimePrincipalV2 } from "../governance/contracts";
import { resolveContextSources } from "./source-resolver";

export async function retrieveGovernedRelationshipMemory(input: {
  principal: RuntimePrincipalV2;
  rolePackId: string;
  taskId: string;
  binding: ContextSourceBindingV1;
  adoptionRecordId: number;
  purposeId: string;
  purpose: string;
  query: string;
  subjectId?: string;
}) {
  const purposeId = String(input.purposeId || "").trim();
  const purpose = String(input.purpose || "").trim();
  if (!purposeId || !purpose) throw new Error("RELATIONSHIP_MEMORY_PURPOSE_REQUIRED");
  const plan = {
    schema: "ea.context-need-plan.v1" as const,
    planId: `${input.rolePackId}.${input.taskId}.relationship-memory`,
    planVersion: "1.0.0",
    rolePackId: input.rolePackId,
    roleTemplate: input.principal.roleTemplate,
    taskId: input.taskId,
    needs: [{
      needId: "relationship-memory",
      logicalAssetId: "customer_relationship_memory",
      contextType: "memory" as const,
      requiredness: "optional" as const,
      purpose,
      freshness: { mode: "latest" as const, maxAgeSeconds: 2_592_000 },
      requiredCapabilities: ["relevant_retrieval", "purpose_filter"],
    }],
  };
  const resolved = resolveContextSources({
    plan,
    bindings: [input.binding],
    organizationId: input.principal.organizationId,
    stage: input.binding.stage,
  });
  if (resolved.resolutions[0]?.status !== "resolved") {
    throw new Error(`RELATIONSHIP_MEMORY_PROVIDER_CONTRACT_MISMATCH:${resolved.resolutions[0]?.reasonCode || "UNKNOWN"}`);
  }

  const retrievalScope: MemoryRetrievalScopeV1 = {
    organizationId: input.principal.organizationId,
    userId: input.principal.userId,
    adoptionId: input.principal.adoptionId,
    roleTemplate: input.principal.roleTemplate,
    rolePackId: input.rolePackId,
    purposeId,
    requestedPurpose: purpose,
    ...(input.subjectId ? { subjectId: input.subjectId } : {}),
  };
  const retrieval = await buildPurposeScopedRelevantAgentMemoryContext({
    adoptionId: input.adoptionRecordId,
    query: input.query,
    scope: retrievalScope,
  });
  const resolution: ContextResolutionEvidenceV1 = {
    schema: "ea.context-resolution-evidence.v1",
    planId: resolved.planId,
    planVersion: resolved.planVersion,
    taskId: resolved.taskId,
    status: resolved.status,
    needs: resolved.resolutions.map(item => ({
      logicalAssetId: item.need.logicalAssetId,
      contextType: item.need.contextType,
      requiredness: item.need.requiredness,
      resolutionStatus: item.status,
      ...(item.reasonCode ? { reasonCode: item.reasonCode } : {}),
      ...(item.binding ? {
        bindingId: item.binding.bindingId,
        bindingScope: item.binding.bindingScope,
        bindingVersion: item.binding.bindingVersion,
        providerType: item.binding.providerType,
        resourceRefFingerprint: governanceFingerprint(item.binding.resourceRef),
        rolePackId: input.rolePackId,
        purpose,
        purposeFilter: retrieval.purposeFilter,
      } : {}),
    })),
    bindingSnapshotFingerprint: resolved.bindingSnapshotFingerprint,
    resolutionFingerprint: resolved.resolutionFingerprint,
  };
  const readiness = retrieval.selectedRefs.length ? "READY" as const : "DEGRADED" as const;
  const receipt = buildContextReceipt({
    taskId: input.taskId,
    taskLabel: "读取已确认客户关系记忆",
    principalFingerprint: principalFingerprint(input.principal),
    resolution,
    provided: {
      knowledge: [],
      businessData: [],
      memory: retrieval.selectedRefs.map(item => ({
        memoryId: String(item.memoryId),
        kind: item.kind,
        version: item.version,
        contentHash: item.contentHash,
        sourceType: item.sourceType,
        asOf: item.asOf,
        usageType: item.usageType,
        assurance: "REFERENCE_ONLY",
        purposeId,
        ...(item.visibilityClass ? { visibilityClass: item.visibilityClass } : {}),
        ...(item.subjectId ? { subjectId: item.subjectId } : {}),
      })),
      capabilities: [],
    },
    excluded: retrieval.purposeFilter.filteredRecordCount ? [{
      category: "memory",
      reasonCode: "PURPOSE_SCOPE_FILTERED",
      count: retrieval.purposeFilter.filteredRecordCount,
      message: "未提供不属于当前组织、主体、岗位或 Purpose 范围的记忆。",
      disclosure: "aggregate_only",
    }] : [],
    readiness: {
      status: readiness,
      requestedOutcome: "retrieve_confirmed_relationship_memory",
      allowedOutcomes: retrieval.selectedRefs.length ? ["use_confirmed_memory_as_reference"] : ["continue_without_memory"],
      deniedOutcomes: ["infer_unconfirmed_relationship_fact"],
      reasons: retrieval.selectedRefs.length ? [] : ["当前 Purpose 范围没有匹配的已确认关系记忆。"],
      remediation: [],
      decisionFingerprint: governanceFingerprint({
        purposeId,
        selectedIds: retrieval.selectedIds,
        filterFingerprint: retrieval.purposeFilter.filterFingerprint,
      }),
    },
  });
  return { ...retrieval, resolution, receipt };
}
