import { describe, expect, it } from "vitest";
import { runInvestmentResearchRolePackControlledScenarios } from "./investment-research-role-pack-scenarios";

describe("investment research Reference Role Pack controlled scenarios", () => {
  it("passes all six governed task scenarios", async () => {
    const report = await runInvestmentResearchRolePackControlledScenarios();
    expect(report.status).toBe("PASS");
    expect(report.scenarioCount).toBe(6);
    expect(report.scenarios.every((scenario) => scenario.status === "PASS")).toBe(true);
  });
});
