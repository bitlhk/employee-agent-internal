import type { RuntimeAgentBinding } from "../../drizzle/schema";
import { getRuntimeAgentBinding } from "../db/runtime-agent-bindings";
import type { JiuwenInteractionAnswer } from "./jiuwenclaw-bridge";

export type EnterpriseRuntimeRoute = {
  profile: "enterprise_canary" | "enterprise";
  gatewayTarget: string;
  wsUrl: string;
  binding: RuntimeAgentBinding;
};

export type RuntimeRouteDecision =
  | { target: "standalone"; reason: string }
  | { target: "enterprise"; route: EnterpriseRuntimeRoute };

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
  runtimeMode?: unknown;
}): Record<string, unknown> {
  const { binding } = args.route;
  return {
    session_id: args.sessionId,
    content: args.message,
    query: args.message,
    mode: normalizeRuntimeMode(args.runtimeMode || process.env.JIUWENCLAW_DEFAULT_MODE),
    group_id: binding.runtimeGroupId,
    bot_id: binding.runtimeBotId,
    user_id: binding.runtimeUserId,
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
