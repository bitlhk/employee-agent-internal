import { describe, expect, it } from "vitest";
import type { KnowledgeDocumentRecord } from "../db";
import { selectWealthPolicyDocument } from "./wealth-policy-selection";

function document(input: Partial<KnowledgeDocumentRecord> & Pick<KnowledgeDocumentRecord, "publicId" | "name" | "versionLabel">): KnowledgeDocumentRecord {
  return {
    id: input.publicId.endsWith("33") ? 33 : 32,
    knowledgeBaseId: 1,
    extension: "md",
    mimeType: "text/markdown",
    storagePath: input.name,
    sizeBytes: 1,
    sha256: input.publicId.endsWith("33") ? "b".repeat(64) : "a".repeat(64),
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
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}

describe("wealth policy selection", () => {
  it("selects the latest eligible version in the configured document series", () => {
    const current = document({
      publicId: "doc_policy_v32",
      name: "财富产品适当性销售管理细则（V3.2现行）.md",
      versionLabel: "V3.2",
      documentSeriesId: "wealth-policy",
    });
    const replacement = document({
      publicId: "doc_policy_v33",
      name: "财富产品适当性销售管理细则（V3.3）.md",
      versionLabel: "V3.3",
      documentSeriesId: "wealth-policy",
      supersedesDocumentId: current.publicId,
      effectiveAt: "2026-09-01T00:00:00.000Z",
    });
    const result = selectWealthPolicyDocument({
      documents: [current, replacement],
      eligibleDocumentIds: [replacement.publicId],
      configuredName: current.name,
    });
    expect(result.selected?.publicId).toBe(replacement.publicId);
  });

  it("falls back to a normalized series name when the configured version is no longer stored", () => {
    const replacement = document({
      publicId: "doc_policy_v33",
      name: "财富产品适当性销售管理细则（V3.3）.md",
      versionLabel: "V3.3",
    });
    const result = selectWealthPolicyDocument({
      documents: [replacement],
      eligibleDocumentIds: [replacement.publicId],
      configuredName: "财富产品适当性销售管理细则（V3.2现行）.md",
    });
    expect(result.selected?.publicId).toBe(replacement.publicId);
  });
});
