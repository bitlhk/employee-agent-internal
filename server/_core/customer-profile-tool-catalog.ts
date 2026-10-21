
export const PROFILE_TOOL_NAME = "get_customer_profile";

export const LEGACY_PROFILE_TOOL_NAME = "get_governed_customer_profile";

export const PROFILE_TOOL = {
  name: PROFILE_TOOL_NAME,
  description: [
    "Return the governed customer_profile projection for the current signed Runtime Principal.",
    "The role and purpose are derived from trusted runtime identity and cannot be selected by tool arguments.",
    "A blocked result contains no customer field values.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      customer_id: {
        type: "string",
        description:
          "Stable enterprise customer subject id already selected in the current authorized workflow.",
      },
      customer_name: {
        type: "string",
        description:
          "Optional source locator for legacy providers; never accepted as identity proof.",
      },
      task_id: {
        type: "string",
        description:
          "Optional Golden Task or governed task id used to apply task-required fields.",
      },
    },
    required: ["customer_id"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
  },
};

export const DIRECTORY_TOOL = {
  name: "search_customers",
  description: [
    "Search customers within the current signed Runtime Principal's authorized directory.",
    "Dedicated customers are returned before shared demo customers.",
    "Use scope=assigned when the user asks for customers they personally own or when selecting a preferred CRM write target.",
    "The role, organization and service scope are derived from trusted runtime identity.",
    "Use the returned stable customer_id in subsequent customer tools.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Optional customer id or display-name query.",
      },
      scope: {
        type: "string",
        enum: ["all", "assigned", "demo_public"],
        default: "all",
        description:
          "all returns dedicated and shared demo customers; assigned returns only dedicated customers; demo_public returns the shared demo pool.",
      },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      offset: { type: "integer", minimum: 0, maximum: 10000, default: 0 },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
};

export const PORTFOLIO_TOOL = {
  name: "get_customer_portfolio",
  description: [
    "Return the governed wealth portfolio projection for an authorized customer.",
    "Raw customer biography, contact details and upstream recommendations are excluded.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      customer_id: {
        type: "string",
        description: "Stable customer id returned by search_customers.",
      },
      task_id: { type: "string", description: "Optional governed task id." },
    },
    required: ["customer_id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
};

export const LEGACY_TOOLS = {
  [LEGACY_PROFILE_TOOL_NAME]: {
    ...PROFILE_TOOL,
    name: LEGACY_PROFILE_TOOL_NAME,
    description:
      "Compatibility alias for get_customer_profile. New Skills must use get_customer_profile.",
  },
  wealth_assistant_context_probe: {
    name: "wealth_assistant_context_probe",
    description:
      "Compatibility readiness probe. New Skills should use the canonical customer tools directly.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  wealth_assistant_customer_list: {
    name: "wealth_assistant_customer_list",
    description:
      "Compatibility alias for search_customers. New Skills must use search_customers.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
        query: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  wealth_assistant_customer_detail: {
    name: "wealth_assistant_customer_detail",
    description:
      "Compatibility projection combining governed profile and portfolio. New Skills must use get_customer_profile and get_customer_portfolio.",
    inputSchema: {
      type: "object",
      properties: {
        customerId: { type: "string" },
        customer_id: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  list_customer_profiles: {
    name: "list_customer_profiles",
    description:
      "Compatibility alias for search_customers. New Skills must use search_customers.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
        offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  get_customer_profile_by_name: {
    name: "get_customer_profile_by_name",
    description:
      "Compatibility lookup that resolves a stable customer id before get_customer_profile. New Skills must use stable ids.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
} as const;

export const TOOL_BY_NAME = new Map<string, Record<string, unknown>>([
  [DIRECTORY_TOOL.name, DIRECTORY_TOOL],
  [PROFILE_TOOL.name, PROFILE_TOOL],
  [PORTFOLIO_TOOL.name, PORTFOLIO_TOOL],
  ...Object.entries(LEGACY_TOOLS),
]);
