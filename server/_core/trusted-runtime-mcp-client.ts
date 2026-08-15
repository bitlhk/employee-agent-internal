import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CustomMcpToolSnapshot } from "../db/custom-mcp-connections";
import { safeAgentRequest } from "./safe-agent-http";

const MAX_TOOL_RESULT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const BLOCKED_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "proxy-authorization",
  "transfer-encoding",
  "x-agent-adopt-id",
  "x-ea-runtime-token",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-internal-key",
  "x-jiuwen-channel-id",
]);

export type TrustedRuntimeMcpConfig = {
  endpointUrl: string;
  headers: Record<string, string>;
  timeoutMs?: number;
};

function endpoint(raw: string): URL {
  const url = new URL(String(raw || "").trim());
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error("岗位 MCP 地址无效");
  }
  url.hash = "";
  return url;
}

function normalizedHeaders(input: HeadersInit | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  const headers = new Headers(input || {});
  headers.forEach((value, name) => {
    if (BLOCKED_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== "mcp-session-id") return;
    output[name] = value;
  });
  return output;
}

function responseHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

async function bodyBuffer(body: BodyInit | null | undefined): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof Blob !== "undefined" && body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  throw new Error("岗位 MCP 请求体格式不受支持");
}

function trustedFetch(config: TrustedRuntimeMcpConfig, timeoutMs: number) {
  const configured = endpoint(config.endpointUrl);
  const privateHostAllowlist = new Set<string>();
  if (["localhost", "127.0.0.1", "::1"].includes(configured.hostname.toLowerCase())) {
    privateHostAllowlist.add(configured.hostname.toLowerCase());
  }
  for (const host of String(process.env.EA_TRUSTED_RUNTIME_MCP_PRIVATE_HOSTS || "")
    .split(",").map((item) => item.trim().toLowerCase()).filter(Boolean)) {
    privateHostAllowlist.add(host);
  }
  return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const target = endpoint(String(input));
    if (target.origin !== configured.origin) throw new Error("岗位 MCP 不允许跨来源重定向");
    const response = await safeAgentRequest(target.toString(), {
      method: init.method || "GET",
      headers: {
        ...config.headers,
        ...normalizedHeaders(init.headers),
      },
      body: await bodyBuffer(init.body),
      signal: init.signal || undefined,
      timeoutMs,
      allowPrivate: privateHostAllowlist.has(target.hostname.toLowerCase()),
      privateHostAllowlist,
    });
    const noBody = [204, 205, 304].includes(response.status);
    return new Response(noBody ? null : Readable.toWeb(response.body) as ReadableStream, {
      status: response.status,
      headers: responseHeaders(response.headers),
    });
  };
}

async function withClient<T>(config: TrustedRuntimeMcpConfig, action: (client: Client) => Promise<T>): Promise<T> {
  const url = endpoint(config.endpointUrl);
  const timeoutMs = Number.isFinite(config.timeoutMs)
    ? Math.min(120_000, Math.max(1_000, Math.floor(Number(config.timeoutMs))))
    : DEFAULT_TIMEOUT_MS;
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: config.headers },
    fetch: trustedFetch(config, timeoutMs),
    reconnectionOptions: {
      maxReconnectionDelay: 1_000,
      initialReconnectionDelay: 250,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 0,
    },
  });
  const client = new Client({ name: "employee-agent-role-mcp", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport, { timeout: timeoutMs });
    return await action(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function normalizeTool(value: unknown): CustomMcpToolSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const name = String(row.name || "").trim();
  if (!name || name.length > 256) return null;
  const inputSchema = row.inputSchema && typeof row.inputSchema === "object" && !Array.isArray(row.inputSchema)
    ? row.inputSchema as Record<string, unknown>
    : { type: "object", properties: {} };
  return {
    name,
    description: String(row.description || "").trim().slice(0, 2_000),
    inputSchema,
    ...(row.outputSchema && typeof row.outputSchema === "object" && !Array.isArray(row.outputSchema)
      ? { outputSchema: row.outputSchema as Record<string, unknown> }
      : {}),
    ...(row.annotations && typeof row.annotations === "object" && !Array.isArray(row.annotations)
      ? { annotations: row.annotations as Record<string, unknown> }
      : {}),
  };
}

export async function discoverTrustedRuntimeMcpTools(config: TrustedRuntimeMcpConfig): Promise<CustomMcpToolSnapshot[]> {
  return await withClient(config, async (client) => {
    const result = await client.listTools(undefined, { timeout: config.timeoutMs || DEFAULT_TIMEOUT_MS });
    return (Array.isArray(result.tools) ? result.tools : [])
      .map(normalizeTool)
      .filter((tool): tool is CustomMcpToolSnapshot => Boolean(tool))
      .slice(0, 128);
  });
}

export async function callTrustedRuntimeMcpTool(
  config: TrustedRuntimeMcpConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await withClient(config, async (client) => (
    await client.callTool({ name, arguments: args }, undefined, { timeout: config.timeoutMs || DEFAULT_TIMEOUT_MS })
  ));
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_TOOL_RESULT_BYTES) {
    return {
      isError: true,
      content: [{ type: "text", text: "岗位 MCP 返回内容超过 1MB，已停止传输。请缩小查询范围。" }],
    };
  }
  return result as Record<string, unknown>;
}
