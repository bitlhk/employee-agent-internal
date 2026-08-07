import { describe, expect, it } from "vitest";
import type { KnowledgeBaseRecord, KnowledgeDocumentRecord } from "../db";
import { buildKnowledgeEligibility } from "./knowledge-eligibility";

const now = new Date("2026-08-07T00:00:00.000Z");
const base: KnowledgeBaseRecord = {
  id: 1, publicId: "kb_enterprise1", ownerUserId: 1, ownerGroupId: 0,
  scope: "enterprise", isGlobal: true, roleTemplate: null, name: "企业知识", description: "",
  classification: "internal", externalProcessingAllowed: true, status: "ready",
  documentCount: 1, chunkCount: 1, lastError: null, indexVersion: "v1", indexSchemaVersion: 2,
  indexedAt: now.toISOString(), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: now.toISOString(),
};
const document: KnowledgeDocumentRecord = {
  id: 1, publicId: "doc_policy001", knowledgeBaseId: 1, name: "制度.md", extension: "md",
  mimeType: "text/markdown", storagePath: "documents/policy.md", sizeBytes: 1, sha256: "a".repeat(64),
  versionLabel: "1.0", lifecycle: "active", sourceDepartment: "", classification: "internal",
  authority: "official", externalProcessingAllowed: true, effectiveAt: null, expiresAt: null,
  status: "ready", chunkCount: 1, lastError: null, parserVersion: "2.1", indexVersion: "v1",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: now.toISOString(),
};

function eligible(overrides: Partial<KnowledgeDocumentRecord> = {}, baseOverrides: Partial<KnowledgeBaseRecord> = {}) {
  return buildKnowledgeEligibility({
    bases: [{ ...base, ...baseOverrides }], documents: [{ ...document, ...overrides }],
    userId: 7, actorRole: "user", roleTemplate: "wealth-manager", now,
  });
}

describe("knowledge eligibility", () => {
  it("allows ready active internal documents with indefinite expiry", () => {
    expect(eligible().documentIds).toEqual([document.publicId]);
  });

  it("excludes future, expired, inactive, and unfinished documents", () => {
    expect(eligible({ effectiveAt: "2026-09-01T00:00:00.000Z" }).excludedByReason).toHaveProperty("not_effective", 1);
    expect(eligible({ expiresAt: "2026-08-01T00:00:00.000Z" }).excludedByReason).toHaveProperty("expired", 1);
    expect(eligible({ lifecycle: "archived" }).excludedByReason).toHaveProperty("lifecycle_inactive", 1);
    expect(eligible({ status: "indexing" }).excludedByReason).toHaveProperty("document_not_ready", 1);
  });

  it("denies restricted shared knowledge to ordinary users", () => {
    expect(eligible({ classification: "restricted" }).documentIds).toEqual([]);
  });

  it("allows a personal knowledge owner to read restricted documents", () => {
    expect(eligible(
      { classification: "restricted" },
      { scope: "personal", ownerUserId: 7, isGlobal: false, classification: "restricted" },
    ).documentIds).toEqual([document.publicId]);
  });
});
