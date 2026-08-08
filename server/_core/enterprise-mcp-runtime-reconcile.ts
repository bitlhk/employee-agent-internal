import { existsSync } from "node:fs";
import {
  listRoleAssetGrants,
  resolveEffectiveRoleAssets,
  resolvePersistedAgentMcpSelection,
} from "../db";
import { listClawAdoptionsAdmin } from "../db/claw";
import { resolveRuntimeAgentId, resolveRuntimeWorkspaceByIds } from "./helpers";
import { ensureJiuwenSwarmWorkspacePermission } from "./jiuwenswarm-permissions";
import { refreshJiuwenRuntimeCapabilities } from "./jiuwenswarm-runtime-refresh";
import { writeJiuwenSwarmRoleScopeManifest } from "./jiuwenswarm-role-scope";
import { resolveAgentRoleTemplate } from "./role-templates";

export type EnterpriseMcpRuntimeReconcileSummary = {
  matched: number;
  updated: number;
  refreshed: number;
  skipped: number;
  failed: Array<{ adoptId: string; error: string }>;
};

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 240);
}

async function roleKeysForServer(serverId?: string): Promise<Set<string> | null> {
  if (!serverId) return null;
  const grants = (await listRoleAssetGrants()).filter(grant =>
    grant.enabled && grant.assetType === "mcp_server" && grant.assetId === serverId
  );
  if (grants.some(grant => grant.roleKey === "*")) return null;
  return new Set(grants.map(grant => grant.roleKey));
}

export async function reconcileEnterpriseMcpRuntimeScopes(input: {
  serverId?: string;
  roleKeys?: string[];
  forceRefresh?: boolean;
} = {}): Promise<EnterpriseMcpRuntimeReconcileSummary> {
  const explicitRoles = Array.from(new Set((input.roleKeys || []).map(value => String(value || "").trim()).filter(Boolean)));
  const allowedRoles = explicitRoles.length > 0
    ? (explicitRoles.includes("*") ? null : new Set(explicitRoles))
    : await roleKeysForServer(input.serverId);
  const rows = await listClawAdoptionsAdmin({ limit: 1_000 });
  const candidates = rows.filter(row => {
    if (!["active", "expiring"].includes(String(row.status || ""))) return false;
    if (String(row.runtime || "jiuwenswarm") !== "jiuwenswarm") return false;
    const roleKey = String(row.roleTemplate || "general-assistant");
    return !allowedRoles || allowedRoles.has(roleKey);
  });
  const summary: EnterpriseMcpRuntimeReconcileSummary = {
    matched: candidates.length,
    updated: 0,
    refreshed: 0,
    skipped: 0,
    failed: [],
  };
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      const row = candidates[cursor++];
      const adoptId = String(row.adoptId || "").trim();
      try {
        const agentId = resolveRuntimeAgentId(adoptId, String(row.agentId || ""));
        const workspaceDir = resolveRuntimeWorkspaceByIds(adoptId, agentId);
        if (!adoptId || !existsSync(workspaceDir)) {
          summary.skipped += 1;
          continue;
        }
        const role = resolveAgentRoleTemplate(String(row.roleTemplate || "general-assistant"));
        const effectiveAssets = await resolveEffectiveRoleAssets(role.id);
        const selection = await resolvePersistedAgentMcpSelection(adoptId, effectiveAssets);
        const result = writeJiuwenSwarmRoleScopeManifest({
          workspaceDir,
          role,
          effectiveAssets,
          activeMcpServerIds: selection.enabledServerIds,
        });
        ensureJiuwenSwarmWorkspacePermission(workspaceDir);
        if (result.changed) summary.updated += 1;
        if (result.changed || input.forceRefresh) {
          await refreshJiuwenRuntimeCapabilities(adoptId);
          summary.refreshed += 1;
        }
      } catch (error) {
        summary.failed.push({ adoptId, error: cleanError(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, () => worker()));
  return summary;
}
