import type { EnterpriseAssetCandidate } from "../../drizzle/schema";
import type { ContextReceiptV1 } from "../../shared/context-receipt";
import type { EnterpriseAssetMetadata } from "./enterprise-asset-onboarding";
import type { KnowledgeBaseRecord, KnowledgeDocumentRecord } from "../db";
import { governanceFingerprint } from "./governance/contracts";
import { buildContextReceipt } from "./governance/context-receipt";
import { buildKnowledgeEligibility } from "./knowledge-eligibility";
import { runWealthRolePackContractChecks } from "./reference-role-pack-contracts";
import { runWealthRolePackControlledScenarios } from "./wealth-role-pack-scenarios";
import { selectWealthPolicyDocument } from "./wealth-policy-selection";
import { prepareWealthAllocationContext } from "./wealth-allocation-context";
import { buildTaskContextPack, type TaskContextPack } from "./governance/task-execution-envelope";

const DEFAULT_POLICY_DOCUMENT = "15-财富产品适当性销售管理细则（V2.2现行）.md";

export type EnterpriseKnowledgeValidation = {
  schema: "ea.enterprise-knowledge-validation.v1";
  status: "PASS" | "FAIL";
  candidateId: string;
  documentId: string;
  checksum: string;
  evaluatedAsOf: string;
  selectedVersion: string | null;
  candidateAssetFingerprint: string;
  taskIds: string[];
  gateReceipts: ContextReceiptV1[];
  checks: Array<{ code: string; passed: boolean; message: string }>;
  verifiedAt: string;
  validationFingerprint: string;
};

export function enterpriseCandidateAssetFingerprint(input: {
  candidate: EnterpriseAssetCandidate;
  metadata: EnterpriseAssetMetadata;
  documentId: string;
}): string {
  return governanceFingerprint({
    candidateId: input.candidate.candidateId,
    enterpriseAssetId: input.candidate.enterpriseAssetId,
    sourceVersion: input.candidate.sourceVersion,
    checksum: input.candidate.checksum.toLowerCase(),
    documentId: input.documentId,
    logicalAssetIds: [...input.metadata.logicalAssetIds].sort(),
    relatedTasks: [...input.metadata.relatedTasks].sort(),
  });
}

export function validationProvidesCandidate(input: {
  validation: unknown;
  candidate: EnterpriseAssetCandidate;
  metadata: EnterpriseAssetMetadata;
  documentId: string;
}): boolean {
  if (!input.validation || typeof input.validation !== "object") return false;
  const validation = input.validation as Record<string, unknown>;
  const expectedFingerprint = enterpriseCandidateAssetFingerprint(input);
  if (validation.candidateAssetFingerprint !== expectedFingerprint) return false;
  const taskIds = Array.isArray(validation.taskIds) ? validation.taskIds.map(String) : [];
  const receipts = Array.isArray(validation.gateReceipts) ? validation.gateReceipts : [];
  if (!taskIds.length || receipts.length !== taskIds.length) return false;
  return taskIds.every(taskId => receipts.some(receiptValue => {
    if (!receiptValue || typeof receiptValue !== "object") return false;
    const receipt = receiptValue as ContextReceiptV1;
    return receipt.taskId === taskId && receipt.provided?.knowledge?.some(item => (
      item.assetId === input.documentId
      && item.contentHash === input.candidate.checksum.toLowerCase()
      && item.candidateAssetFingerprint === expectedFingerprint
    ));
  }));
}

export type EnterpriseKnowledgeGateReadiness =
  | "ready_to_stage"
  | "not_for_runtime"
  | "logical_context_mapping_required"
  | "golden_task_mapping_required";

export function enterpriseKnowledgeGateReadiness(
  metadata: Pick<EnterpriseAssetMetadata, "lifecycle" | "logicalAssetIds" | "relatedTasks">,
): EnterpriseKnowledgeGateReadiness {
  if (metadata.lifecycle !== "active") return "not_for_runtime";
  if (!metadata.logicalAssetIds.length) return "logical_context_mapping_required";
  if (!metadata.relatedTasks.length) return "golden_task_mapping_required";
  return "ready_to_stage";
}

export function rolePackReleaseCoversCandidate(
  releaseVerifiedAt: Date | null | undefined,
  candidateUpdatedAt: Date,
): boolean {
  return Boolean(releaseVerifiedAt && releaseVerifiedAt.getTime() >= candidateUpdatedAt.getTime());
}

