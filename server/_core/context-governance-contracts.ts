import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  CONTEXT_GOLDEN_SET_SCHEMA,
  type ContextGoldenCaseCategoryV1,
  type ContextGoldenSetV1,
} from "../../shared/context-governance";
import type {
  ContextNeedPlanV1,
  ContextResolutionReasonCodeV1,
} from "../../shared/context-resolution";
import {
  loadLogicalContextCatalog,
  logicalContextIndex,
  LOGICAL_CONTEXT_CATALOG_PATH,
  validateContextNeedPlansAgainstCatalog,
  validateLogicalContextCatalog,
} from "./logical-context-catalog";

export const WEALTH_CONTEXT_GOLDEN_SET_PATH =
  "examples/wealth-manager-reference-role-pack/eval/context-golden-set.v1.json";
const WEALTH_CONTEXT_NEEDS_PATH =
  "examples/wealth-manager-reference-role-pack/context-needs.json";
const WEALTH_KNOWLEDGE_MANIFEST_PATH =
  "examples/wealth-manager-reference-role-pack/knowledge/manifest.json";
const WEALTH_KNOWLEDGE_ROOT = "examples/financial-enterprise-knowledge-demo";

const CATEGORIES: ContextGoldenCaseCategoryV1[] = [
  "version_correctness",
  "eligibility",
  "context_need",
  "retrieval_location",
];
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

type ContextNeedManifest = {
  rolePackId: string;
  roleTemplate: string;
  plans: ContextNeedPlanV1[];
};

type KnowledgeManifest = {
  assets: Array<{ file: string; versionLabel: string }>;
};

type ContextGovernanceContractOptions = {
  requireExpertConfirmed?: boolean;
};

function readJson<T>(root: string, relativePath: string): T {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8")) as T;
}

function fingerprint(root: string, files: string[]): string {
  return createHash("sha256")
    .update(
      files
        .map(
          file =>
            `${file}:${createHash("sha256")
              .update(readFileSync(path.join(root, file)))
              .digest("hex")}`
        )
        .join("\n")
    )
    .digest("hex");
}

