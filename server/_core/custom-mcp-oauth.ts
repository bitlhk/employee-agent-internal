import { randomBytes } from "crypto";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { CustomMcpOAuthData } from "../db/custom-mcp-connections";
import { discoverCustomMcpTools, parseCustomMcpEndpoint, safeMcpFetch } from "./custom-mcp-client";
import { CustomMcpOAuthProvider } from "./custom-mcp-oauth-provider";

const OAUTH_SESSION_TTL_MS = 10 * 60 * 1000;

export type CustomMcpOAuthCatalogEntry = {
  id: string;
  displayName: string;
  endpointUrl: string;
  scope?: string;
  clientMetadata?: Record<string, unknown>;
};

const OAUTH_CATALOG: Record<string, CustomMcpOAuthCatalogEntry> = {
  jinshuju: {
    id: "jinshuju",
    displayName: "金数据",
    endpointUrl: "https://jinshuju.net/mcp",
    scope: "public profile forms read_entries write_entries",
  },
  notion: {
    id: "notion",
    displayName: "Notion",
    endpointUrl: "https://mcp.notion.com/mcp",
  },
  canva: {
    id: "canva",
    displayName: "Canva 可画",
    endpointUrl: "https://mcp.canva.com/mcp",
  },
  atlassian: {
    id: "atlassian",
    displayName: "Jira · Confluence",
    endpointUrl: "https://mcp.atlassian.com/v1/mcp/authv2",
  },
  yunzhangfang: {
    id: "yunzhangfang",
    displayName: "云账房 AI 开票",
    endpointUrl: "https://super-ai-app.yunzhangfang.com/api/mcp",
    scope: "mcp:visit",
    clientMetadata: { mcp_name: "yzf-invoice-mcp-server" },
  },
};

type PendingOAuthSession = {
  state: string;
  userId: number;
  adoptId: string;
  catalog: CustomMcpOAuthCatalogEntry;
  data: CustomMcpOAuthData;
  provider: CustomMcpOAuthProvider;
  authorizationUrl: string;
  expiresAt: number;
};

const pendingSessions = new Map<string, PendingOAuthSession>();

function removeExpired(now = Date.now()): void {
  for (const [state, session] of pendingSessions) {
    if (session.expiresAt <= now) pendingSessions.delete(state);
  }
}

function catalogEntry(catalogId: string): CustomMcpOAuthCatalogEntry {
  const entry = OAUTH_CATALOG[String(catalogId || "").trim()];
  if (!entry) throw new Error("该连接器尚未开放 OAuth 授权");
  parseCustomMcpEndpoint(entry.endpointUrl);
  return entry;
}

export async function startCustomMcpOAuth(input: {
  userId: number;
  adoptId: string;
  catalogId: string;
  redirectUrl: string;
  oauthData?: CustomMcpOAuthData | null;
}): Promise<{ state: string; authorizationUrl: string; expiresAt: string }> {
  removeExpired();
  const catalog = catalogEntry(input.catalogId);
  const redirectUrl = new URL(input.redirectUrl);
  if (redirectUrl.protocol !== "https:" && redirectUrl.hostname !== "localhost" && redirectUrl.hostname !== "127.0.0.1") {
    throw new Error("OAuth 回调地址必须使用 HTTPS");
  }
  const state = randomBytes(32).toString("base64url");
  const data: CustomMcpOAuthData = {
    ...(input.oauthData || {}),
    redirectUrl: redirectUrl.toString(),
  };
  delete data.tokens;
  let authorizationUrl = "";
  const provider = new CustomMcpOAuthProvider({
    data,
    state,
    clientMetadata: catalog.clientMetadata,
    onRedirect: (url) => { authorizationUrl = url.toString(); },
  });
  const result = await auth(provider, {
    serverUrl: catalog.endpointUrl,
    scope: catalog.scope,
    fetchFn: safeMcpFetch(),
  });
  if (result !== "REDIRECT" || !authorizationUrl) throw new Error("MCP 服务未发起 OAuth 授权");
  const expiresAt = Date.now() + OAUTH_SESSION_TTL_MS;
  pendingSessions.set(state, {
    state,
    userId: input.userId,
    adoptId: input.adoptId,
    catalog,
    data,
    provider,
    authorizationUrl,
    expiresAt,
  });
  return { state, authorizationUrl, expiresAt: new Date(expiresAt).toISOString() };
}

export async function finishCustomMcpOAuth(input: {
  state: string;
  code: string;
  userId: number;
}): Promise<{
  userId: number;
  adoptId: string;
  catalog: CustomMcpOAuthCatalogEntry;
  oauthData: CustomMcpOAuthData;
  tools: Awaited<ReturnType<typeof discoverCustomMcpTools>>;
}> {
  removeExpired();
  const session = pendingSessions.get(input.state);
  pendingSessions.delete(input.state);
  if (!session || session.expiresAt <= Date.now()) throw new Error("OAuth 授权请求已失效，请重新连接");
  if (session.userId !== input.userId) throw new Error("OAuth 授权用户不匹配");
  const result = await auth(session.provider, {
    serverUrl: session.catalog.endpointUrl,
    authorizationCode: input.code,
    scope: session.catalog.scope,
    fetchFn: safeMcpFetch(),
  });
  if (result !== "AUTHORIZED" || !session.data.tokens) throw new Error("OAuth 授权未完成");
  const tools = await discoverCustomMcpTools({
    endpointUrl: session.catalog.endpointUrl,
    authType: "oauth",
    oauthData: session.data,
  });
  if (tools.length === 0) throw new Error("远程 MCP 未发现可用工具");
  return {
    userId: session.userId,
    adoptId: session.adoptId,
    catalog: session.catalog,
    oauthData: session.data,
    tools,
  };
}

export function clearCustomMcpOAuthSessionsForTest(): void {
  pendingSessions.clear();
}
