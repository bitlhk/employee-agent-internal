import { afterEach, describe, expect, it } from "vitest";
import type { ContextSourceBindingV1 } from "../../../shared/context-resolution";
import { resolveMcpBindingTarget } from "./mcp-adapter";

function binding(resourceRef: string, providerType: ContextSourceBindingV1["providerType"] = "mcp"): ContextSourceBindingV1 {
  return {
    schema: "ea.context-source-binding.v1",
    bindingId: "ctxb-customer",
    organizationId: "org-a",
    rolePackId: "linggan-bank.wealth-manager",
    logicalAssetId: "customer_profile",
    contextType: "business_data",
    providerType,
    resourceRef,
    capabilities: ["point_read"],
    bindingVersion: "1",
    stage: "production",
    status: "active",
  };
}

describe("MCP Context binding adapter", () => {
  afterEach(() => delete process.env.WEALTH_CUSTOMER_MCP_URL);

  it("maps a logical service reference through deployment configuration", () => {
    process.env.WEALTH_CUSTOMER_MCP_URL = "http://wealth-customer.internal/mcp";
    expect(resolveMcpBindingTarget(binding("mcp://wealth-customer/wealth_assistant_customer_detail"))).toEqual({
      endpointUrl: "http://wealth-customer.internal/mcp",
      toolName: "wealth_assistant_customer_detail",
    });
  });

  it("rejects unknown services and non-MCP bindings", () => {
    expect(() => resolveMcpBindingTarget(binding("mcp://unknown/tool_name"))).toThrow(/unsupported/);
    expect(() => resolveMcpBindingTarget(binding("kb://kb_wealth_policy_01", "llamaindex"))).toThrow(/not backed by MCP/);
  });
});
