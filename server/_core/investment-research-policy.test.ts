import { describe, expect, it } from "vitest";
import {
  evaluateInvestmentResearchDataAssurance,
  evaluateInvestmentResearchOutputBoundary,
} from "./investment-research-policy";

describe("investment research deterministic policy", () => {
  it("allows a complete authorized research data set", () => {
    const decision = evaluateInvestmentResearchDataAssurance({
      roleTemplate: "investment-researcher",
      securityId: "600000.SH",
      sourceSystem: "wind_stock_data",
      dataAsOf: "2026-08-18T01:00:00.000Z",
      requiredDimensions: ["price", "financials"],
      availableDimensions: ["financials", "price"],
      sourceAuthorized: true,
      comparable: true,
    });
    expect(decision.status).toBe("ready");
    expect(decision.formalResearchAllowed).toBe(true);
    expect(decision.decisionId).toMatch(/^ird_/);
  });

  it("degrades rather than inventing a missing comparable dimension", () => {
    const decision = evaluateInvestmentResearchDataAssurance({
      roleTemplate: "investment-researcher",
      securityId: "600000.SH",
      sourceSystem: "wind_stock_data",
      dataAsOf: "2026-08-18T01:00:00.000Z",
      requiredDimensions: ["price", "cash_flow"],
      availableDimensions: ["price"],
      sourceAuthorized: true,
      comparable: false,
    });
    expect(decision.status).toBe("degraded");
    expect(decision.missingDimensions).toEqual(["cash_flow"]);
    expect(decision.deniedOutcomes).toContain("formal_research_conclusion");
  });

  it("blocks an unauthorized source or role", () => {
    const decision = evaluateInvestmentResearchDataAssurance({
      roleTemplate: "general-assistant",
      securityId: "600000.SH",
      sourceSystem: "unapproved-feed",
      dataAsOf: "invalid",
      requiredDimensions: ["price"],
      availableDimensions: ["price"],
      sourceAuthorized: false,
      comparable: true,
    });
    expect(decision.status).toBe("blocked");
    expect(decision.reasons).toContain("ROLE_NOT_AUTHORIZED");
    expect(decision.reasons).toContain("SOURCE_NOT_AUTHORIZED");
  });

  it("blocks trade execution, return promises and suitability bypass", () => {
    const decision = evaluateInvestmentResearchOutputBoundary({
      roleTemplate: "investment-researcher",
      requestedOutcome: "personalized_product_recommendation",
      automaticTradeRequested: true,
      containsReturnPromise: true,
      personalizedRecommendationRequested: true,
      hasCustomerSuitabilityContext: false,
    });
    expect(decision.status).toBe("blocked");
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining([
      "AUTOMATIC_TRADE_PROHIBITED",
      "RETURN_PROMISE_PROHIBITED",
      "CUSTOMER_SUITABILITY_CONTEXT_REQUIRED",
    ]));
  });

  it("allows an internal research memo without execution", () => {
    const first = evaluateInvestmentResearchOutputBoundary({
      roleTemplate: "investment-researcher",
      requestedOutcome: "internal_research_memo",
      automaticTradeRequested: false,
      containsReturnPromise: false,
      personalizedRecommendationRequested: false,
      hasCustomerSuitabilityContext: false,
    });
    const second = evaluateInvestmentResearchOutputBoundary({
      roleTemplate: "investment-researcher",
      requestedOutcome: "internal_research_memo",
      automaticTradeRequested: false,
      containsReturnPromise: false,
      personalizedRecommendationRequested: false,
      hasCustomerSuitabilityContext: false,
    });
    expect(first.status).toBe("ready");
    expect(first.decisionId).toBe(second.decisionId);
  });
});
