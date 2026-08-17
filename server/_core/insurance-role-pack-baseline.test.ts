import { describe, expect, it } from "vitest";
import { applyInsuranceRolePackBaseline } from "../../scripts/install-insurance-advisor-reference-pack";

describe("insurance advisor role pack baseline", () => {
  it("keeps the telesales Skill but retires its legacy MCP server", () => {
    const baseline = {
      skillRequirements: {
        "insurance-telesales-recommend": {
          servers: {
            insurance_telesales_recommend: ["telesales_analyze_conversation"],
          },
        },
      },
      industries: {
        insurance: {
          roles: {
            "insurance-advisor": {
              defaultSkills: ["insurance-telesales-recommend"],
              optionalSkills: [],
              mcpServers: ["insurance_kb", "insurance_telesales_recommend"],
            },
          },
        },
      },
    };

    applyInsuranceRolePackBaseline(baseline);

    const role = baseline.industries.insurance.roles["insurance-advisor"];
    expect(role.defaultSkills).toContain("insurance-telesales-recommend");
    expect(role.mcpServers).not.toContain("insurance_telesales_recommend");
    expect(baseline.skillRequirements["insurance-telesales-recommend"]).toBeUndefined();
    expect(role.mcpServers).toEqual(expect.arrayContaining([
      "insurance_kb",
      "insurance_customer_profile",
      "insurance_product_exam_points",
      "wealth_governance_demo",
    ]));
  });
});
