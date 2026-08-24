import { describe, expect, it } from "vitest";
import type { ContextNeedV1, ContextSourceBindingV1 } from "../../../shared/context-resolution";
import { buildContextItemV1 } from "./context-item";

describe("ContextItemV1", () => {
  it("normalizes provider output without copying the physical resource reference", () => {
    const need: ContextNeedV1 = {
      needId: "policy",
      logicalAssetId: "current_wealth_policy",
      contextType: "knowledge",
      requiredness: "required",
      purpose: "current policy",
      freshness: { mode: "current_effective" },
    };
    const binding: ContextSourceBindingV1 = {
      schema: "ea.context-source-binding.v1",
      bindingId: "ctxb-policy",
      organizationId: "org-a",
      rolePackId: "linggan-bank.wealth-manager",
      bindingScope: "role_pack",
      logicalAssetId: need.logicalAssetId,
      contextType: need.contextType,
      providerType: "llamaindex",
      resourceRef: "kb://kb_wealth_policy_01",
      capabilities: ["metadata_filter"],
      bindingVersion: "1",
      stage: "production",
      status: "active",
    };
    const item = buildContextItemV1({
      need,
      binding,
      assetId: "wm-suitability-policy-v2.2",
      assetVersion: "V2.2",
      contentHash: "a".repeat(64),
      asOf: "2026-08-20T00:00:00.000Z",
    });
    expect(item).toMatchObject({
      schema: "ea.context-item.v1",
      logicalAssetId: need.logicalAssetId,
      bindingId: binding.bindingId,
      providerType: "llamaindex",
    });
    expect(JSON.stringify(item)).not.toContain(binding.resourceRef);
  });
});
