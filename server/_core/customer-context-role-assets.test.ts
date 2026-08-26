import { describe, expect, it } from "vitest";
import { applyCustomerContextBaseline } from "../../scripts/configure-customer-context-role-assets";

describe("Customer Context role asset consolidation", () => {
  it("replaces raw customer MCP grants and preserves legacy Skill tool requirements", () => {
    const baseline = {
      skillRequirements: {
        wealth: { servers: { wealth_assistant_customer: ["wealth_assistant_customer_list"] } },
        insurance: { servers: { insurance_customer_profile: ["list_customer_profiles"] } },
      },
      industries: {
        banking: { roles: { "wealth-manager": { mcpServers: ["platform_tools", "wealth_assistant_customer", "wealth_assistant_product"] } } },
        insurance: { roles: { "insurance-advisor": { mcpServers: ["insurance_kb", "insurance_customer_profile"] } } },
      },
    };

    const result = applyCustomerContextBaseline(baseline);
    expect(result.industries?.banking?.roles?.["wealth-manager"]?.mcpServers).toEqual([
      "platform_tools",
      "customer_context",
      "wealth_assistant_product",
    ]);
    expect(result.industries?.insurance?.roles?.["insurance-advisor"]?.mcpServers).toEqual([
      "insurance_kb",
      "customer_context",
    ]);
    expect(result.skillRequirements?.wealth.servers).toEqual({
      customer_context: ["wealth_assistant_customer_list"],
    });
    expect(result.skillRequirements?.insurance.servers).toEqual({
      customer_context: ["list_customer_profiles"],
    });
  });
});
