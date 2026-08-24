import type { KnowledgeBaseRecord, KnowledgeDocumentRecord } from "../db";
import type { ContextGoldenSetV1 } from "../../shared/context-governance";
import type { ContextNeedV1, ContextSourceBindingV1 } from "../../shared/context-resolution";
import { buildKnowledgeEligibility } from "./knowledge-eligibility";
import { normalizeLlamaIndexContextItem } from "./context-resolution/llamaindex-adapter";

export type ReferenceKnowledgeManifestV1 = {
  assets: Array<{
    file: string;
    lifecycle: "active" | "expired" | "archived";
  }>;
};

export function buildLlamaIndexCertificationGovernance(input: {
  base: KnowledgeBaseRecord;
  documents: KnowledgeDocumentRecord[];
  manifest: ReferenceKnowledgeManifestV1;
  roleTemplate: string;
  now: Date;
}) {
  const manifestFiles = new Set(input.manifest.assets.map(asset => asset.file));
  const benchmarkDocuments = input.documents.filter(document => manifestFiles.has(document.name));
  const missingFiles = input.manifest.assets
    .map(asset => asset.file)
    .filter(file => !benchmarkDocuments.some(document => document.name === file));
  const eligibility = buildKnowledgeEligibility({
    bases: [input.base],
    documents: benchmarkDocuments,
    userId: 0,
    actorRole: "user",
    roleTemplate: input.roleTemplate,
    now: input.now,
  });
  const activeFiles = new Set(input.manifest.assets.filter(asset => asset.lifecycle === "active").map(asset => asset.file));
  const expectedEligible = benchmarkDocuments.filter(document => activeFiles.has(document.name));
  const expired = benchmarkDocuments.filter(document => !activeFiles.has(document.name));
  const wrongRole = buildKnowledgeEligibility({
    bases: [input.base],
    documents: benchmarkDocuments,
    userId: 0,
    actorRole: "user",
    roleTemplate: "insurance-advisor",
    now: input.now,
  });
  const restrictedBase = buildKnowledgeEligibility({
    bases: [{ ...input.base, classification: "restricted" }],
    documents: benchmarkDocuments,
    userId: 0,
    actorRole: "user",
    roleTemplate: input.roleTemplate,
    now: input.now,
  });
  const seed = expectedEligible[0];
  const future = seed ? buildKnowledgeEligibility({
    bases: [input.base],
    documents: [{ ...seed, effectiveAt: "2999-01-01T00:00:00.000Z" }],
    userId: 0,
    actorRole: "user",
    roleTemplate: input.roleTemplate,
    now: input.now,
  }) : null;
  const currentPolicy = benchmarkDocuments.find(document => /V2\.2现行/u.test(document.name));
  const previousPolicy = benchmarkDocuments.find(document => /V2\.1历史/u.test(document.name));
  const superseded = currentPolicy && previousPolicy ? buildKnowledgeEligibility({
    bases: [input.base],
    documents: [
      { ...previousPolicy, lifecycle: "active", expiresAt: null },
      { ...currentPolicy, supersedesDocumentId: previousPolicy.publicId },
    ],
    userId: 0,
    actorRole: "user",
    roleTemplate: input.roleTemplate,
    now: input.now,
  }) : null;
  const eligibleSet = new Set(eligibility.documentIds);
  const scenarios = [
    { code: "REFERENCE_ASSETS_PRESENT", passed: missingFiles.length === 0 },
    { code: "ACTIVE_DOCUMENTS_ELIGIBLE", passed: expectedEligible.every(document => eligibleSet.has(document.publicId)) },
    { code: "INACTIVE_DOCUMENTS_FILTERED", passed: expired.every(document => !eligibleSet.has(document.publicId)) },
    { code: "ROLE_SCOPE_FILTERED", passed: wrongRole.documentIds.length === 0 && Number(wrongRole.excludedByReason.role_mismatch || 0) > 0 },
    { code: "CLASSIFICATION_FILTERED", passed: restrictedBase.documentIds.length === 0 && Number(restrictedBase.excludedByReason.classification_denied || 0) > 0 },
    { code: "FUTURE_VERSION_FILTERED", passed: Boolean(future && future.documentIds.length === 0 && Number(future.excludedByReason.not_effective || 0) > 0) },
    { code: "SUPERSEDED_VERSION_FILTERED", passed: Boolean(superseded && superseded.documentIds.includes(currentPolicy?.publicId || "") && !superseded.documentIds.includes(previousPolicy?.publicId || "")) },
  ];
  return {
    eligibility,
    benchmarkDocuments,
    scenarios,
    passed: scenarios.every(scenario => scenario.passed),
    failedScenarios: scenarios.filter(scenario => !scenario.passed).map(scenario => scenario.code),
  };
}

