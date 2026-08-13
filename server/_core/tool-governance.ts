import { createHash } from "node:crypto";

export type ToolSideEffect =
  | "read"
  | "compute"
  | "workspace_write"
  | "write"
  | "external_send"
  | "financial_action"
  | "approval_action"
  | "admin_action";

export type ToolGovernanceProfile = {
  tool: string;
  sideEffect: ToolSideEffect;
  policyRequired: boolean;
  approvalMode: "never" | "conditional" | "always";
  auditLevel: "normal" | "strong" | "highest";
  idempotencyRequired: boolean;
  source: "registry" | "heuristic" | "default";
  registered: boolean;
};

type GovernanceRule = Omit<ToolGovernanceProfile, "tool" | "source" | "registered"> & {
  exact?: readonly string[];
  prefixes?: readonly string[];
};

export const POLICY_GATED_SIDE_EFFECTS: ReadonlySet<ToolSideEffect> = new Set([
  "write", "external_send", "financial_action", "approval_action", "admin_action",
]);

// Step 2: sandboxed code execution must remain unable to reach business systems.
// Today this is enforced by sandbox network isolation; Policy Core will add an explicit rule.

const RULES: readonly GovernanceRule[] = [
  {
    exact: [
      "glob", "grep", "list_files", "list_skill", "list_skill_experiences",
      "memory_get", "memory_search", "read_file", "read_memory",
      "read_skill_experiences", "search_tools", "todo_get", "todo_list",
      "audio_metadata", "experience_retrieve", "skill_branch_explore", "skill_branch_peek",
      "wiki_lint", "wiki_query",
      "mcp_platform_tools_get_user_channels",
      "mcp_platform_tools_list_available_agents",
      "mcp_platform_tools_list_learned_preferences",
      "mcp_platform_tools_get_wealth_policy_basis",
      "mcp_platform_tools_prepare_wealth_previsit_context",
      "mcp_platform_tools_prepare_wealth_maturity_context",
      "mcp_platform_tools_prepare_wealth_allocation_context",
    ],
    prefixes: ["mcp_wind_", "mcp_market_data__", "mcp_wealth_assistant_"],
    sideEffect: "read",
    policyRequired: false,
    approvalMode: "never",
    auditLevel: "normal",
    idempotencyRequired: false,
  },
  {
    exact: ["mcp_platform_tools_remember_preference", "mcp_platform_tools_forget_preference"],
    sideEffect: "workspace_write",
    policyRequired: false,
    approvalMode: "never",
    auditLevel: "strong",
    idempotencyRequired: false,
  },
  {
    exact: ["mcp_platform_tools_create_scheduled_task"],
    sideEffect: "write",
    policyRequired: true,
    approvalMode: "conditional",
    auditLevel: "strong",
    idempotencyRequired: true,
  },
  {
    exact: ["mcp_platform_tools_submit_agent_task"],
    sideEffect: "external_send",
    policyRequired: true,
    approvalMode: "conditional",
    auditLevel: "strong",
    idempotencyRequired: true,
  },
  {
    prefixes: ["mcp_custom_mcp_gateway_", "mcp_enterprise_mcp_gateway_"],
    sideEffect: "write",
    policyRequired: true,
    approvalMode: "conditional",
    auditLevel: "strong",
    idempotencyRequired: true,
  },
  {
    exact: [
      "ask_user", "audio_question_answering", "generate_image", "load_tools", "skill_tool",
      "task_tool", "video_understanding", "visual_question_answering",
    ],
    sideEffect: "compute",
    policyRequired: false,
    approvalMode: "never",
    auditLevel: "normal",
    idempotencyRequired: false,
  },
  {
    exact: ["bash", "code", "exec_command", "execute_command"],
    sideEffect: "compute",
    policyRequired: true,
    approvalMode: "never",
    auditLevel: "strong",
    idempotencyRequired: false,
  },
  {
    prefixes: ["a2a_", "expert_"],
    sideEffect: "external_send",
    policyRequired: true,
    approvalMode: "conditional",
    auditLevel: "strong",
    idempotencyRequired: false,
  },
  {
    exact: [
      "edit_file", "write_file", "edit_memory", "write_memory", "todo_create",
      "todo_modify", "evolve_review_task", "evolve_skill_experiences",
      "prepare_skill_evolution", "simplify_skill_experiences",
    ],
    sideEffect: "workspace_write",
    policyRequired: false,
    approvalMode: "never",
    auditLevel: "strong",
    idempotencyRequired: false,
  },
] as const;