async function runCandidateProvidedContextGate(input: {
  candidateDocument: KnowledgeDocumentRecord;
  selection: ReturnType<typeof selectWealthPolicyDocument>;
  eligibilityFingerprint: string;
  candidateAssetFingerprint: string;
  checksum: string;
  now: Date;
}) {
  const principalFingerprint = governanceFingerprint({
    roleTemplate: "wealth-manager",
    purpose: "candidate_release_gate",
  });
  const knowledgeAsset = {
    assetId: input.candidateDocument.publicId,
    version: input.candidateDocument.versionLabel,
    contentHash: input.checksum.toLowerCase(),
    candidateAssetFingerprint: input.candidateAssetFingerprint,
    effectiveAt: input.candidateDocument.effectiveAt,
    logicalAssetId: "current_wealth_policy",
    providerType: "llamaindex" as const,
  };
  const task02Result = await prepareWealthAllocationContext({
    principal: {
      userId: 0,
      adoptionId: "candidate-release-gate",
      agentId: "wealth-manager-candidate-gate",
      roleTemplate: "wealth-manager",
      workspaceId: "/controlled/candidate-release-gate",
      permissionProfile: "internal",
      sessionId: "candidate-release-gate",
    },
    request: {
      customerId: "C-CANDIDATE-GATE",
      amount: 500_000,
      horizonMonths: 12,
      channel: "branch",
      keyword: "",
      productType: "",
      maxProducts: 5,
    },
    dependencies: {
      loadCustomer: async () => ({ customer: {
        customerId: "C-CANDIDATE-GATE",
        name: "候选门禁客户",
        riskLevel: "C3",
        assessmentStatus: "valid",
        assessmentExpiresAt: "2099-12-31T23:59:59.000Z",
        dataAsOf: input.now.toISOString(),
      } }),
      searchProducts: async () => ({
        updatedAt: input.now.toISOString(),
        products: [{
          productId: "P-CANDIDATE-R2",
          name: "候选门禁稳健产品",
          riskLevel: "R2",
          status: "on_sale",
          channels: ["branch"],
          dataAsOf: input.now.toISOString(),
        }],
      }),
      resolvePolicySource: async () => ({
        ready: input.selection.selected?.publicId === input.candidateDocument.publicId,
        sourceAssetId: input.selection.selected?.publicId || "",
        versionLabel: input.selection.selected?.versionLabel || "",
        sourceLocator: "candidate-release-gate",
        eligibilityFingerprint: input.eligibilityFingerprint,
      }),
    },
    now: input.now,
  });
  const contextByTask: Record<"WM-GT-02" | "WM-GT-03", TaskContextPack> = {
    "WM-GT-02": buildTaskContextPack({
      knowledge: {
        selectedAssets: task02Result.policySource.sourceAssetId === input.candidateDocument.publicId ? [knowledgeAsset] : [],
        eligibilityFingerprint: input.eligibilityFingerprint,
      },
      businessData: {
        sources: [{
          sourceSystem: "candidate_gate_fixture",
          entityRef: task02Result.customer.customerId,
          asOf: task02Result.evidence.customerDataAsOf,
          resultFingerprint: governanceFingerprint(task02Result.customer),
          logicalAssetId: "customer_profile",
          providerType: "mcp",
        }],
      },
      memory: { memoryRefs: [] },
      principalFingerprint,
      assembledAt: input.now.toISOString(),
    }),
    "WM-GT-03": buildTaskContextPack({
      knowledge: {
        selectedAssets: input.selection.selected?.publicId === input.candidateDocument.publicId ? [knowledgeAsset] : [],
        eligibilityFingerprint: input.eligibilityFingerprint,
      },
      businessData: { sources: [] },
      memory: { memoryRefs: [] },
      principalFingerprint,
      assembledAt: input.now.toISOString(),
    }),
  };
  const taskIds = Object.keys(contextByTask) as Array<keyof typeof contextByTask>;
  const receipts = taskIds.map(taskId => {
    const context = contextByTask[taskId];
    const providedCandidate = context.knowledge.selectedAssets.some(item => (
      item.assetId === input.candidateDocument.publicId
      && item.candidateAssetFingerprint === input.candidateAssetFingerprint
    ));
    return buildContextReceipt({
      taskId,
      taskLabel: `${taskId} 候选知识门禁`,
      principalFingerprint: context.principalFingerprint,
      effectiveContextSnapshot: context.effectiveContextSnapshot,
      provided: {
        knowledge: context.knowledge.selectedAssets.map(item => ({
          ...item,
          label: input.candidateDocument.name,
        })),
        businessData: context.businessData.sources.map(item => ({
          ...item,
          label: item.sourceSystem,
        })),
        memory: [],
        capabilities: [],
      },
      readiness: {
        status: providedCandidate ? "READY" : "BLOCKED",
        requestedOutcome: "validate_candidate_knowledge",
        allowedOutcomes: providedCandidate ? ["candidate_validation"] : [],
        deniedOutcomes: providedCandidate ? [] : ["candidate_validation"],
        reasons: providedCandidate ? [] : ["候选资产未进入任务 Provided Context"],
        remediation: providedCandidate ? [] : ["检查版本 Eligibility 与 Logical Context 映射"],
        decisionFingerprint: governanceFingerprint({ taskId, contextEvidenceFingerprint: context.contextEvidenceFingerprint }),
      },
      now: input.now,
    });
  });
  return {
    taskIds,
    receipts,
    passed: task02Result.status === "ready" && receipts.every(receipt => receipt.readiness.status === "READY"),
  };
}

