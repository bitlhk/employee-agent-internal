import { createHash, randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

const DEFAULT_TTL_SECONDS = 300;
const MIN_SECRET_BYTES = 32;
const ISSUER = "employee-agent-internal-runtime";
const MAX_CONSUMED_JTIS = 100_000;
const consumedJtis = new Map<string, number>();

export type InternalRuntimeIdentity = {
  runtimeId: string;
  agentId: string;
  adoptId: string;
  audience: string;
  jti: string;
  expiresAt: number;
};

function currentSecret(): string {
  return String(process.env.INTERNAL_RUNTIME_TOKEN_SECRET || "").trim();
}

function verificationSecrets(): string[] {
  return Array.from(new Set([
    currentSecret(),
    ...String(process.env.INTERNAL_RUNTIME_TOKEN_PREVIOUS_SECRETS || "").split(/[\r\n,]+/).map((value) => value.trim()),
  ].filter(Boolean)));
}

function key(secret: string): Uint8Array {
  const bytes = new TextEncoder().encode(secret);
  if (bytes.byteLength < MIN_SECRET_BYTES) throw new Error("Internal runtime token secret must contain at least 32 bytes");
  return bytes;
}

function boundedTtlSeconds(): number {
  const configured = Number(process.env.INTERNAL_RUNTIME_TOKEN_TTL_SECONDS || DEFAULT_TTL_SECONDS);
  return Math.min(300, Math.max(30, Number.isFinite(configured) ? Math.floor(configured) : DEFAULT_TTL_SECONDS));
}

function runtimeId(value: unknown): string {
  const normalized = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{3,128}$/.test(normalized) ? normalized : "";
}

function agentId(value: unknown): string {
  const normalized = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{3,160}$/.test(normalized) ? normalized : "";
}

function adoptId(value: unknown): string {
  const normalized = String(value || "").trim();
  return /^lgj-[A-Za-z0-9_-]{3,60}$/.test(normalized) ? normalized : "";
}

export function internalMcpAudience(pathname: string): string {
  const path = String(pathname || "").replace(/\?.*$/, "").replace(/\/$/, "");
  if (path.endsWith("/platform-tools/mcp")) return "urn:ea:internal-mcp:platform-tools";
  if (path.endsWith("/custom-mcp/mcp")) return "urn:ea:internal-mcp:custom-mcp";
  if (path.endsWith("/enterprise-mcp/mcp")) return "urn:ea:internal-mcp:enterprise-mcp";
  if (path.endsWith("/role-mcp/mcp")) return "urn:ea:internal-mcp:role-mcp";
  throw new Error("Unsupported internal MCP audience path");
}

export function internalRuntimeTokensConfigured(): boolean {
  return currentSecret().length >= MIN_SECRET_BYTES;
}

function pruneConsumedJtis(now: number): void {
  for (const [jti, expiresAt] of consumedJtis) {
    if (expiresAt < now) consumedJtis.delete(jti);
  }
  while (consumedJtis.size >= MAX_CONSUMED_JTIS) {
    const oldest = consumedJtis.keys().next().value;
    if (!oldest) break;
    consumedJtis.delete(oldest);
  }
}

export function consumeInternalRuntimeToken(identity: InternalRuntimeIdentity): boolean {
  const now = Math.floor(Date.now() / 1000);
  pruneConsumedJtis(now);
  if (identity.expiresAt < now || consumedJtis.has(identity.jti)) return false;
  consumedJtis.set(identity.jti, identity.expiresAt);
  return true;
}

export function resetConsumedInternalRuntimeTokensForTests(): void {
  consumedJtis.clear();
}

export async function issueInternalRuntimeToken(input: {
  runtimeId: string;
  agentId: string;
  adoptId: string;
  audience: string;
}): Promise<{ token: string; identity: InternalRuntimeIdentity }> {
  const secret = currentSecret();
  const normalizedRuntimeId = runtimeId(input.runtimeId);
  const normalizedAgentId = agentId(input.agentId);
  const normalizedAdoptId = adoptId(input.adoptId);
  if (!normalizedRuntimeId || !normalizedAgentId || !normalizedAdoptId || !input.audience) {
    throw new Error("Internal runtime token identity is invalid");
  }
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + boundedTtlSeconds();
  const jti = `irt_${randomUUID()}`;
  const token = await new SignJWT({
    runtime_id: normalizedRuntimeId,
    agent_id: normalizedAgentId,
    adopt_id: normalizedAdoptId,
  })
    .setProtectedHeader({
      alg: "HS256",
      typ: "ea-internal-runtime+jwt",
      kid: createHash("sha256").update(secret).digest("hex").slice(0, 16),
    })
    .setIssuer(ISSUER)
    .setSubject(`runtime:${normalizedRuntimeId}`)
    .setAudience(input.audience)
    .setIssuedAt(now)
    .setNotBefore(now - 5)
    .setExpirationTime(expiresAt)
    .setJti(jti)
    .sign(key(secret));
  return {
    token,
    identity: {
      runtimeId: normalizedRuntimeId,
      agentId: normalizedAgentId,
      adoptId: normalizedAdoptId,
      audience: input.audience,
      jti,
      expiresAt,
    },
  };
}

export async function verifyInternalRuntimeToken(
  token: string,
  audience: string,
): Promise<InternalRuntimeIdentity> {
  let lastError: unknown;
  for (const secret of verificationSecrets()) {
    try {
      const verified = await jwtVerify(token, key(secret), {
        algorithms: ["HS256"],
        issuer: ISSUER,
        audience,
        typ: "ea-internal-runtime+jwt",
        clockTolerance: 5,
      });
      const normalizedRuntimeId = runtimeId(verified.payload.runtime_id);
      const normalizedAgentId = agentId(verified.payload.agent_id);
      const normalizedAdoptId = adoptId(verified.payload.adopt_id);
      const jti = String(verified.payload.jti || "").trim();
      const expiresAt = Number(verified.payload.exp || 0);
      if (!normalizedRuntimeId || !normalizedAgentId || !normalizedAdoptId || !jti || !expiresAt) {
        throw new Error("Internal runtime token claims are incomplete");
      }
      return { runtimeId: normalizedRuntimeId, agentId: normalizedAgentId, adoptId: normalizedAdoptId, audience, jti, expiresAt };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Internal runtime token verification failed");
}
