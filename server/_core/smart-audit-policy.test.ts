import { describe, expect, it } from "vitest";
import {
  evaluateAuditHumanReviewGate,
  evaluateAuditRequiredMaterials,
  evaluateAuditRuleVersionEligibility,
} from "./smart-audit-policy";

describe("smart audit deterministic policies", () => {
  it("blocks formal review when required material is missing and returns stable decisions", () => {
    const input = {
      roleTemplate: "credential-compliance",
      requiredMaterialTypes: ["申请表", "身份证明", "收入证明"],
      providedMaterialTypes: ["身份证明", "申请表"],
    };
    const first = evaluateAuditRequiredMaterials(input);
    const second = evaluateAuditRequiredMaterials(input);
    expect(first).toMatchObject({ status: "blocked", missing: ["收入证明"], formalReviewAllowed: false, requiresHumanReview: true });
    expect(first.decisionId).toBe(second.decisionId);
  });

  it("selects the active current rule and excludes the historical version", () => {
    const decision = evaluateAuditRuleVersionEligibility({
      roleTemplate: "credential-compliance",
      asOf: "2026-08-18T00:00:00.000Z",
      candidates: [
        { assetId: "audit-rule-v1", versionLabel: "V1.0", lifecycle: "expired", effectiveAt: "2025-01-01T00:00:00.000Z", expiresAt: "2026-06-30T23:59:59.000Z", applicableRoles: ["credential-compliance"] },
        { assetId: "audit-rule-v2", versionLabel: "V2.0", lifecycle: "active", effectiveAt: "2026-07-01T00:00:00.000Z", applicableRoles: ["credential-compliance"] },
      ],
    });
    expect(decision).toMatchObject({ status: "ready", selectedAssetIds: ["audit-rule-v2"], formalRuleUseAllowed: true });
    expect(decision.excluded).toContainEqual({ assetId: "audit-rule-v1", reason: "LIFECYCLE_NOT_ACTIVE" });
  });

  it("requires high-level human review for critical conflicts and never permits automatic approval", () => {
    const decision = evaluateAuditHumanReviewGate({
      roleTemplate: "credential-compliance",
      criticalMissing: false,
      criticalConflicts: true,
      ruleVersionReady: true,
      imageVerificationUncertain: false,
      highRiskRuleHit: false,
      finalDecisionRequested: true,
    });
    expect(decision).toMatchObject({ status: "blocked", level: "L4", formalOpinionAllowed: false, humanReviewRequired: true });
    expect(decision.deniedOutcomes).toContain("automatic_final_approval");
  });

  it("rejects another role even when all material signals are clean", () => {
    const decision = evaluateAuditRequiredMaterials({
      roleTemplate: "general-assistant",
      requiredMaterialTypes: ["申请表"],
      providedMaterialTypes: ["申请表"],
    });
    expect(decision.status).toBe("blocked");
    expect(decision.formalReviewAllowed).toBe(false);
  });
});
