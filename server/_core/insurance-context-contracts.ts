import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ContextGoldenSetV1, LogicalContextCatalogV1 } from "../../shared/context-governance";
import type { ContextNeedPlanV1, ContextResolutionReasonCodeV1 } from "../../shared/context-resolution";
import {
  loadLogicalContextCatalog,
  logicalContextIndex,
  validateContextNeedPlansAgainstCatalog,
  validateLogicalContextCatalog,
} from "./logical-context-catalog";

export const INSURANCE_CONTEXT_MATRIX_PATH =
  "examples/insurance-advisor-reference-role-pack/context-reuse-matrix.v1.json";
export const INSURANCE_CONTEXT_EXTENSION_PATH =
  "examples/insurance-advisor-reference-role-pack/context-catalog-extension.v1.json";
export const INSURANCE_CONTEXT_NEEDS_PATH =
  "examples/insurance-advisor-reference-role-pack/context-needs.json";
export const INSURANCE_CONTEXT_GOLDEN_SET_PATH =
  "examples/insurance-advisor-reference-role-pack/eval/context-golden-set.v1.json";
const INSURANCE_KNOWLEDGE_MANIFEST_PATH =
  "examples/insurance-advisor-reference-role-pack/knowledge/manifest.json";
const INSURANCE_KNOWLEDGE_ROOT =
  "examples/insurance-advisor-reference-role-pack/knowledge/documents";
const GOVERNED_WORK_CONTEXT_PATH =
  "examples/governed-work-continuity-v1/context-contract.json";

type CatalogExtension = {
  schemaVersion: string;
  extensionVersion: string;
  baselineCatalogVersion: string;
  status?: string;
  entries: LogicalContextCatalogV1["entries"];
};

type ContextNeedManifest = {
  schemaVersion: string;
  status: string;
  rolePackId: string;
  roleTemplate: string;
  plans: ContextNeedPlanV1[];
};

type KnowledgeManifest = {
  assets: Array<{ file: string; versionLabel: string }>;
};

type ReuseReview = {
  status: string;
  reviewerId?: string;
  reviewerRole?: string;
  reviewedAt?: string;
  reviewComment?: string;
  groundTruthVersion?: string;
};

type ReuseMatrix = {
  matrixVersion: string;
  status: string;
  targetRolePackId: string;
  targetRoleTemplate: string;
  expertReview: ReuseReview;
  measurement: {
    totalUniqueContextNeeds: number;
    existingCanonicalContextReuseCount: number;
    existingLogicalContextReuseRatio: number;
    sharedContextBindingIdentityEligibleCount: number;
    sharedContextBindingIdentityCount: number;
    sharedContextBindingIdentityRate: number;
  };
  needs: Array<{
    logicalAssetId: string;
    decision: "reuse" | "insurance_specific";
    bindingIdentityExpected?: boolean;
    sameProductionBinding: boolean;
    review?: ReuseReview;
  }>;
};

const REASON_CODES = new Set<ContextResolutionReasonCodeV1>([
  "NO_BINDING",
  "NO_SHARED_BINDING",
  "BINDING_DISABLED",
  "CAPABILITY_MISMATCH",
  "AMBIGUOUS_BINDING",
  "EXACT_BINDING_DISABLED",
  "EXACT_BINDING_CAPABILITY_MISMATCH",
  "AMBIGUOUS_SHARED_BINDING",
  "NOT_ELIGIBLE",
  "SOURCE_UNAVAILABLE",
  "NO_USABLE_CONTEXT",
  "STALE_ASSET",
]);

const REQUIRED_FILES = [
  "examples/logical-context-catalog.v1.json",
  GOVERNED_WORK_CONTEXT_PATH,
  INSURANCE_CONTEXT_MATRIX_PATH,
  INSURANCE_CONTEXT_EXTENSION_PATH,
  INSURANCE_CONTEXT_NEEDS_PATH,
  INSURANCE_CONTEXT_GOLDEN_SET_PATH,
  INSURANCE_KNOWLEDGE_MANIFEST_PATH,
];

function readJson<T>(root: string, relativePath: string): T {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8")) as T;
}

function fingerprint(root: string): string {
  return createHash("sha256")
    .update(REQUIRED_FILES.map(file => {
      const digest = createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex");
      return `${file}:${digest}`;
    }).join("\n"))
    .digest("hex");
}

function completeExpertReview(review?: ReuseReview): boolean {
  return review?.status === "expert_confirmed"
    && Boolean(review.reviewerId?.trim())
    && Boolean(review.reviewerRole?.trim())
    && Boolean(review.reviewedAt?.trim())
    && !Number.isNaN(Date.parse(review.reviewedAt || ""))
    && Boolean(review.reviewComment?.trim())
    && Boolean(review.groundTruthVersion?.trim());
}

