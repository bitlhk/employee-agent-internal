import type { EnterpriseAssetCandidate } from "../../drizzle/schema";
import type { EnterpriseAssetMetadata } from "./enterprise-asset-onboarding";
import type { KnowledgeBaseRecord, KnowledgeDocumentRecord } from "../db";
import { governanceFingerprint } from "./governance/contracts";
import { buildKnowledgeEligibility } from "./knowledge-eligibility";
import { runWealthRolePackContractChecks } from "./reference-role-pack-contracts";
import { runWealthRolePackControlledScenarios } from "./wealth-role-pack-scenarios";
import { selectWealthPolicyDocument } from "./wealth-policy-selection";

const DEFAULT_POLICY_DOCUMENT = "15-财富产品适当性销售管理细则（V2.2现行）.md";

export type EnterpriseKnowledgeValidation = {
  schema: "ea.enterprise-knowledge-validation.v1";
  status: "PASS" | "FAIL";
  candidateId: string;
  documentId: string;
  checksum: string;
  evaluatedAsOf: string;
  selectedVersion: string | null;
  taskIds: string[];
  checks: Array<{ code: string; passed: boolean; message: string }>;
  verifiedAt: string;
  validationFingerprint: string;
};

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
    taskIds: ["WM-GT-02", "WM-GT-03"],
    checks,
    verifiedAt,
  };
  return {
    validation: { ...body, validationFingerprint: governanceFingerprint(body) } satisfies EnterpriseKnowledgeValidation,
    controlled,
    contract,
  };
}
