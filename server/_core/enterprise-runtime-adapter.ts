import { createHash } from "node:crypto";
import type { RuntimeAgentBinding } from "../../drizzle/schema";
import { getRuntimeAgentBinding } from "../db/runtime-agent-bindings";
import type { JiuwenInteractionAnswer, JiuwenSelectedSkillMetadata } from "./jiuwenclaw-bridge";

export type EnterpriseRuntimeRoute = {
  profile: "enterprise_canary" | "enterprise";
  gatewayTarget: string;
  wsUrl: string;
  binding: RuntimeAgentBinding;
};

export type RuntimeRouteDecision =
  | { target: "standalone"; reason: string }
  | { target: "enterprise"; route: EnterpriseRuntimeRoute };

export type EnterpriseManagedMcpProvisioning = {
  fingerprint: string;
  params: Record<string, unknown>;
};

const MANAGED_MCP_SERVERS = [
  ["platform_tools", "/api/internal/platform-tools/mcp", "urn:ea:internal-mcp:platform-tools"],
  ["custom_mcp_gateway", "/api/internal/custom-mcp/mcp", "urn:ea:internal-mcp:custom-mcp"],
  ["enterprise_mcp_gateway", "/api/internal/enterprise-mcp/mcp", "urn:ea:internal-mcp:enterprise-mcp"],
] as const;

function enterpriseRuntimeEnabled(): boolean {
  return String(process.env.EA_ENTERPRISE_RUNTIME_ENABLED || "").trim().toLowerCase() === "true";
}

function normalizeRuntimeMode(value: unknown): "agent.fast" | "agent.plan" | "team" {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "plan" || mode === "agent.plan") return "agent.plan";
  if (mode === "team" || mode === "code.team") return "team";
  return "agent.fast";
}

function enterpriseGatewayWsUrl(): string | null {
  const raw = String(process.env.EA_ENTERPRISE_RUNTIME_GATEWAY_WS_URL || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function enterpriseManagedMcpBaseUrl(): string | null {
  const raw = String(process.env.EA_ENTERPRISE_RUNTIME_EA_BASE_URL || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.pathname = url.pathname.replace(/\/$/, "") || "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function buildEnterpriseManagedMcpProvisioning(args: {
  route: EnterpriseRuntimeRoute;
  adoptId: string;
  agentId: string;
}): EnterpriseManagedMcpProvisioning | null {
  const baseUrl = enterpriseManagedMcpBaseUrl();
  if (!baseUrl) return null;
  const mcpServers = Object.fromEntries(MANAGED_MCP_SERVERS.map(([name, pathname, audience]) => [
    name,
    {
      name,
      description: "EA governed capability gateway",
      type: "streamableHttp",
      url: new URL(pathname, `${baseUrl}/`).toString(),
      auth_headers: {
        "x-ea-runtime-token-audience": audience,
        "x-linggan-agent-id": args.agentId,
        "x-jiuwen-channel-id": args.adoptId,
      },
    },
  ]));
  const mcpJson = JSON.stringify({ mcpServers });
  const fingerprint = createHash("sha256")
    .update(`${args.route.binding.bindingId}\0${mcpJson}`)
    .digest("hex");
  return {
    fingerprint,
    params: {
      group_id: args.route.binding.runtimeGroupId,
      bot_id: args.route.binding.runtimeBotId,
      user_id: args.route.binding.runtimeUserId,
      mcp_json: mcpJson,
    },
  };
}

export async function resolveEnterpriseRuntimeRoute(
  adoptionId: string,
  dependencies: {
    getBinding?: typeof getRuntimeAgentBinding;
  } = {},
): Promise<RuntimeRouteDecision> {
  if (!enterpriseRuntimeEnabled()) {
    return { target: "standalone", reason: "enterprise_runtime_disabled" };
  }
  const wsUrl = enterpriseGatewayWsUrl();
  if (!wsUrl) {
    return { target: "standalone", reason: "enterprise_gateway_not_configured" };
  }
  const binding = await (dependencies.getBinding || getRuntimeAgentBinding)(adoptionId);
  if (!binding) {
    return { target: "standalone", reason: "enterprise_binding_missing" };
  }
  if (binding.status !== "ready") {
    return { target: "standalone", reason: `enterprise_binding_${binding.status}` };
  }
  if (binding.runtimeProfile !== "enterprise_canary" && binding.runtimeProfile !== "enterprise") {
    return { target: "standalone", reason: "enterprise_profile_not_selected" };
  }
  return {
    target: "enterprise",
    route: {
      profile: binding.runtimeProfile,
      gatewayTarget: binding.gatewayTarget,
      wsUrl,
      binding,
    },
  };
}

export function buildEnterpriseChatParams(args: {
  route: EnterpriseRuntimeRoute;
  sessionId: string;
  message: string;
  adoptId: string;
  agentId: string;
  runtimeMode?: unknown;
  selectedSkills?: JiuwenSelectedSkillMetadata[];
}): Record<string, unknown> {
  const { binding } = args.route;
  const selectedSkills = (args.selectedSkills || []).slice(0, 8).map((skill) => ({
    id: skill.id,
    name: String(skill.name || skill.id),
    description: String(skill.description || ""),
  }));
  return {
    session_id: args.sessionId,
    content: args.message,
    query: args.message,
    mode: normalizeRuntimeMode(args.runtimeMode || process.env.JIUWENCLAW_DEFAULT_MODE),
    group_id: binding.runtimeGroupId,
    bot_id: binding.runtimeBotId,
    user_id: binding.runtimeUserId,
    interactive_ask: true,
    request_metadata: {
      source_channel: args.adoptId,
      ea_managed_runtime: true,
      ea_binding_id: binding.bindingId,
      ea_source_agent_id: args.agentId,
      ...(selectedSkills.length ? { selected_skills: selectedSkills } : {}),
    },
  };
}

export function buildEnterprisePermissionAnswerParams(args: {
  route: EnterpriseRuntimeRoute;
  sessionId: string;
  permissionRequestId: string;
  selectedOption: string;
  answers?: JiuwenInteractionAnswer[];
  source?: string;
  runtimeMode?: unknown;
}): Record<string, unknown> {
  const source = String(args.source || "permission_interrupt").trim() || "permission_interrupt";
  return {
    ...buildEnterpriseChatParams({
      route: args.route,
      sessionId: args.sessionId,
      message: "",
      adoptId: args.route.binding.adoptionId,
      agentId: args.route.binding.runtimeAgentId,
      runtimeMode: args.runtimeMode,
    }),
    request_id: args.permissionRequestId,
    answers: args.answers?.length
      ? args.answers.map((answer) => ({
          selected_options: answer.selectedOptions,
          custom_input: answer.customInput,
        }))
      : [{ selected_options: [args.selectedOption], custom_input: "" }],
    source,
  };
}
