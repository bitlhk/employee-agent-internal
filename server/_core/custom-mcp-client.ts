import { createHash } from "crypto";
import { Readable } from "stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CustomMcpAuthType, CustomMcpOAuthData, CustomMcpToolSnapshot } from "../db/custom-mcp-connections";
import { safeAgentRequest } from "./safe-agent-http";
import { CustomMcpOAuthProvider } from "./custom-mcp-oauth-provider";

export const MAX_CUSTOM_MCP_CONNECTIONS = 5;
export const MAX_CUSTOM_MCP_SELECTED_TOOLS = 20;
export const MAX_CUSTOM_MCP_DISCOVERED_TOOLS = 100;
const MAX_TOOL_SCHEMA_BYTES = 32 * 1024;
const MAX_ALL_TOOL_SCHEMAS_BYTES = 256 * 1024;
const MAX_TOOL_RESULT_BYTES = 1024 * 1024;
const MCP_REQUEST_TIMEOUT_MS = 60_000;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const BLOCKED_AUTH_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "mcp-session-id",
  "proxy-authorization",
  "transfer-encoding",
  "x-agent-adopt-id",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-internal-key",
  "x-jiuwen-channel-id",
  "x-openclaw-channel-id",
  "x-workforce-agent-adopt-id",
]);

export type CustomMcpEndpointConfig = {
  endpointUrl: string;
  authType: CustomMcpAuthType;
  authHeaderName?: string | null;
  credential?: string;
  oauthData?: CustomMcpOAuthData | null;
  onOAuthDataChanged?: (data: CustomMcpOAuthData) => void | Promise<void>;
};

export function parseCustomMcpEndpoint(rawUrl: unknown): URL {
  const value = String(rawUrl || "").trim();
  if (!value || value.length > 2048) throw new Error("MCP 地址无效");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MCP 地址无效");
  }
  if (url.protocol !== "https:") throw new Error("自定义 MCP 必须使用 HTTPS");
  if (url.username || url.password) throw new Error("请在认证配置中填写凭据");
  if (!url.hostname) throw new Error("MCP 地址缺少主机名");
  for (const key of url.searchParams.keys()) {
    if (/token|secret|password|api[-_]?key|access[-_]?key/i.test(key)) {
      throw new Error("MCP 地址不能包含明文凭据，请使用认证配置");
    }
  }
  url.hash = "";
  return url;
}

export function validateCustomMcpAuth(config: CustomMcpEndpointConfig): void {
  if (!(["none", "bearer", "api_key", "oauth"] as string[]).includes(config.authType)) {
    throw new Error("不支持的认证方式");
  }
  if (config.authType === "none") return;
  if (config.authType === "oauth") {
    if (!config.oauthData?.tokens || !config.oauthData.clientInformation || !config.oauthData.redirectUrl) {
      throw new Error("OAuth 授权尚未完成");
    }
    return;
  }
  if (!String(config.credential || "").trim()) throw new Error("请填写认证凭据");
  if (config.authType === "bearer") return;
  const headerName = String(config.authHeaderName || "").trim();
  if (!HEADER_NAME_RE.test(headerName)) throw new Error("API Key Header 名称无效");
  if (BLOCKED_AUTH_HEADERS.has(headerName.toLowerCase()) || headerName.toLowerCase() === "authorization") {
    throw new Error("该 Header 不允许用于自定义 MCP 认证");
  }
}

function authHeaders(config: CustomMcpEndpointConfig): Record<string, string> {
  validateCustomMcpAuth(config);
  if (config.authType === "bearer") {
    return { Authorization: `Bearer ${String(config.credential || "").trim()}` };
  }
  if (config.authType === "api_key") {
    return { [String(config.authHeaderName)]: String(config.credential || "").trim() };
  }
  return {};
}

async function bodyBuffer(body: BodyInit | null | undefined): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof Blob !== "undefined" && body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  throw new Error("MCP 请求体格式不受支持");
}

function requestHeaders(headersInit?: HeadersInit): Record<string, string> {
  const result: Record<string, string> = {};
  const headers = new Headers(headersInit || {});
  headers.forEach((value, name) => {
    if (BLOCKED_AUTH_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== "mcp-session-id") return;
    result[name] = value;
  });
  return result;
}

function responseHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

