import { describe, expect, it } from "vitest";
import { runWealthRolePackControlledScenarios } from "./wealth-role-pack-scenarios";

describe("wealth role pack controlled scenario runner", () => {
  it("executes the governed WM-GT-01, WM-GT-03 and WM-GT-04 paths", async () => {
    const report = await runWealthRolePackControlledScenarios();
    expect(report.status).toBe("PASS");
    expect(report.scenarioExecution).toBe(true);
    expect(report.taskIds).toEqual(["WM-GT-01", "WM-GT-03", "WM-GT-04"]);
    expect(report.passedScenarioCount).toBe(report.scenarioCount);
  });
});
