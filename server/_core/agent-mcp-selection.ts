import type { EffectiveRoleAssets } from "./role-asset-grants";

export type AgentMcpPreferenceRecord = {
  serverId: string;
  enabled: boolean;
};

export type AgentMcpSelection = {
  authorizedServerIds: string[];
  enabledServerIds: string[];
  disabledServerIds: string[];
  grantModeByServerId: Record<string, "default" | "optional">;
};

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean))).sort();
}

export function resolveAgentMcpSelection(
  effectiveAssets: EffectiveRoleAssets,
  preferences: AgentMcpPreferenceRecord[],
): AgentMcpSelection {
  const defaultIds = uniqueSorted(effectiveAssets.mcpServers.default);
  const defaultSet = new Set(defaultIds);
  const optionalIds = uniqueSorted(effectiveAssets.mcpServers.optional).filter((serverId) => !defaultSet.has(serverId));
  const authorizedServerIds = uniqueSorted([...defaultIds, ...optionalIds]);
  const explicitByServerId = new Map(
    preferences
      .map((preference) => [String(preference.serverId || "").trim(), Boolean(preference.enabled)] as const)
      .filter(([serverId]) => Boolean(serverId)),
  );
  const enabledServerIds = authorizedServerIds.filter((serverId) => explicitByServerId.get(serverId) !== false);
  const enabledSet = new Set(enabledServerIds);

  return {
    authorizedServerIds,
    enabledServerIds,
    disabledServerIds: authorizedServerIds.filter((serverId) => !enabledSet.has(serverId)),
    grantModeByServerId: Object.fromEntries([
      ...defaultIds.map((serverId) => [serverId, "default"] as const),
      ...optionalIds.map((serverId) => [serverId, "optional"] as const),
    ]),
  };
}

export function projectEffectiveAssetsToMcpSelection(
  effectiveAssets: EffectiveRoleAssets,
  enabledServerIds: string[],
): EffectiveRoleAssets {
  const enabled = new Set(uniqueSorted(enabledServerIds));
  return {
    skills: {
      default: [...effectiveAssets.skills.default],
      optional: [...effectiveAssets.skills.optional],
    },
    mcpServers: {
      default: uniqueSorted(effectiveAssets.mcpServers.default).filter((serverId) => enabled.has(serverId)),
      optional: uniqueSorted(effectiveAssets.mcpServers.optional).filter((serverId) => enabled.has(serverId)),
    },
  };
}
