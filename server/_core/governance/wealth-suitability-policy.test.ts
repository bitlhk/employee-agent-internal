import { describe, expect, it } from "vitest";
import { evaluateGovernance, type RuntimePrincipal } from "./contracts";
import {
  WEALTH_SUITABILITY_RULE_VERSION,
  wealthRiskOrdinal,
  wealthSuitabilityPolicyAdapter,
  wealthSuitabilityUserGuidance,
  type WealthSuitabilityRequestContext,
} from "./wealth-suitability-policy";

const principal: RuntimePrincipal = {
  userId: 7,
  adoptionId: "lgj-wealth",
  agentId: "jiuwen_lgj-wealth",
  roleTemplate: "wealth-manager",
  workspaceId: "/tmp/wealth",
  permissionProfile: "internal",
  sessionId: "session-1",
};

function context(patch: Partial<WealthSuitabilityRequestContext> = {}): WealthSuitabilityRequestContext {
  return {
    customer: {
      customerId: "C-001",
      riskLevel: "C3",
      assessmentStatus: "valid",
      assessmentExpiresAt: "2027-01-01T00:00:00.000Z",
      dataAsOf: "2026-08-10T00:00:00.000Z",
    },
    product: {
      productId: "P-001",
      name: "稳健固收产品",
      riskLevel: "R2",
      status: "on_sale",
      channels: ["branch"],
      minAmount: 100_000,
      termMonths: 24,
      dataAsOf: "2026-08-10T00:00:00.000Z",
    },
    request: { amount: 500_000, horizonMonths: 36, channel: "branch" },
    policySource: {
      ready: true,
      sourceAssetId: "doc-policy-v22",
      versionLabel: "V2.2",
      sourceLocator: "第四条 风险等级匹配",
      eligibilityFingerprint: "a".repeat(64),
    },
    evaluatedAt: "2026-08-10T00:00:00.000Z",
    ...patch,
  };
}

async function evaluate(input: WealthSuitabilityRequestContext, roleTemplate = "wealth-manager") {
  return evaluateGovernance({
    principal: { ...principal, roleTemplate },
    operation: {
      capabilityId: "wealth.product.recommendation",
      operation: "evaluate_candidate",
      sideEffect: "read",
      resource: `product:${input.product.productId}`,
    },
    context: input as unknown as Record<string, unknown>,
  }, [wealthSuitabilityPolicyAdapter(input)], {
    effect: "DENY",
    policyCode: "EA_WEALTH_POLICY_UNAVAILABLE",
    ruleVersion: WEALTH_SUITABILITY_RULE_VERSION,
    reason: "适当性策略不可用。",
    obligations: [{ type: "AUDIT", level: "highest" }],
  });
}

describe("wealth suitability policy", () => {
  it("normalizes both customer C levels and legacy R levels", () => {
    expect(wealthRiskOrdinal("C3")).toBe(3);
    expect(wealthRiskOrdinal("r2")).toBe(2);
    expect(wealthRiskOrdinal("medium")).toBeNull();
  });

  it("allows a complete, currently eligible product candidate", async () => {
    const result = await evaluate(context());
    expect(result).toMatchObject({
      effect: "ALLOW",
      policyCode: "WEALTH_SUITABILITY_MATCH:ELIGIBLE",
      ruleVersion: WEALTH_SUITABILITY_RULE_VERSION,
    });
    expect(result.decisionId).toMatch(/^pdec_/);
  });

  it.each([
    ["risk mismatch", context({ product: { ...context().product, riskLevel: "R4" } }), "RISK_MISMATCH"],
    ["expired assessment", context({ customer: { ...context().customer, assessmentExpiresAt: "2026-01-01T00:00:00.000Z" } }), "ASSESSMENT_EXPIRED"],
    ["missing assessment expiry", context({ customer: { ...context().customer, assessmentExpiresAt: null } }), "ASSESSMENT_EXPIRED"],
    ["stopped product", context({ product: { ...context().product, status: "stopped" } }), "PRODUCT_NOT_SELLABLE"],
    ["wrong channel", context({ request: { ...context().request, channel: "mobile" } }), "CHANNEL_NOT_ALLOWED"],
    ["amount too small", context({ request: { ...context().request, amount: 10_000 } }), "AMOUNT_BELOW_MINIMUM"],
    ["horizon too short", context({ request: { ...context().request, horizonMonths: 12 } }), "HORIZON_TOO_SHORT"],
    ["missing current policy", context({ policySource: { ...context().policySource, ready: false } }), "POLICY_SOURCE_UNAVAILABLE"],
  ])("denies %s deterministically", async (_name, input, reasonCode) => {
    const result = await evaluate(input);
    expect(result.effect).toBe("DENY");
    expect(result.policyCode).toBe(`WEALTH_SUITABILITY_MATCH:${reasonCode}`);
  });

  it("does not let a non-wealth role reuse the adapter", async () => {
    const result = await evaluate(context(), "general-assistant");
    expect(result).toMatchObject({ effect: "DENY", policyCode: "WEALTH_SUITABILITY_MATCH:ROLE_NOT_ALLOWED" });
  });

  it("presents a business reason and recovery action without exposing policy codes", () => {
    expect(wealthSuitabilityUserGuidance(
      "WEALTH_SUITABILITY_MATCH:RISK_MISMATCH",
      "产品风险等级 R4 高于客户风险承受等级 C3。",
    )).toEqual({
      title: "暂不能形成正式推荐",
      reason: "产品风险等级 R4 高于客户风险承受等级 C3。",
      nextStep: "请改选风险等级不高于客户当前有效风险等级的产品。",
      retryable: false,
    });
    expect(wealthSuitabilityUserGuidance(
      "WEALTH_SUITABILITY_MATCH:ASSESSMENT_EXPIRED",
      "客户风险测评已过期。",
    ).nextStep).toContain("更新客户风险测评");
  });
});
