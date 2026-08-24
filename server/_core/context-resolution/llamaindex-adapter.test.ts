import { describe, expect, it } from "vitest";
import type { KnowledgeBaseRecord, KnowledgeDocumentRecord } from "../../db";
import type { ContextSourceBindingV1 } from "../../../shared/context-resolution";
import { llamaIndexKnowledgeBaseId, normalizeLlamaIndexContextItem, selectLlamaIndexKnowledgeBases } from "./llamaindex-adapter";

const binding: ContextSourceBindingV1 = {
  schema: "ea.context-source-binding.v1",
  bindingId: "wealth-policy",
  organizationId: "org-a",
  rolePackId: "linggan-bank.wealth-manager",
  bindingScope: "role_pack",
  logicalAssetId: "current_wealth_policy",
  contextType: "knowledge",
  providerType: "llamaindex",
  resourceRef: "kb://kb_wealth_policy_01",
  capabilities: ["metadata_filter", "citation"],
  bindingVersion: "1",
  stage: "production",
  status: "active",
};

function base(publicId: string, status: KnowledgeBaseRecord["status"] = "ready"): KnowledgeBaseRecord {
  return {
    id: 1,
    publicId,
    ownerUserId: 1,
    ownerGroupId: 1,
    scope: "role",
    isGlobal: true,
    roleTemplate: "wealth-manager",
    name: "Wealth policy",
    description: "",
    classification: "internal",
    externalProcessingAllowed: true,
    status,
    documentCount: 1,
    chunkCount: 1,
    lastError: null,
    indexVersion: "v1",
    indexSchemaVersion: 1,
    indexedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("LlamaIndex Context binding adapter", () => {
  it("parses only canonical knowledge-base references", () => {
    expect(llamaIndexKnowledgeBaseId(binding.resourceRef)).toBe("kb_wealth_policy_01");
    expect(llamaIndexKnowledgeBaseId("https://example.com/private")).toBeNull();
  });

  it("selects a bound base only from the principal-accessible universe", () => {
    expect(selectLlamaIndexKnowledgeBases({ binding, accessibleBases: [base("kb_wealth_policy_01")] }).knowledgeBaseIds)
      .toEqual(["kb_wealth_policy_01"]);
  });

  it("does not allow a binding to bypass knowledge eligibility", () => {
    expect(() => selectLlamaIndexKnowledgeBases({ binding, accessibleBases: [base("kb_other_base_01")] }))
      .toThrow("not eligible for the current principal");
  });

  it("normalizes a governed retrieval result without losing version or citation metadata", () => {
    const document = {
      publicId: "doc_policy_v22",
      sourceAssetId: "wm-policy",
      versionLabel: "V2.2",
      sha256: "a".repeat(64),
      sourceDepartment: "财富管理部",
      authority: "official",
      effectiveAt: "2026-07-01T00:00:00.000Z",
    } as KnowledgeDocumentRecord;
    const item = normalizeLlamaIndexContextItem({
      need: {
        needId: "policy",
        logicalAssetId: "current_wealth_policy",
        contextType: "knowledge",
        requiredness: "required",
        purpose: "test",
        freshness: { mode: "current_effective" },
      },
      binding,
      document,
      retrieved: {
        documentId: document.publicId,
        documentVersion: "V2.2",
        position: "4.1 风险等级匹配",
        page: 12,
        score: 0.9,
      },
      asOf: "2026-08-21T00:00:00.000Z",
    });

    expect(item).toEqual(expect.objectContaining({
      schema: "ea.context-item.v1",
      assetId: "wm-policy",
      assetVersion: "V2.2",
      providerType: "llamaindex",
      citation: expect.objectContaining({ documentId: "doc_policy_v22", page: 12 }),
      provenance: expect.objectContaining({ authority: "official" }),
    }));
  });

  it("fails closed when the retrieval version differs from the asset registry", () => {
    const document = {
      publicId: "doc_policy_v22",
      versionLabel: "V2.2",
    } as KnowledgeDocumentRecord;
    expect(() => normalizeLlamaIndexContextItem({
      need: {
        needId: "policy",
        logicalAssetId: "current_wealth_policy",
        contextType: "knowledge",
        requiredness: "required",
        purpose: "test",
        freshness: { mode: "current_effective" },
      },
      binding,
      document,
      retrieved: { documentId: document.publicId, documentVersion: "V2.1", position: "正文" },
      asOf: "2026-08-21T00:00:00.000Z",
    })).toThrow("version does not match");
  });
});
