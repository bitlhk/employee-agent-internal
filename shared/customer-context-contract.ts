export const CUSTOMER_CONTEXT_SERVER_ID = "customer_context";
export const CUSTOMER_CONTEXT_SERVICE_NAME = "customer-context";
export const CUSTOMER_CONTEXT_CONTRACT = "ea.customer-context.v1";
export const CUSTOMER_CONTEXT_DISPLAY_NAME = "客户洞察";
export const CUSTOMER_CONTEXT_ADMIN_NAME = "统一客户数据服务";
export const CUSTOMER_CONTEXT_DESCRIPTION =
  "整合当前岗位获授权的客户信息，为客户分析、服务和业务决策提供依据。";

export const CUSTOMER_CONTEXT_CANONICAL_TOOLS = [
  "search_customers",
  "get_customer_profile",
  "get_customer_portfolio",
] as const;

export const CUSTOMER_CONTEXT_LEGACY_TOOLS = [
  "get_governed_customer_profile",
  "wealth_assistant_context_probe",
  "wealth_assistant_customer_list",
  "wealth_assistant_customer_detail",
  "list_customer_profiles",
  "get_customer_profile_by_name",
] as const;

export type CustomerContextRoleV1 = "wealth-manager" | "insurance-advisor";

export function customerContextCanonicalToolNames(
  roleTemplate: string,
): string[] {
  if (roleTemplate === "wealth-manager")
    return [...CUSTOMER_CONTEXT_CANONICAL_TOOLS];
  if (roleTemplate === "insurance-advisor")
    return ["search_customers", "get_customer_profile"];
  return [];
}

export function customerContextToolNames(roleTemplate: string): string[] {
  if (roleTemplate === "wealth-manager") {
    return [
      ...customerContextCanonicalToolNames(roleTemplate),
      "get_governed_customer_profile",
      "wealth_assistant_context_probe",
      "wealth_assistant_customer_list",
      "wealth_assistant_customer_detail",
    ];
  }
  if (roleTemplate === "insurance-advisor") {
    return [
      ...customerContextCanonicalToolNames(roleTemplate),
      "get_governed_customer_profile",
      "list_customer_profiles",
      "get_customer_profile_by_name",
    ];
  }
  return [];
}

export const CUSTOMER_CONTEXT_ALL_TOOL_NAMES = Array.from(
  new Set([
    ...CUSTOMER_CONTEXT_CANONICAL_TOOLS,
    ...CUSTOMER_CONTEXT_LEGACY_TOOLS,
  ]),
);
