import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { internalMcpAudience, issueInternalRuntimeToken } from "./internal-runtime-token";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function internalMcpUrl(raw: unknown): URL {
  const url = new URL(String(raw || ""));
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("Internal MCP endpoint must use loopback HTTP");
  }
  return url;
}

export async function callInternalMcpTool(input: {
  endpointUrl: string;
  toolName: string;
  args: Record<string, unknown>;
  agentId: string;
  adoptId: string;
  sessionId?: string;
  timeoutMs?: number;
  runtimeId?: string;
}): Promise<Record<string, unknown>> {
  const timeoutMs = Math.min(60_000, Math.max(1_000, Number(input.timeoutMs || 15_000)));
  const endpoint = internalMcpUrl(input.endpointUrl);
  const audience = internalMcpAudience(endpoint.pathname);
  const authenticatedFetch: typeof globalThis.fetch = async (request, init) => {
    const issued = await issueInternalRuntimeToken({
      runtimeId: input.runtimeId || "employee-agent",
      agentId: input.agentId,
      adoptId: input.adoptId,
      audience,
    });
    const headers = new Headers(request instanceof Request ? request.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.set("authorization", `Bearer ${issued.token}`);
    headers.set("x-linggan-agent-id", input.agentId);
    headers.set("x-agent-adopt-id", input.adoptId);
    headers.set("x-jiuwen-channel-id", input.adoptId);
    if (input.sessionId) headers.set("x-linggan-session-id", input.sessionId);
    return await globalThis.fetch(request, { ...init, headers });
  };
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: authenticatedFetch,
    reconnectionOptions: {
      maxReconnectionDelay: 1_000,
      initialReconnectionDelay: 250,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 0,
    },
  });
  const client = new Client({ name: "employee-agent-internal-mcp", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport, { timeout: timeoutMs });
    return await client.callTool(
      { name: input.toolName, arguments: input.args },
      undefined,
      { timeout: timeoutMs },
    ) as Record<string, unknown>;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function parseInternalMcpJsonResult(result: Record<string, unknown>): Record<string, unknown> {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .filter((item) => item.type === "text")
    .map((item) => String(item.text || ""))
    .join("\n")
    .trim();
  if (!text) throw new Error("Internal MCP returned no JSON text result");
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Internal MCP returned invalid JSON result");
  const payload = parsed as Record<string, unknown>;
  if (payload.ok === false || result.isError === true) {
    throw new Error(String(payload.message || payload.error || payload.errorCode || "Internal MCP call failed"));
  }
  return payload;
}