const READ_ONLY_NAME_RE = /(?:^|[_:.-])(?:read|get|list|query|search|find|lookup|fetch|browse|open|navigate|describe|inspect|status|health|snapshot|quote|preview|download)(?:$|[_:.-])/i;
const ADMIN_NAME_RE = /(?:^|[_:.-])(?:change_policy|configure|admin|grant|revoke|permission)(?:$|[_:.-])/i;
const APPROVAL_NAME_RE = /(?:^|[_:.-])(?:approve|reject|review|authorize)(?:$|[_:.-])/i;
const FINANCIAL_NAME_RE = /(?:^|[_:.-])(?:trade|order|transfer|payment|pay|redeem|subscribe|purchase)(?:$|[_:.-])/i;
const EXTERNAL_SEND_NAME_RE = /(?:^|[_:.-])(?:send|publish|notify|email|mail|webhook|upload|share)(?:$|[_:.-])/i;
const WRITE_NAME_RE = /(?:^|[_:.-])(?:create|update|delete|remove|write|edit|save|submit|cancel|execute|run|modify|set|upsert|insert)(?:$|[_:.-])/i;

function normalizedToolName(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function matchesRule(name: string, rule: GovernanceRule): boolean {
  return Boolean(rule.exact?.includes(name) || rule.prefixes?.some(prefix => name.startsWith(prefix)));
}

function inferredProfile(tool: string, sideEffect: ToolSideEffect): ToolGovernanceProfile {
  const readOnly = sideEffect === "read";
  return {
    tool,
    sideEffect,
    policyRequired: POLICY_GATED_SIDE_EFFECTS.has(sideEffect),
    approvalMode: readOnly ? "never" : "conditional",
    auditLevel: readOnly ? "normal" : "strong",
    idempotencyRequired: ["write", "financial_action", "approval_action", "admin_action"].includes(sideEffect),
    source: "heuristic",
    registered: false,
  };
}

export function resolveToolGovernance(toolName: unknown): ToolGovernanceProfile {
  const tool = normalizedToolName(toolName);
  const rule = RULES.find(candidate => matchesRule(tool, candidate));
  if (rule) {
    return {
      tool,
      sideEffect: rule.sideEffect,
      policyRequired: rule.policyRequired,
      approvalMode: rule.approvalMode,
      auditLevel: rule.auditLevel,
      idempotencyRequired: rule.idempotencyRequired,
      source: "registry",
      registered: true,
    };
  }
  if (ADMIN_NAME_RE.test(tool)) return inferredProfile(tool, "admin_action");
  if (APPROVAL_NAME_RE.test(tool)) return inferredProfile(tool, "approval_action");
  if (FINANCIAL_NAME_RE.test(tool)) return inferredProfile(tool, "financial_action");
  if (EXTERNAL_SEND_NAME_RE.test(tool)) return inferredProfile(tool, "external_send");
  if (WRITE_NAME_RE.test(tool)) return inferredProfile(tool, "write");
  if (READ_ONLY_NAME_RE.test(tool)) return inferredProfile(tool, "read");
  // An unknown non-read action is conservatively treated as a business write.
  return { ...inferredProfile(tool, "write"), source: "default" };
}

export function shouldBlockWithoutPolicyCore(profile: ToolGovernanceProfile): boolean {
  return !profile.registered && POLICY_GATED_SIDE_EFFECTS.has(profile.sideEffect);
}

export function stableToolInputHash(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value, (_key, item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      return Object.keys(item as Record<string, unknown>).sort().reduce((result, key) => {
        result[key] = (item as Record<string, unknown>)[key];
        return result;
      }, {} as Record<string, unknown>);
    }) ?? String(value ?? "");
  } catch {
    serialized = String(value ?? "");
  }
  return createHash("sha256").update(serialized).digest("hex");
}

export const TOOL_GOVERNANCE_REGISTRY = RULES;
