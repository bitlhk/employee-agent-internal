import { randomUUID } from "node:crypto";
import type { EnterpriseMcpConnection } from "../../drizzle/schema";
import type { CustomMcpToolSnapshot } from "../db/custom-mcp-connections";
import { discoverCustomMcpTools, type CustomMcpEndpointConfig } from "./custom-mcp-client";
import {
  enterpriseMcpIdentityStatus,
  issueEnterpriseMcpAccessToken,
  type EnterpriseMcpCallerIdentity,
} from "./enterprise-mcp-identity";

export type EnterpriseMcpIdentityVerificationCheck = {
  code: "valid_token" | "missing_token" | "wrong_audience" | "missing_scope" | "wrong_tool";
  passed: boolean;
  detail: string;
};

export type EnterpriseMcpIdentityVerificationResult = {
  passed: boolean;
  checks: EnterpriseMcpIdentityVerificationCheck[];
  tools: CustomMcpToolSnapshot[];
};

type VerifiableConnection = Pick<EnterpriseMcpConnection,
  "serverId" | "endpointUrl" | "resourceUri" | "authMode" | "timeoutMs"
>;

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error || "request rejected"))
    .replace(/Bearer\s+[^\s]+/gi, "Bearer <redacted>")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

function endpoint(connection: VerifiableConnection, credential?: string): CustomMcpEndpointConfig {
  return {
    endpointUrl: connection.endpointUrl,
    authType: credential ? "bearer" : "none",
    ...(credential ? { credential } : {}),
    timeoutMs: connection.timeoutMs,
  };
}

function wrongAudience(resourceUri: string): string {
  const url = new URL(resourceUri);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/_ea_identity_probe_invalid_audience`;
  return url.toString();
}

async function expectRejected(
  code: Exclude<EnterpriseMcpIdentityVerificationCheck["code"], "valid_token">,
  config: CustomMcpEndpointConfig,
): Promise<EnterpriseMcpIdentityVerificationCheck> {
  try {
    await discoverCustomMcpTools(config);
    return { code, passed: false, detail: "服务接受了本应拒绝的身份探测" };
  } catch (error) {
    return { code, passed: true, detail: cleanError(error) };
  }
}

async function probeToken(input: {
  connection: VerifiableConnection;
  caller: EnterpriseMcpCallerIdentity;
  resourceUri?: string;
  toolName?: string;
  scopes?: string[];
}): Promise<string> {
  const issued = await issueEnterpriseMcpAccessToken({
    caller: input.caller,
    identityMode: "platform",
    resourceUri: input.resourceUri || input.connection.resourceUri,
    serverId: input.connection.serverId,
    toolName: input.toolName || "tools/list",
    scopes: input.scopes ?? ["mcp.tools.read"],
    requestId: `emcp_verify_${randomUUID()}`,
  });
  return issued.token;
}

export async function verifyEnterpriseMcpIdentityEnforcement(input: {
  connection: VerifiableConnection;
  caller: EnterpriseMcpCallerIdentity;
}): Promise<EnterpriseMcpIdentityVerificationResult> {
  if (input.connection.authMode !== "oauth2_access_token") {
    throw new Error("可信身份验证仅适用于 EA 短期令牌连接器");
  }
  if (!(await enterpriseMcpIdentityStatus()).configured) {
    throw new Error("EA 统一短期令牌签发尚未启用");
  }

  const validToken = await probeToken(input);
  let tools: CustomMcpToolSnapshot[] = [];
  const checks: EnterpriseMcpIdentityVerificationCheck[] = [];
  try {
    tools = await discoverCustomMcpTools(endpoint(input.connection, validToken));
    checks.push({
      code: "valid_token",
      passed: tools.length > 0,
      detail: tools.length > 0 ? `有效令牌可发现 ${tools.length} 个工具` : "服务未返回任何工具",
    });
  } catch (error) {
    checks.push({ code: "valid_token", passed: false, detail: cleanError(error) });
    return { passed: false, checks, tools: [] };
  }

  const [missingToken, wrongAudienceToken, missingScopeToken, wrongToolToken] = await Promise.all([
    Promise.resolve(""),
    probeToken({ ...input, resourceUri: wrongAudience(input.connection.resourceUri) }),
    probeToken({ ...input, scopes: [] }),
    probeToken({ ...input, toolName: "tools/call" }),
  ]);
  checks.push(...await Promise.all([
    expectRejected("missing_token", endpoint(input.connection, missingToken)),
    expectRejected("wrong_audience", endpoint(input.connection, wrongAudienceToken)),
    expectRejected("missing_scope", endpoint(input.connection, missingScopeToken)),
    expectRejected("wrong_tool", endpoint(input.connection, wrongToolToken)),
  ]));

  return { passed: checks.every(check => check.passed), checks, tools };
}
