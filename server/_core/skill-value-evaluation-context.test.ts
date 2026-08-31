import { describe, expect, it } from "vitest";
import {
  buildEaEvaluationScenarioSeed,
  selectDiverseEvaluationCustomers,
} from "./skill-value-evaluation-context";

describe("EA Skill evaluation context adapter", () => {
  it("selects the middle customer first so the scenario is not tied to list order", () => {
    const customers = Array.from({ length: 8 }, (_, index) => ({
      customerId: `C00${index + 1}`,
      displayName: `客户${index + 1}`,
    }));

    expect(selectDiverseEvaluationCustomers(customers, 3).map(item => item.customerId))
      .toEqual(["C005", "C001", "C008"]);
  });

  it("builds a sanitized wealth scenario without contact details", () => {
    const seed = buildEaEvaluationScenarioSeed({
      customerId: "C005",
      displayName: "陈明",
      businessDomain: "wealth",
      profile: {
        status: "READY",
        fields: [
          { path: "contact.maskedPhone", value: "138****8005" },
          { path: "preferences.investmentHorizon", value: "3年以上" },
          { path: "preferences.liquidityNeeds", value: "至少20%高流动性" },
          { path: "risk.investmentRiskLevel", value: "C4" },
          { path: "risk.investmentRiskValidUntil", value: "2027-12-31" },
        ],
        missingRequiredFields: [],
      },
      portfolio: {
        schemaVersion: "ea.customer-portfolio-result.v1",
        contract: "ea.customer-context.v1",
        logicalContextId: "customer_portfolio",
        subjectId: "C005",
        status: "READY",
        summary: { availableCash: 750000, totalAssets: 750000 },
        holdings: [],
        maturities: [],
        sourceEvidence: [],
        generatedAt: "2026-08-31T00:00:00.000Z",
      },
    }, "wealth-manager");

    expect(seed.subject).toEqual({ ref: "C005", label: "陈明" });
    expect(seed.promptFacts).toContain("存在约75万元可用资金");
    expect(seed.promptFacts).toContain("流动性要求：至少20%高流动性");
    expect(seed.verificationFacts).toContain("客户风险等级：C4");
    expect(JSON.stringify(seed)).not.toContain("138");
  });
});