export async function verifyWealthPolicyCandidate(input: {
  candidate: EnterpriseAssetCandidate;
  metadata: EnterpriseAssetMetadata;
  base: KnowledgeBaseRecord;
  document: KnowledgeDocumentRecord;
  documents: KnowledgeDocumentRecord[];
  now?: Date;
}) {
  const now = input.now || new Date();
  const effectiveAt = input.document.effectiveAt ? new Date(input.document.effectiveAt) : now;
  const evaluatedAt = effectiveAt.getTime() > now.getTime() ? effectiveAt : now;
  const candidateDocument = { ...input.document, lifecycle: "active" as const };
  const documents = input.documents.map(document => (
    document.publicId === candidateDocument.publicId ? candidateDocument : document
  ));
  const eligibility = buildKnowledgeEligibility({
    bases: [input.base],
    documents,
    userId: 0,
    actorRole: "admin",
    roleTemplate: "wealth-manager",
    now: evaluatedAt,
  });
  const selection = selectWealthPolicyDocument({
    documents,
    eligibleDocumentIds: eligibility.documentIds,
    configuredName: String(process.env.WEALTH_SUITABILITY_POLICY_DOCUMENT || DEFAULT_POLICY_DOCUMENT).trim(),
  });
  const controlled = await runWealthRolePackControlledScenarios();
  const contract = runWealthRolePackContractChecks();
  const candidateAssetFingerprint = enterpriseCandidateAssetFingerprint({
    candidate: input.candidate,
    metadata: input.metadata,
    documentId: candidateDocument.publicId,
  });
  const candidateGate = await runCandidateProvidedContextGate({
    candidateDocument,
    selection,
    eligibilityFingerprint: eligibility.fingerprint,
    candidateAssetFingerprint,
    checksum: input.candidate.checksum,
    now: evaluatedAt,
  });
  const taskIds = candidateGate.taskIds;
  const gateReceipts = candidateGate.receipts;
  const checks = [
    {
      code: "LOGICAL_ASSET_MATCH",
      passed: input.metadata.logicalAssetIds.includes("current_wealth_policy"),
      message: "候选版本映射到财富经理现行制度逻辑资产",
    },
    {
      code: "CANDIDATE_SELECTED_AT_EFFECTIVE_TIME",
      passed: selection.selected?.publicId === candidateDocument.publicId,
      message: "候选版本在生效时点成为现行依据",
    },
    {
      code: "PREDECESSOR_SUPERSEDED",
      passed: Boolean(candidateDocument.supersedesDocumentId)
        && !eligibility.documentIds.includes(String(candidateDocument.supersedesDocumentId)),
      message: "被替代版本在候选生效后退出有效集合",
    },
    {
      code: "WEALTH_GOLDEN_TASKS_PASS",
      passed: controlled.status === "PASS"
        && controlled.taskIds.includes("WM-GT-02")
        && controlled.taskIds.includes("WM-GT-03"),
      message: "财富经理受控标杆任务通过",
    },
    {
      code: "CANDIDATE_PROVIDED_TO_GOLDEN_TASKS",
      passed: candidateGate.passed && taskIds.every(taskId => gateReceipts.some(receipt => receipt.taskId === taskId
        && receipt.provided.knowledge.some(item => item.candidateAssetFingerprint === candidateAssetFingerprint))),
      message: "候选资产指纹进入每个受影响标杆任务的 Provided Context",
    },
  ];
  const verifiedAt = new Date().toISOString();
  const body = {
    schema: "ea.enterprise-knowledge-validation.v1" as const,
    status: checks.every(check => check.passed) ? "PASS" as const : "FAIL" as const,
    candidateId: input.candidate.candidateId,
    documentId: candidateDocument.publicId,
    checksum: input.candidate.checksum,
    evaluatedAsOf: evaluatedAt.toISOString(),
    selectedVersion: selection.selected?.versionLabel || null,
    candidateAssetFingerprint,
    taskIds,
    gateReceipts,
    checks,
    verifiedAt,
  };
  return {
    validation: { ...body, validationFingerprint: governanceFingerprint(body) } satisfies EnterpriseKnowledgeValidation,
    controlled,
    contract,
  };
}
