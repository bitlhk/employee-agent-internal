import { callCustomMcpTool } from "./custom-mcp-client";
import { callInternalMcpTool } from "./internal-mcp-client";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export type WealthProductSourceCall = {
  endpointUrl: string;
  toolName: string;
  args: Record<string, unknown>;
  agentId: string;
  adoptId: string;
  sessionId?: string;
  timeoutMs?: number;
};

export function wealthProductSourceTransport(
  endpointUrl: string
): "internal_loopback" | "external_https" {
  const endpoint = new URL(String(endpointUrl || "").trim());
  if (endpoint.protocol === "https:") return "external_https";
  if (endpoint.protocol === "http:" && LOOPBACK_HOSTS.has(endpoint.hostname))
    return "internal_loopback";
  throw new Error(
    "Wealth product MCP must use canonical HTTPS or loopback HTTP"
  );
}

export async function callWealthProductSourceTool(
  input: WealthProductSourceCall
): Promise<Record<string, unknown>> {
  const transport = wealthProductSourceTransport(input.endpointUrl);
  if (transport === "external_https") {
    return await callCustomMcpTool(
      {
        endpointUrl: input.endpointUrl,
        authType: "none",
        timeoutMs: input.timeoutMs || 30_000,
      },
      input.toolName,
      input.args
    );
  }
  return await callInternalMcpTool({
    endpointUrl: input.endpointUrl,
    toolName: input.toolName,
    args: input.args,
    agentId: input.agentId,
    adoptId: input.adoptId,
    sessionId: input.sessionId,
    timeoutMs: input.timeoutMs,
  });
}
