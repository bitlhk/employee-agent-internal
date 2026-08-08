import { createHash, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { exportJWK, importPKCS8, SignJWT, type JWK } from "jose";
import { resolvePublicBaseUrl } from "./public-base-url";

const DEFAULT_TTL_SECONDS = 120;
const MIN_TTL_SECONDS = 30;
const MAX_TTL_SECONDS = 300;

type IdentityConfig = {
  issuer: string;
  keyId: string;
  privateKeyPem: string;
  publicKeyPem: string;
  additionalPublicJwks: JWK[];
  ttlSeconds: number;
};

export type EnterpriseMcpIdentityMode = "platform" | "tenant" | "user";

export type EnterpriseMcpCallerIdentity = {
  userId: number;
  organization?: string | null;
  adoptId: string;
  agentId: string;
  roleKey: string;
};

let cachedConfig: IdentityConfig | null | undefined;
let cachedPrivateKey: Awaited<ReturnType<typeof importPKCS8>> | null = null;
let cachedJwks: JWK[] | null = null;

function pemValue(directName: string, fileName: string): string {
  const direct = String(process.env[directName] || "").trim().replace(/\\n/g, "\n");
  if (direct) return direct;
  const file = String(process.env[fileName] || "").trim();
  if (!file) return "";
  return readFileSync(file, "utf8").trim();
}

function normalizeIssuer(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Enterprise MCP identity issuer must use HTTPS");
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function jsonValue(directName: string, fileName: string): string {
  const direct = String(process.env[directName] || "").trim();
  if (direct) return direct;
  const file = String(process.env[fileName] || "").trim();
  if (!file) return "";
  return readFileSync(file, "utf8").trim();
}

function additionalPublicJwks(): JWK[] {
  const raw = jsonValue("ENTERPRISE_MCP_ADDITIONAL_JWKS_JSON", "ENTERPRISE_MCP_ADDITIONAL_JWKS_FILE");
  if (!raw) return [];
  const parsed = JSON.parse(raw) as { keys?: unknown } | unknown[];
  const keys = Array.isArray(parsed) ? parsed : parsed?.keys;
  if (!Array.isArray(keys)) throw new Error("Enterprise MCP additional JWKS must contain a keys array");
  return keys.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Enterprise MCP additional JWKS key ${index} is invalid`);
    }
    const key = value as JWK;
    const kid = String(key.kid || "").trim().slice(0, 128);
    if (!kid) throw new Error(`Enterprise MCP additional JWKS key ${index} is missing kid`);
    if (key.kty !== "EC" || key.crv !== "P-256" || !key.x || !key.y || key.d) {
      throw new Error(`Enterprise MCP additional JWKS key ${kid} must be a public P-256 key`);
    }
    if (key.alg && key.alg !== "ES256") throw new Error(`Enterprise MCP additional JWKS key ${kid} must use ES256`);
    if (key.use && key.use !== "sig") throw new Error(`Enterprise MCP additional JWKS key ${kid} must be a signing key`);
    return { ...key, alg: "ES256", use: "sig", kid };
  });
}

function loadConfig(): IdentityConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;
  const privateKeyPem = pemValue("ENTERPRISE_MCP_PRIVATE_KEY_PEM", "ENTERPRISE_MCP_PRIVATE_KEY_FILE");
  if (!privateKeyPem) {
    cachedConfig = null;
    return null;
  }
  const publicKeyPem = pemValue("ENTERPRISE_MCP_PUBLIC_KEY_PEM", "ENTERPRISE_MCP_PUBLIC_KEY_FILE")
    || createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString();
  const ttlRaw = Number(process.env.ENTERPRISE_MCP_TOKEN_TTL_SECONDS || DEFAULT_TTL_SECONDS);
  const ttlSeconds = Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Number.isFinite(ttlRaw) ? Math.floor(ttlRaw) : DEFAULT_TTL_SECONDS));
  cachedConfig = {
    issuer: normalizeIssuer(String(process.env.ENTERPRISE_MCP_IDENTITY_ISSUER || resolvePublicBaseUrl())),
    keyId: String(process.env.ENTERPRISE_MCP_KEY_ID || "ea-mcp-es256-v1").trim().slice(0, 128) || "ea-mcp-es256-v1",
    privateKeyPem,
    publicKeyPem,
    additionalPublicJwks: additionalPublicJwks(),
    ttlSeconds,
  };
  return cachedConfig;
}

async function signingKey(config: IdentityConfig) {
  if (!cachedPrivateKey) cachedPrivateKey = await importPKCS8(config.privateKeyPem, "ES256");
  return cachedPrivateKey;
}

async function publicJwks(config: IdentityConfig): Promise<JWK[]> {
  if (cachedJwks) return cachedJwks;
  const key = createPublicKey(config.publicKeyPem);
  const jwk = await exportJWK(key);
  const active = { ...jwk, alg: "ES256", use: "sig", kid: config.keyId };
  const byKid = new Map<string, JWK>([[config.keyId, active]]);
  for (const additional of config.additionalPublicJwks) {
    const kid = String(additional.kid);
    const existing = byKid.get(kid);
    if (!existing) {
      byKid.set(kid, additional);
      continue;
    }
    const samePublicKey = existing.kty === additional.kty
      && existing.crv === additional.crv
      && existing.x === additional.x
      && existing.y === additional.y;
    if (!samePublicKey) throw new Error(`Enterprise MCP JWKS contains conflicting kid ${kid}`);
  }
  cachedJwks = Array.from(byKid.values());
  return cachedJwks;
}

export function enterpriseMcpTenantId(organization: string | null | undefined, userId: number): string {
  const source = String(organization || "").trim().toLowerCase() || `personal-user:${userId}`;
  return `tn_${createHash("sha256").update(source).digest("hex").slice(0, 24)}`;
}

export async function enterpriseMcpIdentityStatus(): Promise<{
  configured: boolean;
  issuer: string | null;
  jwksUri: string | null;
  keyId: string | null;
  keyIds: string[];
  keyCount: number;
  ttlSeconds: number | null;
}> {
  const config = loadConfig();
  if (!config) return { configured: false, issuer: null, jwksUri: null, keyId: null, keyIds: [], keyCount: 0, ttlSeconds: null };
  const keys = await publicJwks(config);
  return {
    configured: true,
    issuer: config.issuer,
    jwksUri: `${config.issuer}/api/enterprise-mcp/.well-known/jwks.json`,
    keyId: config.keyId,
    keyIds: keys.map(key => String(key.kid)),
    keyCount: keys.length,
    ttlSeconds: config.ttlSeconds,
  };
}

export async function enterpriseMcpJwks(): Promise<{ keys: JWK[] }> {
  const config = loadConfig();
  if (!config) throw new Error("Enterprise MCP identity signing key is not configured");
  return { keys: await publicJwks(config) };
}

export async function issueEnterpriseMcpAccessToken(input: {
  caller: EnterpriseMcpCallerIdentity;
  identityMode: EnterpriseMcpIdentityMode;
  resourceUri: string;
  serverId: string;
  toolName: string;
  scopes: string[];
  requestId: string;
}): Promise<{ token: string; tenantId: string; expiresAt: Date }> {
  const config = loadConfig();
  if (!config) throw new Error("Enterprise MCP identity signing key is not configured");
  const audience = new URL(input.resourceUri);
  if (audience.protocol !== "https:") throw new Error("Enterprise MCP token audience must use HTTPS");
  const tenantId = enterpriseMcpTenantId(input.caller.organization, input.caller.userId);
  const subject = input.identityMode === "platform"
    ? "ea-platform"
    : input.identityMode === "tenant"
      ? `ea-tenant:${tenantId}`
      : `ea-user:${input.caller.userId}`;
  const scopes = Array.from(new Set(input.scopes.map(scope => String(scope || "").trim()).filter(Boolean))).sort();
  const expiresAt = new Date(Date.now() + config.ttlSeconds * 1000);
  const token = await new SignJWT({
    tenant_id: tenantId,
    actor_user_id: input.caller.userId,
    ...(input.identityMode === "user" ? { user_id: input.caller.userId } : {}),
    agent_id: input.caller.agentId,
    adopt_id: input.caller.adoptId,
    role: input.caller.roleKey,
    server_id: input.serverId,
    tool_name: input.toolName,
    identity_mode: input.identityMode,
    request_id: input.requestId,
    scope: scopes.join(" "),
    scp: scopes,
  })
    .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: config.keyId })
    .setIssuer(config.issuer)
    .setSubject(subject)
    .setAudience(audience.toString())
    .setIssuedAt()
    .setNotBefore(Math.floor(Date.now() / 1000) - 5)
    .setJti(input.requestId)
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(await signingKey(config));
  return { token, tenantId, expiresAt };
}

export function resetEnterpriseMcpIdentityForTests(): void {
  cachedConfig = undefined;
  cachedPrivateKey = null;
  cachedJwks = null;
}