export function safeMcpFetch(timeoutMs = MCP_REQUEST_TIMEOUT_MS) {
  return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = parseCustomMcpEndpoint(String(input));
    const response = await safeAgentRequest(url.toString(), {
      method: init.method || "GET",
      headers: requestHeaders(init.headers),
      body: await bodyBuffer(init.body),
      signal: init.signal || undefined,
      timeoutMs,
      allowPrivate: false,
      privateHostAllowlist: new Set(),
    });
    const status = response.status;
    const noBody = status === 204 || status === 205 || status === 304;
    return new Response(noBody ? null : Readable.toWeb(response.body) as ReadableStream, {
      status,
      headers: responseHeaders(response.headers),
    });
  };
}

async function withMcpClient<T>(config: CustomMcpEndpointConfig, run: (client: Client) => Promise<T>): Promise<T> {
  const url = parseCustomMcpEndpoint(config.endpointUrl);
  validateCustomMcpAuth(config);
  const authProvider = config.authType === "oauth" && config.oauthData
    ? new CustomMcpOAuthProvider({ data: config.oauthData, onDataChanged: config.onOAuthDataChanged })
    : undefined;
  const transport = new StreamableHTTPClientTransport(url, {
    ...(authProvider ? { authProvider } : { requestInit: { headers: authHeaders(config) } }),
    fetch: safeMcpFetch(),
    reconnectionOptions: {
      maxReconnectionDelay: 1_000,
      initialReconnectionDelay: 250,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 0,
    },
  });
  const client = new Client({ name: "employee-agent-custom-mcp", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport, { timeout: MCP_REQUEST_TIMEOUT_MS });
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeTool(raw: any): CustomMcpToolSnapshot {
  const name = String(raw?.name || "").trim();
  if (!name || name.length > 256) throw new Error("远程 MCP 返回了无效工具名");
  const inputSchema = plainObject(raw?.inputSchema) || { type: "object", properties: {} };
  const normalized: CustomMcpToolSnapshot = {
    name,
    description: String(raw?.description || "").trim().slice(0, 2_000),
    inputSchema,
  };
  const outputSchema = plainObject(raw?.outputSchema);
  const annotations = plainObject(raw?.annotations);
  if (outputSchema) normalized.outputSchema = outputSchema;
  if (annotations) normalized.annotations = annotations;
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_TOOL_SCHEMA_BYTES) {
    throw new Error(`工具 ${name} 的定义过大`);
  }
  return normalized;
}

export async function discoverCustomMcpTools(config: CustomMcpEndpointConfig): Promise<CustomMcpToolSnapshot[]> {
  return await withMcpClient(config, async (client) => {
    const result = await client.listTools(undefined, { timeout: MCP_REQUEST_TIMEOUT_MS });
    if (!Array.isArray(result.tools)) throw new Error("远程 MCP 未返回工具列表");
    if (result.tools.length > MAX_CUSTOM_MCP_DISCOVERED_TOOLS) {
      throw new Error(`远程 MCP 工具超过 ${MAX_CUSTOM_MCP_DISCOVERED_TOOLS} 个，请拆分连接`);
    }
    const seen = new Set<string>();
    const tools = result.tools.map(normalizeTool).filter((tool) => {
      if (seen.has(tool.name)) return false;
      seen.add(tool.name);
      return true;
    });
    if (Buffer.byteLength(JSON.stringify(tools)) > MAX_ALL_TOOL_SCHEMAS_BYTES) {
      throw new Error("远程 MCP 工具定义总量过大");
    }
    return tools;
  });
}

export async function callCustomMcpTool(
  config: CustomMcpEndpointConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await withMcpClient(config, async (client) => (
    await client.callTool({ name, arguments: args }, undefined, { timeout: MCP_REQUEST_TIMEOUT_MS })
  ));
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_TOOL_RESULT_BYTES) {
    return {
      isError: true,
      content: [{ type: "text", text: "远程 MCP 返回内容超过 1MB，已停止传输。请缩小查询范围。" }],
    };
  }
  return result as Record<string, unknown>;
}

export function customMcpGatewayToolName(connectionId: number, remoteToolName: string): string {
  const prefix = `custom_${connectionId}_`;
  const safeName = remoteToolName.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
  const digest = createHash("sha256").update(remoteToolName).digest("hex").slice(0, 8);
  return `${prefix}${safeName.slice(0, Math.max(1, 120 - prefix.length))}_${digest}`.slice(0, 128);
}
