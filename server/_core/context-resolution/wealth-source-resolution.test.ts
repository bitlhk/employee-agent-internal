import { describe, expect, it } from "vitest";
import type { ConcreteContextPlanV1, ContextSourceBindingV1 } from "../../../shared/context-resolution";
import { applyContextResolutionEvidenceOutcomes, contextResolutionEvidence } from "./wealth-source-resolution";

describe("Context resolution evidence", () => {
  it("summarizes needs and hashes physical references", () => {
    const binding: ContextSourceBindingV1 = {
      schema: "ea.context-source-binding.v1",
      bindingId: "ctxb-policy",
      organizationId: "org-a",
      rolePackId: "linggan-bank.wealth-manager",
      bindingScope: "role_pack",
      logicalAssetId: "current_wealth_policy",
      contextType: "knowledge",
      providerType: "llamaindex",
      resourceRef: "kb://kb_wealth_policy_01",
      capabilities: ["metadata_filter"],
      bindingVersion: "1",
      stage: "production",
      status: "active",
    };
    const plan: ConcreteContextPlanV1 = {
      schema: "ea.concrete-context-plan.v1",
      planId: "wealth.policy",
      planVersion: "1",
      taskId: "WM-GT-03",
      rolePackId: binding.rolePackId,
      organizationId: binding.organizationId,
      stage: "production",
      status: "READY",
      resolutions: [{
        need: {
          needId: "policy",
          logicalAssetId: binding.logicalAssetId,
          contextType: binding.contextType,
          requiredness: "required",
          purpose: "current policy",
          freshness: { mode: "current_effective" },
        },
        binding,
        status: "resolved",
      }],
      bindingSnapshotFingerprint: "b".repeat(64),
      resolutionFingerprint: "f".repeat(64),
    };
    const evidence = contextResolutionEvidence([plan]);
    expect(evidence?.needs[0]).toMatchObject({
      logicalAssetId: binding.logicalAssetId,
      bindingId: binding.bindingId,
      providerType: binding.providerType,
    });
    expect(evidence?.needs[0].resourceRefFingerprint).toHaveLength(64);
    expect(JSON.stringify(evidence)).not.toContain(binding.resourceRef);
    expect(evidence?.bindingSnapshotFingerprint).toHaveLength(64);
  });

  it("records safe fulfillment reason codes without discarding the resolved binding", () => {
    const evidence = applyContextResolutionEvidenceOutcomes({
      evidence: {
        schema: "ea.context-resolution-evidence.v1",
        planId: "wealth.policy",
        planVersion: "1",
        taskId: "WM-GT-03",
        status: "READY",
        needs: [{
          logicalAssetId: "current_wealth_policy",
          contextType: "knowledge",
          requiredness: "required",
          resolutionStatus: "resolved",
          bindingId: "ctxb-policy",
          providerType: "llamaindex",
        }],
        bindingSnapshotFingerprint: "b".repeat(64),
        resolutionFingerprint: "f".repeat(64),
      },
      outcomes: [{ logicalAssetId: "current_wealth_policy", usable: false, reasonCode: "NOT_ELIGIBLE" }],
    });
    expect(evidence).toMatchObject({
      status: "BLOCKED",
      needs: [{ resolutionStatus: "missing", reasonCode: "NOT_ELIGIBLE", bindingId: "ctxb-policy" }],
    });
  });
});
