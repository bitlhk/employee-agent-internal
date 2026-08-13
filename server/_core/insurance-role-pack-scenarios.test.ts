import { describe, expect, it } from "vitest";
import { runInsuranceRolePackControlledScenarios } from "./insurance-role-pack-scenarios";

describe("insurance advisor controlled Golden Tasks", () => {
  it("passes all six tasks through shared evidence and role assets", async () => {
    const report = await runInsuranceRolePackControlledScenarios();
    expect(report.status, report.errors.join("\n")).toBe("PASS");
    expect(report.scenarioCount).toBe(6);
    expect(report.scenarios.every((scenario) => scenario.status === "PASS")).toBe(true);
    expect(report.scenarios.find((scenario) => scenario.taskId === "IA-GT-01")?.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ assertion: "response_evidence_bundles_read_and_write_stages", passed: true })]),
    );
  });
});
