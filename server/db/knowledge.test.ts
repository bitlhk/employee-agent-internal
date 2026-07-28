import { describe, expect, it } from "vitest";
import { isKnowledgeDocumentCurrentlyActive, type KnowledgeDocumentRecord } from "./knowledge";

function document(overrides: Partial<KnowledgeDocumentRecord> = {}): KnowledgeDocumentRecord {
  return {
    id: 1,
    publicId: "doc_governance1",
    knowledgeBaseId: 1,
    name: "制度.md",
    extension: "md",
    mimeType: "text/plain",
    storagePath: "documents/policy.md",
    sizeBytes: 100,
    sha256: "a".repeat(64),
    versionLabel: "2026.1",
    lifecycle: "active",
    sourceDepartment: "财务部",
    classification: "internal",
    authority: "official",
    externalProcessingAllowed: true,
    effectiveAt: null,
    expiresAt: null,
    status: "ready",
    chunkCount: 2,
    lastError: null,
    parserVersion: "2.0",
    indexVersion: "v1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("knowledge document governance", () => {
  const now = new Date("2026-07-28T00:00:00.000Z");

  it("indexes only active documents within their effective window", () => {
    expect(isKnowledgeDocumentCurrentlyActive(document(), now)).toBe(true);
    expect(isKnowledgeDocumentCurrentlyActive(document({ lifecycle: "draft" }), now)).toBe(false);
    expect(isKnowledgeDocumentCurrentlyActive(document({ effectiveAt: "2026-08-01T00:00:00.000Z" }), now)).toBe(false);
    expect(isKnowledgeDocumentCurrentlyActive(document({ expiresAt: "2026-07-01T00:00:00.000Z" }), now)).toBe(false);
  });
});
