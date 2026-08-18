import { describe, expect, it } from "vitest";
import { roleDisplayName, roleExperience, selectRoleHomeTaskIds, skillTrialPrompt } from "./role-experience";

describe("roleExperience", () => {
  it.each([
    ["wealth-manager", "WM-GT-01"],
    ["insurance-advisor", "IA-GT-01"],
    ["post-loan-risk-control", "RC-GT-01"],
  ])("keeps %s starters aligned with its reference task prefix", (role, taskPrefix) => {
    const experience = roleExperience(role);
    expect(experience.maturity).toBe("reference");
    expect(experience.tasks[0]?.id).toBe(taskPrefix);
    expect(experience.taskSlots).toHaveLength(4);
  });

  it("keeps the audit role operational until its benchmark pack is complete", () => {
    expect(roleExperience("credential-compliance").maturity).toBe("operational");
  });

  it("keeps runtime dependencies out of the presentation adapter", () => {
    const serialized = JSON.stringify(roleExperience("wealth-manager"));
    expect(serialized).not.toContain("requiredConnectorIds");
    expect(roleExperience("wealth-manager").taskSlots[3]).toEqual(["WM-GT-05", "WM-GT-06"]);
  });

  it("uses the read-only fallback task until runtime readiness is available", () => {
    expect(selectRoleHomeTaskIds("wealth-manager", [])[3]).toBe("WM-GT-06");
  });

  it("falls back to the general assistant and exposes stable labels", () => {
    expect(roleExperience("unknown-role").roleTemplate).toBe("general-assistant");
    expect(roleDisplayName("post-loan-risk-control")).toBe("风控经理");
    expect(skillTrialPrompt("客户审核")).toContain("客户审核");
  });
});
