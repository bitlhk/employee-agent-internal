import type { Express, Request } from "express";
import { isAuthorizedInternalRequest } from "./helpers";
import { setRuntimeGovernanceAttested } from "./observability/metrics";

export const RUNTIME_GOVERNANCE_RULE_VERSION = "ea-governance-v1";
const FRESHNESS_MS = 5 * 60_000;

type RuntimeGovernanceAttestation = {
  runtimeId: string;
  hookVersion: string;
  lastSeenAt: number;
  invocationCount: number;
};

const attestations = new Map<string, RuntimeGovernanceAttestation>();

export function recordRuntimeGovernanceInvocation(input: {
  runtimeId?: unknown;
  hookVersion?: unknown;
}): RuntimeGovernanceAttestation {
  const runtimeId = String(input.runtimeId || "jiuwenswarm-local").trim().slice(0, 128) || "jiuwenswarm-local";
  const hookVersion = String(input.hookVersion || RUNTIME_GOVERNANCE_RULE_VERSION).trim().slice(0, 64);
  const previous = attestations.get(runtimeId);
  const next = {
    runtimeId,
    hookVersion,
    lastSeenAt: Date.now(),
    invocationCount: (previous?.invocationCount || 0) + 1,
  };
  attestations.set(runtimeId, next);
  setRuntimeGovernanceAttested(runtimeId, true);
  return next;
}

export function runtimeGovernanceAttestationStatus(runtimeId?: unknown): {
  attested: boolean;
  runtimeId: string;
  hookVersion: string | null;
  lastSeenAt: string | null;
  invocationCount: number;
} {
  const id = String(runtimeId || "jiuwenswarm-local").trim().slice(0, 128) || "jiuwenswarm-local";
  const current = attestations.get(id);
  return {
    attested: Boolean(current && Date.now() - current.lastSeenAt <= FRESHNESS_MS),
    runtimeId: id,
    hookVersion: current?.hookVersion || null,
    lastSeenAt: current ? new Date(current.lastSeenAt).toISOString() : null,
    invocationCount: current?.invocationCount || 0,
  };
}

export function runtimeGovernanceIsAttested(runtimeId?: unknown): boolean {
  return runtimeGovernanceAttestationStatus(runtimeId).attested;
}

export function resetRuntimeGovernanceAttestationsForTest(): void {
  for (const runtimeId of attestations.keys()) setRuntimeGovernanceAttested(runtimeId, false);
  attestations.clear();
}

export function registerRuntimeGovernanceAttestationRoutes(app: Express): void {
  app.get("/api/internal/security/runtime-governance-attestation", (req: Request, res) => {
    if (!isAuthorizedInternalRequest(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.json(runtimeGovernanceAttestationStatus(req.query.runtimeId));
  });
}
