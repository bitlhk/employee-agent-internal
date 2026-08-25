import { describe, expect, it } from "vitest";
import { assertMarketplaceInstallDoesNotOverrideRoleDefault } from "./skill-market-installation";

describe("Skill marketplace installation policy", () => {
  it("allows an optional marketplace Skill", () => {
    expect(() =>
      assertMarketplaceInstallDoesNotOverrideRoleDefault({
        skillId: "optional-skill",
        roleTemplate: "wealth-manager",
        defaultSkillIds: ["wealth-manager-assistant"],
      })
    ).not.toThrow();
  });

  it("requires the governed role release flow for a role-default Skill", () => {
    expect(() =>
      assertMarketplaceInstallDoesNotOverrideRoleDefault({
        skillId: "wealth-manager-assistant",
        roleTemplate: "wealth-manager",
        defaultSkillIds: ["wealth-manager-assistant"],
      })
    ).toThrow(/governed role-default release flow/);
  });
});