type EvaluationActualItem = {
  documentId: string;
  documentVersion: string;
  position: string;
  page?: number | null;
  score?: number;
};

type EvaluationCaseResult = {
  id: string;
  actualItems: EvaluationActualItem[];
};

export function evaluateLlamaIndexContextContract(input: {
  goldenSet: ContextGoldenSetV1;
  evaluationResults: EvaluationCaseResult[];
  documents: KnowledgeDocumentRecord[];
  knowledgeBaseId: string;
  asOf: string;
}) {
  const cases = new Map(input.goldenSet.cases.map(item => [item.caseId, item]));
  const documents = new Map(input.documents.map(item => [item.publicId, item]));
  let normalizedItemCount = 0;
  let invalidItemCount = 0;
  const errors: string[] = [];
  for (const result of input.evaluationResults) {
    const goldenCase = cases.get(result.id);
    const logicalAssetId = goldenCase?.expectedLogicalAssets.find(id => (
      id.startsWith("current_") || id.endsWith("_guide") || id.endsWith("_policy")
    ));
    if (!goldenCase || !logicalAssetId) {
      errors.push(`${result.id}: no knowledge Logical Context is declared`);
      invalidItemCount += result.actualItems.length;
      continue;
    }
    const need: ContextNeedV1 = {
      needId: `${result.id}:knowledge`,
      logicalAssetId,
      contextType: "knowledge",
      requiredness: "required",
      purpose: "provider certification",
      freshness: { mode: "current_effective" },
    };
    const binding: ContextSourceBindingV1 = {
      schema: "ea.context-source-binding.v1",
      bindingId: "provider-certification",
      organizationId: "certification",
      rolePackId: input.goldenSet.rolePackId,
      bindingScope: "role_pack",
      logicalAssetId,
      contextType: "knowledge",
      providerType: "llamaindex",
      resourceRef: `kb://${input.knowledgeBaseId}`,
      capabilities: ["metadata_filter", "citation"],
      bindingVersion: "certification-v1",
      stage: "shadow",
      status: "active",
    };
    for (const retrieved of result.actualItems) {
      const document = documents.get(retrieved.documentId);
      try {
        if (!document) throw new Error("document is absent from the asset registry snapshot");
        const item = normalizeLlamaIndexContextItem({
          need,
          binding,
          document,
          retrieved,
          asOf: input.asOf,
        });
        const complete = Boolean(
          item.assetId
          && item.assetVersion
          && item.contentHash
          && item.providerType === "llamaindex"
          && item.provenance.sourceDepartment
          && item.provenance.authority
          && Object.prototype.hasOwnProperty.call(item.provenance, "effectiveAt")
          && item.citation?.documentId
          && item.citation.position
          && item.retrieval.retrievedAt,
        );
        if (!complete) throw new Error("normalized ContextItem is incomplete");
        normalizedItemCount += 1;
      } catch (error) {
        invalidItemCount += 1;
        errors.push(`${result.id}/${retrieved.documentId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const total = normalizedItemCount + invalidItemCount;
  return {
    completeness: total ? normalizedItemCount / total : 0,
    normalizedItemCount,
    invalidItemCount,
    errors,
    // Certification evaluates Retrieved and normalized items only. It never
    // labels those items as Provided, Cited, or Applied runtime evidence.
    evidenceStagesSeparated: true,
  };
}
