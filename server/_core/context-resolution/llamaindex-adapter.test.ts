import { describe, expect, it } from "vitest";
import type { KnowledgeBaseRecord } from "../../db";
import type { ContextSourceBindingV1 } from "../../../shared/context-resolution";
import { llamaIndexKnowledgeBaseId, selectLlamaIndexKnowledgeBases } from "./llamaindex-adapter";

const binding: ContextSourceBindingV1 = {
  schema: "ea.context-source-binding.v1",
  bindingId: "wealth-policy",
  organizationId: "org-a",
  rolePackId: "linggan-bank.wealth-manager",
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
});

