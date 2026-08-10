import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

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
}): Promise<Record<string, unknown>> {
  const timeoutMs = Math.min(60_000, Math.max(1_000, Number(input.timeoutMs || 15_000)));
  const transport = new StreamableHTTPClientTransport(internalMcpUrl(input.endpointUrl), {
    requestInit: {
      headers: {
        "x-linggan-agent-id": input.agentId,
        "x-agent-adopt-id": input.adoptId,
        "x-jiuwen-channel-id": input.adoptId,
        ...(input.sessionId ? { "x-linggan-session-id": input.sessionId } : {}),
      },
    },
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
