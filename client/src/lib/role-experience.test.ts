import { describe, expect, it } from "vitest";
import { roleDisplayName, roleExperience, skillTrialPrompt } from "./role-experience";

describe("roleExperience", () => {
  it.each([
    ["wealth-manager", "WM-GT-01"],
    ["insurance-advisor", "IA-GT-01"],
    ["post-loan-risk-control", "RC-GT-01"],
  ])("keeps %s starters aligned with its reference task prefix", (role, taskPrefix) => {
    const experience = roleExperience(role);
    expect(experience.maturity).toBe("reference");
    expect(experience.tasks[0]?.id).toBe(taskPrefix);
    expect(experience.tasks).toHaveLength(4);
  });

  it("keeps the audit role operational until its benchmark pack is complete", () => {
    expect(roleExperience("credential-compliance").maturity).toBe("operational");
  });

  it("does not model built-in platform tools as external connector dependencies", () => {
    const referenceRoles = ["wealth-manager", "post-loan-risk-control"];
    for (const role of referenceRoles) {
      for (const task of roleExperience(role).tasks) {
        expect(task.requiredConnectorIds ?? []).not.toContain("platform_tools");
      }
    }

    const wealthTasks = roleExperience("wealth-manager").tasks;
    expect(wealthTasks.find((task) => task.id === "WM-GT-03")?.requiredConnectorIds).toBeUndefined();
    expect(wealthTasks.find((task) => task.id === "WM-GT-04")?.requiredConnectorIds).toEqual([
      "wealth_assistant_customer",
      "wealth_assistant_product",
    ]);
  });

  it("falls back to the general assistant and exposes stable labels", () => {
    expect(roleExperience("unknown-role").roleTemplate).toBe("general-assistant");
    expect(roleDisplayName("post-loan-risk-control")).toBe("风控经理");
    expect(skillTrialPrompt("客户审核")).toContain("客户审核");
  });
});
