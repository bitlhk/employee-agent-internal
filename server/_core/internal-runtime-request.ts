import type { Request } from "express";
import { getClawByAdoptId, getClawByAgentId } from "../db";
import { auditRequest, recordAuditBestEffort } from "./audit-events";
import { isAuthorizedInternalRequest, isLoopbackRequest } from "./helpers";
import {
  consumeInternalRuntimeToken,
  verifyInternalRuntimeToken,
  type InternalRuntimeIdentity,
} from "./internal-runtime-token";

function bearerToken(req: Request): string {
  const authorization = String(req.headers.authorization || "").trim();
  if (authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  return String(req.headers["x-ea-runtime-token"] || "").trim();
}

function header(req: Request, name: string): string {
  const value = req.headers[name];
  return String(Array.isArray(value) ? value[0] : value || "").trim();
}

function bindIdentity(req: Request, identity: InternalRuntimeIdentity): void {
  req.headers["x-linggan-runtime-id"] = identity.runtimeId;
  req.headers["x-linggan-agent-id"] = identity.agentId;
  req.headers["x-agent-adopt-id"] = identity.adoptId;
  req.headers["x-workforce-agent-adopt-id"] = identity.adoptId;
  req.headers["x-jiuwen-channel-id"] = identity.adoptId;
}

async function activeIdentityForAgent(agent: string): Promise<{ agentId: string; adoptId: string } | null> {
  const adoption = await getClawByAgentId(agent).catch(() => null);
  if (!adoption || !["active", "expiring"].includes(String(adoption.status || ""))) return null;
  return { agentId: String(adoption.agentId || agent), adoptId: String(adoption.adoptId || "") };
}

async function auditDenied(req: Request, audience: string, reason: string): Promise<void> {
  await recordAuditBestEffort({
    action: "security.internal_runtime_identity.denied",
    result: "denied",
    severity: "high",
    targetType: "internal_mcp",
    targetId: audience,
    targetName: audience,
    ...auditRequest(req),
    metadata: { reason },
  });
}

export async function authorizeAndBindInternalRuntimeRequest(
  req: Request,
  audience: string,
): Promise<boolean> {
  const token = bearerToken(req);
  if (token) {
    try {
      const identity = await verifyInternalRuntimeToken(token, audience);
      const active = await activeIdentityForAgent(identity.agentId);
      if (!active || active.adoptId !== identity.adoptId) throw new Error("runtime Agent is not bound to the claimed adoption");
      for (const name of ["x-linggan-agent-id", "x-agent-adopt-id", "x-workforce-agent-adopt-id", "x-jiuwen-channel-id"]) {
        const presented = header(req, name);
        const expected = name === "x-linggan-agent-id" ? identity.agentId : identity.adoptId;
        if (presented && presented !== expected) throw new Error(`${name} does not match the signed runtime identity`);
      }
      if (!consumeInternalRuntimeToken(identity)) throw new Error("runtime token jti has already been consumed");
      bindIdentity(req, identity);
      return true;
    } catch (error) {
      await auditDenied(req, audience, error instanceof Error ? error.message : "invalid signed runtime identity");
      return false;
    }
  }

  if (String(process.env.INTERNAL_RUNTIME_TOKEN_REQUIRED || "").toLowerCase() === "true") {
    await auditDenied(req, audience, "signed runtime token is required");
    return false;
  }
  if (!isAuthorizedInternalRequest(req) || !isLoopbackRequest(req)) {
    await auditDenied(req, audience, "legacy internal credential is not authorized from this network location");
    return false;
  }

  const presentedAgentId = header(req, "x-linggan-agent-id");
  const presentedAdoptId = header(req, "x-agent-adopt-id")
    || header(req, "x-workforce-agent-adopt-id")
    || header(req, "x-jiuwen-channel-id");
  const active = presentedAgentId ? await activeIdentityForAgent(presentedAgentId) : null;
  if (active) {
    if (presentedAdoptId && presentedAdoptId !== active.adoptId) {
      await auditDenied(req, audience, "legacy Agent and adoption headers do not match");
      return false;
    }
    bindIdentity(req, {
      runtimeId: header(req, "x-linggan-runtime-id") || "legacy-loopback-runtime",
      agentId: active.agentId,
      adoptId: active.adoptId,
      audience,
      jti: "legacy",
      expiresAt: 0,
    });
    return true;
  }

  const adoption = presentedAdoptId ? await getClawByAdoptId(presentedAdoptId).catch(() => null) : null;
  if (!adoption || !["active", "expiring"].includes(String(adoption.status || ""))) {
    await auditDenied(req, audience, "legacy runtime identity does not resolve to an active adoption");
    return false;
  }
  bindIdentity(req, {
    runtimeId: header(req, "x-linggan-runtime-id") || "legacy-loopback-runtime",
    agentId: String(adoption.agentId || presentedAdoptId),
    adoptId: presentedAdoptId,
    audience,
    jti: "legacy",
    expiresAt: 0,
  });
  return true;
}
