import { describe, expect, it } from "vitest";
import type { KnowledgeBaseRecord, KnowledgeDocumentRecord } from "../db";
import {
  buildLlamaIndexCertificationGovernance,
  evaluateLlamaIndexContextContract,
} from "./llamaindex-provider-certification";

const base: KnowledgeBaseRecord = {
  id: 1,
  publicId: "kb_certification_01",
  ownerUserId: 1,
  ownerGroupId: 1,
  scope: "role",
  isGlobal: true,
  roleTemplate: "wealth-manager",
  name: "Certification",
  description: "",
  classification: "internal",
  externalProcessingAllowed: true,
  status: "ready",
  documentCount: 2,
  chunkCount: 2,
  lastError: null,
  indexVersion: "v1",
  indexSchemaVersion: 2,
  indexedAt: "2026-08-21T00:00:00.000Z",
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
};

function document(input: Partial<KnowledgeDocumentRecord> & Pick<KnowledgeDocumentRecord, "publicId" | "name">): KnowledgeDocumentRecord {
  return {
    id: 1,
    knowledgeBaseId: 1,
    extension: ".md",
    mimeType: "text/markdown",
    storagePath: "test",
    sizeBytes: 10,
    sha256: "a".repeat(64),
    sourceAssetId: input.publicId,
    documentSeriesId: input.publicId,
    supersedesDocumentId: null,
    versionLabel: "V1.0",
    lifecycle: "active",
    sourceDepartment: "财富管理部",
    classification: "internal",
    authority: "official",
    externalProcessingAllowed: true,
    effectiveAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    status: "ready",
    chunkCount: 1,
    lastError: null,
    parserVersion: "2.1",
    indexVersion: "v1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}

describe("LlamaIndex Provider Certification evidence", () => {
  it("builds an Eligibility snapshot and fails closed for role, classification, time, and lifecycle", () => {
    const current = document({ publicId: "doc_current", name: "15-财富产品适当性销售管理细则（V2.2现行）.md", versionLabel: "V2.2" });
    const historical = document({
      publicId: "doc_history",
      name: "16-财富产品适当性销售管理细则（V2.1历史）.md",
      versionLabel: "V2.1",
      lifecycle: "expired",
      expiresAt: "2025-12-31T00:00:00.000Z",
    });
    const result = buildLlamaIndexCertificationGovernance({
      base,
      documents: [current, historical],
      manifest: { assets: [
        { file: current.name, lifecycle: "active" },
        { file: historical.name, lifecycle: "expired" },
      ] },
      roleTemplate: "wealth-manager",
      now: new Date("2026-08-21T00:00:00.000Z"),
    });

    expect(result.passed).toBe(true);
    expect(result.eligibility.documentIds).toEqual([current.publicId]);
  });

  it("counts only normalized Retrieved items and does not promote them to cited evidence", () => {
    const current = document({ publicId: "doc_current", name: "policy.md", versionLabel: "V2.2" });
    const result = evaluateLlamaIndexContextContract({
      goldenSet: {
        schemaVersion: "ea.context-golden-set.v1",
        setVersion: "1",
        name: "test",
        rolePackId: "wealth",
        roleTemplate: "wealth-manager",
        cases: [{
          caseId: "case-1",
          category: "retrieval_location",
          taskId: "WM-GT-03",
          query: "test",
          evaluationLayers: ["retrieval"],
          expectedLogicalAssets: ["current_wealth_policy"],
          review: { status: "expert_confirmed" },
        }],
      },
      evaluationResults: [{
        id: "case-1",
        actualItems: [{ documentId: current.publicId, documentVersion: "V2.2", position: "4.1" }],
      }],
      documents: [current],
      knowledgeBaseId: base.publicId,
      asOf: "2026-08-21T00:00:00.000Z",
    });

    expect(result.completeness).toBe(1);
    expect(result.normalizedItemCount).toBe(1);
    expect(result.evidenceStagesSeparated).toBe(true);
  });
});
