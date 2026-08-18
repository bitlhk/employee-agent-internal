import { describe, expect, it } from "vitest";
import { runSmartAuditRolePackControlledScenarios } from "./smart-audit-role-pack-scenarios";

describe("smart audit Reference Role Pack controlled scenarios", () => {
  it("passes all six governed task scenarios", async () => {
    const report = await runSmartAuditRolePackControlledScenarios();
    expect(report.status).toBe("PASS");
    expect(report.scenarioCount).toBe(6);
    expect(report.scenarios.every((scenario) => scenario.status === "PASS")).toBe(true);
  });
});
