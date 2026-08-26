import type { Express } from "express";
import { getClawByAdoptId, getClawByAgentId } from "../db";
import { resolveEffectiveRoleAssets } from "../db/role-assets";
import { isAuthorizedInternalRequest } from "./helpers";
import { resolveCustomerSourceDelegation } from "./customer-context-source-delegation";

type Dependencies = {
  getByAdoptId?: typeof getClawByAdoptId;
  getByAgentId?: typeof getClawByAgentId;
  resolveAssets?: typeof resolveEffectiveRoleAssets;
};

export async function resolveMcpAgentAuthorization(
  input: { agentId: string; mcpServerId: string },
  dependencies: Dependencies = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const delegation = resolveCustomerSourceDelegation(
    input.agentId,
    input.mcpServerId,
  );
  const claw = delegation
    ? await (dependencies.getByAdoptId || getClawByAdoptId)(
      delegation.adoptionId,
    )
    : await (dependencies.getByAgentId || getClawByAgentId)(input.agentId);
  if (!claw || !["active", "expiring"].includes(String(claw.status || ""))) {
    return {
      status: 403,
      body: { ok: false, authorized: false, reason: "agent_not_active" },
    };
  }
  const roleId = String(claw.roleTemplate || "").trim();
  if (!roleId) {
    return {
      status: 403,
      body: { ok: false, authorized: false, reason: "principal_role_missing" },
    };
  }
  const assets = await (dependencies.resolveAssets || resolveEffectiveRoleAssets)(
    roleId,
  );
  const allowedMcpServers = new Set([
    ...assets.mcpServers.default,
    ...assets.mcpServers.optional,
  ]);
  const delegated = Boolean(
    delegation
      && delegation.runtimeAgentId === claw.agentId
      && delegation.roleTemplate === roleId
      && allowedMcpServers.has("customer_context"),
  );
  const authorized = delegated || allowedMcpServers.has(input.mcpServerId);
  return {
    status: authorized ? 200 : 403,
    body: {
      ok: authorized,
      authorized,
      reason: authorized
        ? delegated
          ? "customer_context_source_delegation"
          : "authorized"
        : "role_or_asset_not_authorized",
      agentId: claw.agentId,
      adoptId: claw.adoptId,
      roleId,
      mcpServerId: input.mcpServerId,
      userCode: claw.adoptId.replace(/^[^-]+-/, ""),
    },
  };
}

export function registerMcpAgentAuthorizationRoute(app: Express): void {
  app.get("/api/internal/mcp/agent-authorization", async (req, res) => {
    if (!isAuthorizedInternalRequest(req)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    const agentId = String(req.query.agentId || "").trim();
    const mcpServerId = String(req.query.mcpServerId || "").trim();
    if (!agentId || !mcpServerId) {
      return res.status(400).json({
        ok: false,
        error: "agentId and mcpServerId are required",
      });
    }
    const result = await resolveMcpAgentAuthorization({ agentId, mcpServerId });
    return res.status(result.status).json(result.body);
  });
}
