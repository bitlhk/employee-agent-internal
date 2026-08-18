import { describe, expect, it } from "vitest";
import { roleDisplayName, roleExperience, selectRoleHomeTaskIds, skillTrialPrompt } from "./role-experience";

describe("roleExperience", () => {
  it.each([
    ["wealth-manager", "WM-GT-01"],
    ["insurance-advisor", "IA-GT-01"],
    ["post-loan-risk-control", "RC-GT-01"],
    ["credential-compliance", "AU-GT-01"],
    ["investment-researcher", "IR-GT-01"],
  ])("keeps %s starters aligned with its reference task prefix", (role, taskPrefix) => {
    const experience = roleExperience(role);
    expect(experience.maturity).toBe("reference");
    expect(experience.tasks[0]?.id).toBe(taskPrefix);
    expect(experience.taskSlots).toHaveLength(4);
  });

  it.each([
    "wealth-manager",
    "insurance-advisor",
    "post-loan-risk-control",
    "credential-compliance",
    "investment-researcher",
    "general-assistant",
  ])("keeps every %s home reference inside its role presentation contract", (role) => {
    const experience = roleExperience(role);
    const taskIds = new Set(experience.tasks.map((task) => task.id));
    expect(experience.taskSlots.flat().every((taskId) => taskIds.has(taskId))).toBe(true);
    expect(experience.capabilities.every((capability) => (
      capability.taskIds.length > 0 && capability.taskIds.every((taskId) => taskIds.has(taskId))
    ))).toBe(true);
  });

  it("keeps the audit role aligned with its benchmark pack", () => {
    expect(roleExperience("credential-compliance").maturity).toBe("reference");
    expect(roleExperience("credential-compliance").tasks.map((task) => task.id)).toEqual([
      "AU-GT-01", "AU-GT-02", "AU-GT-03", "AU-GT-04", "AU-GT-05", "AU-GT-06",
    ]);
  });

  it("projects all six investment research Golden Tasks", () => {
    expect(roleExperience("investment-researcher").maturity).toBe("reference");
    expect(roleExperience("investment-researcher").tasks.map((task) => task.id)).toEqual([
      "IR-GT-01", "IR-GT-02", "IR-GT-03", "IR-GT-04", "IR-GT-05", "IR-GT-06",
    ]);
  });

  it("keeps runtime dependencies out of the presentation adapter", () => {
    const serialized = JSON.stringify(roleExperience("wealth-manager"));
    expect(serialized).not.toContain("requiredConnectorIds");
    expect(serialized).not.toContain("connectorIds");
    expect(roleExperience("wealth-manager").taskSlots).toEqual([
      ["WM-GT-01"], ["WM-GT-02"], ["WM-GT-06"], ["WM-GT-05"],
    ]);
  });

  it("keeps the four wealth starters stable until runtime readiness is available", () => {
    expect(selectRoleHomeTaskIds("wealth-manager", [])).toEqual([
      "WM-GT-01", "WM-GT-02", "WM-GT-06", "WM-GT-05",
    ]);
  });

  it("falls back to the general assistant and exposes stable labels", () => {
    expect(roleExperience("unknown-role").roleTemplate).toBe("general-assistant");
    expect(roleDisplayName("post-loan-risk-control")).toBe("风控经理");
    expect(skillTrialPrompt("客户审核")).toContain("客户审核");
  });
});