export function runInsuranceContextContractChecks(
  root = process.cwd(),
  options: { requireExpertConfirmed?: boolean } = {},
) {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const file of REQUIRED_FILES) {
    if (!existsSync(path.join(root, file))) errors.push(`Contract asset is missing: ${file}`);
  }
  if (errors.length) return { schema: "ea.insurance-context-contract-report.v1", status: "FAIL" as const, errors, warnings };

  const baseCatalog = loadLogicalContextCatalog(root);
  const workExtension = readJson<CatalogExtension>(root, GOVERNED_WORK_CONTEXT_PATH);
  const insuranceExtension = readJson<CatalogExtension>(root, INSURANCE_CONTEXT_EXTENSION_PATH);
  const contextNeeds = readJson<ContextNeedManifest>(root, INSURANCE_CONTEXT_NEEDS_PATH);
  const goldenSet = readJson<ContextGoldenSetV1>(root, INSURANCE_CONTEXT_GOLDEN_SET_PATH);
  const matrix = readJson<ReuseMatrix>(root, INSURANCE_CONTEXT_MATRIX_PATH);
  const knowledgeManifest = readJson<KnowledgeManifest>(root, INSURANCE_KNOWLEDGE_MANIFEST_PATH);

  if (insuranceExtension.schemaVersion !== "ea.logical-context-catalog-extension.v1") {
    errors.push("Insurance Context Catalog extension schema is unsupported");
  }
  if (insuranceExtension.baselineCatalogVersion !== baseCatalog.catalogVersion) {
    errors.push("Insurance Context Catalog extension targets a different baseline catalog");
  }
  if (insuranceExtension.status !== "expert_confirmed") {
    errors.push("Insurance Context Catalog extension is not expert confirmed");
  }
  const mergedCatalog: LogicalContextCatalogV1 = {
    ...baseCatalog,
    catalogVersion: `${baseCatalog.catalogVersion}+insurance.${insuranceExtension.extensionVersion}`,
    entries: [...baseCatalog.entries, ...workExtension.entries, ...insuranceExtension.entries],
  };
  errors.push(...validateLogicalContextCatalog(mergedCatalog));
  errors.push(...validateContextNeedPlansAgainstCatalog(contextNeeds.plans, mergedCatalog));

  if (contextNeeds.schemaVersion !== "ea.reference-role-pack.context-needs.v1") {
    errors.push("Insurance Context Need schema is unsupported");
  }
  if (contextNeeds.status !== "expert_confirmed") errors.push("Insurance Context Need plans are not expert confirmed");
  if (contextNeeds.rolePackId !== goldenSet.rolePackId || contextNeeds.roleTemplate !== goldenSet.roleTemplate) {
    errors.push("Insurance Golden Set role binding does not match Context Need plans");
  }
  if (matrix.targetRolePackId !== contextNeeds.rolePackId || matrix.targetRoleTemplate !== contextNeeds.roleTemplate) {
    errors.push("Insurance reuse matrix role binding does not match Context Need plans");
  }

  const uniqueNeeds = new Set(contextNeeds.plans.flatMap(plan => plan.needs.map(need => need.logicalAssetId)));
  const reusedNeeds = matrix.needs.filter(need => need.decision === "reuse");
  const identityEligible = matrix.needs.filter(need => need.bindingIdentityExpected === true);
  const identityShared = identityEligible.filter(need => need.sameProductionBinding === true);
  if (uniqueNeeds.size !== 10 || matrix.needs.length !== 10) errors.push("Insurance Context Contract must contain 10 unique Context Needs");
  if (matrix.measurement.totalUniqueContextNeeds !== uniqueNeeds.size) errors.push("Reuse matrix total Context Need count is stale");
  if (matrix.measurement.existingCanonicalContextReuseCount !== reusedNeeds.length) errors.push("Reuse matrix canonical reuse count is stale");
  if (matrix.measurement.existingLogicalContextReuseRatio !== reusedNeeds.length / uniqueNeeds.size) errors.push("Reuse matrix canonical reuse ratio is stale");
  if (matrix.measurement.sharedContextBindingIdentityEligibleCount !== identityEligible.length) errors.push("Shared Binding denominator is stale");
  if (matrix.measurement.sharedContextBindingIdentityCount !== identityShared.length) errors.push("Shared Binding identity count is stale");
  if (matrix.measurement.sharedContextBindingIdentityRate !== identityShared.length / identityEligible.length) errors.push("Shared Binding identity rate is stale");
  for (const need of matrix.needs) {
    if (!uniqueNeeds.has(need.logicalAssetId)) errors.push(`Reuse matrix Context is not declared: ${need.logicalAssetId}`);
    if (options.requireExpertConfirmed && !completeExpertReview(need.review)) errors.push(`${need.logicalAssetId}: expert confirmation is incomplete`);
  }
  if (options.requireExpertConfirmed && !completeExpertReview(matrix.expertReview)) errors.push("Reuse matrix expert confirmation is incomplete");

  const plans = new Map(contextNeeds.plans.map(plan => [plan.taskId, plan]));
  const documents = new Map(knowledgeManifest.assets.map(asset => [asset.file, asset]));
  const catalogIndex = logicalContextIndex(mergedCatalog);
  const caseIds = new Set<string>();
  const categoryCounts = { version_correctness: 0, eligibility: 0, context_need: 0, retrieval_location: 0 };
  let expertConfirmedCases = 0;
  for (const item of goldenSet.cases) {
    if (caseIds.has(item.caseId)) errors.push(`Duplicate Insurance Golden Case: ${item.caseId}`);
    caseIds.add(item.caseId);
    categoryCounts[item.category] += 1;
    const plan = plans.get(item.taskId);
    if (!plan) {
      errors.push(`${item.caseId}: task ${item.taskId} has no Context Need plan`);
      continue;
    }
    const planNeeds = new Map(plan.needs.map(need => [need.logicalAssetId, need]));
    for (const logicalAssetId of item.expectedLogicalAssets || []) {
      if (!catalogIndex.has(logicalAssetId)) errors.push(`${item.caseId}: unregistered Logical Context ${logicalAssetId}`);
      if (!planNeeds.has(logicalAssetId)) errors.push(`${item.caseId}: ${logicalAssetId} is not declared by ${item.taskId}`);
    }
    for (const logicalAssetId of item.requiredContext || []) {
      if (planNeeds.get(logicalAssetId)?.requiredness !== "required") errors.push(`${item.caseId}: ${logicalAssetId} is not required by ${item.taskId}`);
    }
    if (item.evaluationLayers.includes("retrieval") && !item.expectedDocuments?.length) errors.push(`${item.caseId}: retrieval evaluation requires expected documents`);
    const expectedVersions = new Set<string>();
    const expectedDocumentText: string[] = [];
    for (const file of item.expectedDocuments || []) {
      const document = documents.get(file);
      if (!document) errors.push(`${item.caseId}: document is not in the Insurance knowledge manifest: ${file}`);
      else {
        expectedVersions.add(document.versionLabel);
        const documentPath = path.join(root, INSURANCE_KNOWLEDGE_ROOT, file);
        if (!existsSync(documentPath)) errors.push(`${item.caseId}: knowledge document is missing: ${file}`);
        else expectedDocumentText.push(readFileSync(documentPath, "utf8"));
      }
    }
    for (const version of item.expectedVersions || []) {
      if (!expectedVersions.has(version)) errors.push(`${item.caseId}: expected version ${version} is not represented by an expected document`);
    }
    for (const position of item.expectedPositions || []) {
      if (!expectedDocumentText.some(text => text.includes(position))) errors.push(`${item.caseId}: expected position is missing: ${position}`);
    }
    for (const reasonCode of item.expectedReasonCodes || []) {
      if (!REASON_CODES.has(reasonCode)) errors.push(`${item.caseId}: unsupported reason code ${reasonCode}`);
    }
    if (completeExpertReview(item.review)) expertConfirmedCases += 1;
    else if (options.requireExpertConfirmed) errors.push(`${item.caseId}: expert confirmation is incomplete`);
  }
  if (goldenSet.cases.length !== 15) errors.push("Insurance Context Golden Set V1 must contain 15 cases");
  for (const [category, count] of Object.entries(categoryCounts)) {
    if (!count) errors.push(`Insurance Context Golden Set does not cover ${category}`);
  }
  if (!goldenSet.cases.find(item => item.caseId === "IA-CG-002")?.forbiddenDocuments?.length) {
    warnings.push("IA-CG-002 business rule is frozen, but a historical Insurance fixture is still required before Provider evaluation");
  }

  return {
    schema: "ea.insurance-context-contract-report.v1",
    status: errors.length ? "FAIL" as const : "PASS" as const,
    rolePackId: contextNeeds.rolePackId,
    contractVersion: goldenSet.setVersion,
    uniqueContextNeedCount: uniqueNeeds.size,
    planCount: contextNeeds.plans.length,
    goldenCaseCount: goldenSet.cases.length,
    categoryCounts,
    expertConfirmedNeedCount: matrix.needs.filter(need => completeExpertReview(need.review)).length,
    expertConfirmedCaseCount: expertConfirmedCases,
    existingLogicalContextReuseRatio: matrix.measurement.existingLogicalContextReuseRatio,
    sharedContextBindingIdentityRate: matrix.measurement.sharedContextBindingIdentityRate,
    runtimeReuseStatus: matrix.status === "needs_resolution" ? "NEEDS_RESOLUTION" as const : "READY" as const,
    contractFingerprint: fingerprint(root),
    warnings,
    errors,
  };
}
