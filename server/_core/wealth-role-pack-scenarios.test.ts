import { describe, expect, it } from "vitest";
import { runWealthRolePackControlledScenarios } from "./wealth-role-pack-scenarios";

describe("wealth role pack controlled scenario runner", () => {
  it("executes all six governed wealth benchmark task paths", async () => {
    const report = await runWealthRolePackControlledScenarios();
    expect(report.status).toBe("PASS");
    expect(report.scenarioExecution).toBe(true);
    expect(report.taskIds).toEqual(["WM-GT-01", "WM-GT-02", "WM-GT-03", "WM-GT-04", "WM-GT-05", "WM-GT-06"]);
    expect(report.passedScenarioCount).toBe(report.scenarioCount);
  });
});
