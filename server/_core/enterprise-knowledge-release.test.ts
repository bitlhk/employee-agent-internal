import { describe, expect, it } from "vitest";
import type { EnterpriseAssetCandidate } from "../../drizzle/schema";
import type { KnowledgeBaseRecord, KnowledgeDocumentRecord } from "../db";
import type { EnterpriseAssetMetadata } from "./enterprise-asset-onboarding";
import { verifyWealthPolicyCandidate } from "./enterprise-knowledge-release";

const base: KnowledgeBaseRecord = {
  id: 1, publicId: "kb_wealth_policy", ownerUserId: 1, ownerGroupId: 1,
  scope: "role", isGlobal: true, roleTemplate: "wealth-manager", name: "财富经理岗位知识",
  description: "", classification: "internal", externalProcessingAllowed: true, status: "ready",
  documentCount: 2, chunkCount: 2, lastError: null, indexVersion: "v1", indexSchemaVersion: 1,
  indexedAt: "2026-08-20T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
};

function document(input: Partial<KnowledgeDocumentRecord> & Pick<KnowledgeDocumentRecord, "publicId" | "name" | "versionLabel">): KnowledgeDocumentRecord {
  return {
    id: input.publicId.endsWith("33") ? 33 : 32,
    knowledgeBaseId: base.id,
    extension: "md",
    mimeType: "text/markdown",
    storagePath: input.name,
    sizeBytes: 100,
    sha256: input.publicId.endsWith("33") ? "b".repeat(64) : "a".repeat(64),
    documentSeriesId: "wealth-suitability-policy",
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
    parserVersion: "v1",
    indexVersion: "v1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...input,
  };
}

const current = document({
  publicId: "doc_policy_v32",
  name: "15-财富产品适当性销售管理细则（V2.2现行）.md",
  versionLabel: "V3.2",
});
const replacement = document({
  publicId: "doc_policy_v33",
  name: "15-财富产品适当性销售管理细则（V3.3）.md",
  versionLabel: "V3.3",
  lifecycle: "draft",
  supersedesDocumentId: current.publicId,
  effectiveAt: "2026-09-01T00:00:00.000Z",
});

const candidate = {
  id: 33,
  candidateId: "eac_1234567890abcdef1234567890abcdef",
  sourceId: "wealth-policy-source",
  enterpriseAssetId: "wealth-suitability-policy",
  assetType: "knowledge_document",
  displayName: replacement.name,
  sourceUri: "candidate://asset",
  sourceVersion: "V3.3",
  checksum: replacement.sha256,
  suggestedMetadataJson: {},
  discoveryJson: null,
  diagnosticsJson: null,
  confirmedMetadataJson: null,
  status: "approved",
  targetAssetType: "knowledge_document",
  targetAssetId: replacement.publicId,
  impactAnalysisJson: null,
  reviewNote: null,
  reviewedBy: "admin",
  reviewedAt: new Date("2026-08-20T00:00:00.000Z"),
  publishedBy: null,
  publishedAt: null,
  createdBy: "admin",
  updatedBy: "admin",
  createdAt: new Date("2026-08-20T00:00:00.000Z"),
  updatedAt: new Date("2026-08-20T00:00:00.000Z"),
} satisfies EnterpriseAssetCandidate;

const metadata: EnterpriseAssetMetadata = {
  ownerDepartment: "财富管理部",
  classification: "internal",
  applicableRoles: ["wealth-manager"],
  applicableOrganizations: [],
  lifecycle: "active",
  authority: "official",
  effectiveAt: replacement.effectiveAt,
  expiresAt: null,
  documentSeriesId: "wealth-suitability-policy",
  supersedes: current.publicId,
  logicalAssetIds: ["current_wealth_policy"],
  externalProcessingAllowed: true,
  relatedTasks: ["WM-GT-02", "WM-GT-03"],
  policyCandidates: [],
};

describe("enterprise knowledge release", () => {
  it("validates a future wealth policy against its effective Context set", async () => {
    const result = await verifyWealthPolicyCandidate({
      candidate,
      metadata,
      base,
      document: replacement,
      documents: [current, replacement],
      now: new Date("2026-08-20T00:00:00.000Z"),
    });
    expect(result.validation).toMatchObject({
      status: "PASS",
      selectedVersion: "V3.3",
      evaluatedAsOf: "2026-09-01T00:00:00.000Z",
      taskIds: ["WM-GT-02", "WM-GT-03"],
    });
    expect(result.validation.checks.every(check => check.passed)).toBe(true);
    expect(result.validation.validationFingerprint).toHaveLength(64);
  });

  it("fails when the candidate does not explicitly supersede the current version", async () => {
    const result = await verifyWealthPolicyCandidate({
      candidate,
      metadata: { ...metadata, supersedes: null },
      base,
      document: { ...replacement, supersedesDocumentId: null },
      documents: [current, { ...replacement, supersedesDocumentId: null }],
      now: new Date("2026-08-20T00:00:00.000Z"),
    });
    expect(result.validation.status).toBe("FAIL");
    expect(result.validation.checks).toContainEqual(expect.objectContaining({ code: "PREDECESSOR_SUPERSEDED", passed: false }));
  });
});