export function runWealthContextGovernanceContractChecks(
  root = process.cwd(),
  options: ContextGovernanceContractOptions = {}
) {
  const errors: string[] = [];
  const files = [
    LOGICAL_CONTEXT_CATALOG_PATH,
    WEALTH_CONTEXT_GOLDEN_SET_PATH,
    WEALTH_CONTEXT_NEEDS_PATH,
    WEALTH_KNOWLEDGE_MANIFEST_PATH,
  ];
  for (const file of files)
    if (!existsSync(path.join(root, file)))
      errors.push(`Contract asset is missing: ${file}`);
  if (errors.length)
    return {
      schema: "ea.context-governance-contract-report.v1",
      status: "FAIL" as const,
      errors,
    };

  const catalog = loadLogicalContextCatalog(root);
  const goldenSet = readJson<ContextGoldenSetV1>(
    root,
    WEALTH_CONTEXT_GOLDEN_SET_PATH
  );
  const contextNeeds = readJson<ContextNeedManifest>(
    root,
    WEALTH_CONTEXT_NEEDS_PATH
  );
  const knowledgeManifest = readJson<KnowledgeManifest>(
    root,
    WEALTH_KNOWLEDGE_MANIFEST_PATH
  );
  errors.push(...validateLogicalContextCatalog(catalog));
  errors.push(
    ...validateContextNeedPlansAgainstCatalog(contextNeeds.plans, catalog)
  );

  if (goldenSet.schemaVersion !== CONTEXT_GOLDEN_SET_SCHEMA)
    errors.push("Context Golden Set schema is unsupported");
  if (
    goldenSet.rolePackId !== contextNeeds.rolePackId ||
    goldenSet.roleTemplate !== contextNeeds.roleTemplate
  ) {
    errors.push(
      "Context Golden Set role binding does not match Context Need plans"
    );
  }
  const goldenCases = goldenSet.cases || [];
  if (goldenCases.length < 15 || goldenCases.length > 20)
    errors.push("Context Golden Set V1 must contain 15 to 20 cases");

  const catalogIndex = logicalContextIndex(catalog);
  const plans = new Map(contextNeeds.plans.map(plan => [plan.taskId, plan]));
  const documents = new Map(
    knowledgeManifest.assets.map(asset => [asset.file, asset])
  );
  const caseIds = new Set<string>();
  const categoryCounts = Object.fromEntries(
    CATEGORIES.map(category => [category, 0])
  ) as Record<ContextGoldenCaseCategoryV1, number>;
  let proposedCases = 0;
  let reviewingCases = 0;
  let needsResolutionCases = 0;
  let expertConfirmedCases = 0;

  for (const item of goldenCases) {
    if (caseIds.has(item.caseId))
      errors.push(`Duplicate Context Golden Case: ${item.caseId}`);
    caseIds.add(item.caseId);
    if (!CATEGORIES.includes(item.category))
      errors.push(`${item.caseId}: unsupported category ${item.category}`);
    else categoryCounts[item.category] += 1;
    if (!item.query?.trim()) errors.push(`${item.caseId}: query is required`);
    if (!item.evaluationLayers?.length)
      errors.push(`${item.caseId}: at least one evaluation layer is required`);
    const plan = plans.get(item.taskId);
    if (!plan) {
      errors.push(
        `${item.caseId}: task ${item.taskId} has no Context Need plan`
      );
      continue;
    }
    const planNeeds = new Map(
      plan.needs.map(need => [need.logicalAssetId, need])
    );
    for (const logicalAssetId of item.expectedLogicalAssets || []) {
      if (!catalogIndex.has(logicalAssetId))
        errors.push(
          `${item.caseId}: Logical Context ${logicalAssetId} is not registered`
        );
      if (!planNeeds.has(logicalAssetId))
        errors.push(
          `${item.caseId}: Logical Context ${logicalAssetId} is not declared by ${item.taskId}`
        );
    }
    for (const logicalAssetId of item.requiredContext || []) {
      const need = planNeeds.get(logicalAssetId);
      if (!need)
        errors.push(
          `${item.caseId}: required Context ${logicalAssetId} is not declared by ${item.taskId}`
        );
      else if (need.requiredness !== "required")
        errors.push(
          `${item.caseId}: ${logicalAssetId} is optional in ${item.taskId}`
        );
    }
    if (
      item.evaluationLayers.includes("retrieval") &&
      !item.expectedDocuments?.length
    ) {
      errors.push(
        `${item.caseId}: retrieval evaluation requires expectedDocuments`
      );
    }
    const expectedDocumentVersions = new Set<string>();
    for (const documentName of [
      ...(item.expectedDocuments || []),
      ...(item.forbiddenDocuments || []),
    ]) {
      const document = documents.get(documentName);
      if (!document)
        errors.push(
          `${item.caseId}: document is not in the Wealth knowledge manifest: ${documentName}`
        );
      else {
        expectedDocumentVersions.add(document.versionLabel);
        if (!existsSync(path.join(root, WEALTH_KNOWLEDGE_ROOT, documentName)))
          errors.push(
            `${item.caseId}: knowledge document is missing: ${documentName}`
          );
      }
    }
    for (const version of item.expectedVersions || []) {
      if (!expectedDocumentVersions.has(version))
        errors.push(
          `${item.caseId}: expected version ${version} is not represented by an expected document`
        );
    }
    for (const reasonCode of item.expectedReasonCodes || []) {
      if (!REASON_CODES.has(reasonCode))
        errors.push(`${item.caseId}: unsupported reason code ${reasonCode}`);
    }
    if (item.expectedStatus === "READY" && item.expectedReasonCodes?.length)
      errors.push(
        `${item.caseId}: READY case cannot require failure reason codes`
      );
    const review = item.review;
    if (review?.status === "proposed") proposedCases += 1;
    else if (review?.status === "expert_reviewing") {
      reviewingCases += 1;
      if (!review.reviewerId?.trim() || !review.reviewerRole?.trim()) {
        errors.push(
          `${item.caseId}: expert_reviewing requires reviewerId and reviewerRole`
        );
      }
    } else if (review?.status === "needs_resolution") {
      needsResolutionCases += 1;
      if (
        !review.reviewerId?.trim() ||
        !review.reviewerRole?.trim() ||
        !review.reviewComment?.trim()
      ) {
        errors.push(
          `${item.caseId}: needs_resolution requires reviewer identity, role and comment`
        );
      }
    } else if (review?.status === "expert_confirmed") {
      expertConfirmedCases += 1;
      if (
        !review.reviewerId?.trim() ||
        !review.reviewerRole?.trim() ||
        !review.reviewedAt?.trim() ||
        !review.reviewComment?.trim() ||
        !review.groundTruthVersion?.trim()
      ) {
        errors.push(
          `${item.caseId}: expert_confirmed requires reviewerId, reviewerRole, reviewedAt, reviewComment and groundTruthVersion`
        );
      } else if (Number.isNaN(Date.parse(review.reviewedAt))) {
        errors.push(`${item.caseId}: reviewedAt must be an ISO timestamp`);
      }
    } else errors.push(`${item.caseId}: unsupported review status`);
  }
  for (const category of CATEGORIES)
    if (!categoryCounts[category])
      errors.push(`Context Golden Set does not cover ${category}`);
  if (
    options.requireExpertConfirmed &&
    expertConfirmedCases !== goldenCases.length
  ) {
    errors.push(
      `Expert confirmation gate requires all ${goldenCases.length} cases; confirmed ${expertConfirmedCases}`
    );
  }

  return {
    schema: "ea.context-governance-contract-report.v1",
    status: errors.length ? ("FAIL" as const) : ("PASS" as const),
    rolePackId: goldenSet.rolePackId,
    catalogVersion: catalog.catalogVersion,
    goldenSetVersion: goldenSet.setVersion,
    catalogEntryCount: catalog.entries.length,
    caseCount: goldenCases.length,
    categoryCounts,
    reviewStatus: {
      proposed: proposedCases,
      expertReviewing: reviewingCases,
      needsResolution: needsResolutionCases,
      expertConfirmed: expertConfirmedCases,
    },
    contractFingerprint: fingerprint(root, files),
    errors,
  };
}
