import {
  buildCustomMcpStatusGroupFromRows,
  customMcpServerId,
} from "./custom-mcp";
import type { McpLiveStatus } from "./mcp-live-status";

type McpSelection = {
  authorizedServerIds: string[];
  enabledServerIds: string[];
  disabledServerIds: string[];
  grantModeByServerId: Record<string, string>;
};

type CustomMcpRow = Parameters<typeof buildCustomMcpStatusGroupFromRows>[0][number];

type McpStatusPayload = {
  items: Array<{
    id: string;
    children: Array<Record<string, unknown> & { serverId: string }>;
    [key: string]: unknown;
  }>;
  totals: Record<string, unknown>;
  [key: string]: unknown;
};

export function buildMcpStatusResponse(input: {
  rawPayload: McpStatusPayload;
  selection: McpSelection;
  customRows: CustomMcpRow[];
  liveStatuses: Record<string, McpLiveStatus>;
  roleTemplate: string;
  liveTtlMs: number;
  checkedAt?: string;
}): Record<string, unknown> {
  const {
    rawPayload,
    selection,
    customRows,
    liveStatuses,
    roleTemplate,
    liveTtlMs,
  } = input;
  const customGroup = buildCustomMcpStatusGroupFromRows(customRows);
  const customServerIds = customRows.map((row) => customMcpServerId(row.id));
  const enabledCustomServerIds = customRows
    .filter((row) => row.enabled)
    .map((row) => customMcpServerId(row.id));
  const enabledServerIds = new Set(selection.enabledServerIds);
  const items = customGroup ? [...rawPayload.items, customGroup] : rawPayload.items;
  const mappedItems = items.map((group) => {
    if (group.id === "custom-user-mcp") return group;
    const children = group.children.map((child: Record<string, unknown> & { serverId: string }) => ({
      ...child,
      enabledForAgent: enabledServerIds.has(child.serverId),
      grantMode: selection.grantModeByServerId[child.serverId] || "optional",
    }));
    return {
      ...group,
      activeCount: children.filter((child: Record<string, unknown> & { enabledForAgent: boolean }) => child.enabledForAgent).length,
      children,
    };
  });

  return {
    ...rawPayload,
    items: mappedItems,
    totals: {
      ...rawPayload.totals,
      groups: items.length,
      configuredServers: Number(rawPayload.totals.configuredServers || 0) + customRows.length,
      availableServers: Number(rawPayload.totals.availableServers || 0)
        + customRows.filter((row) => row.enabled && row.healthStatus === "ready").length,
      activeServers: selection.enabledServerIds.length + enabledCustomServerIds.length,
    },
    roleTemplate,
    filtered: true,
    allowedServerIds: [...selection.authorizedServerIds, ...customServerIds],
    enabledServerIds: [...selection.enabledServerIds, ...enabledCustomServerIds],
    disabledServerIds: [
      ...selection.disabledServerIds,
      ...customRows.filter((row) => !row.enabled).map((row) => customMcpServerId(row.id)),
    ],
    live: {
      enabled: true,
      ttlMs: liveTtlMs,
      checkedAt: input.checkedAt || new Date().toISOString(),
      serverStatuses: Object.fromEntries([
        ...Object.entries(liveStatuses).map(([serverId, status]) => [
          serverId,
          {
            status: status.status,
            toolCount: status.tools.length,
            checkedAt: status.checkedAt,
            error: status.error || null,
          },
        ]),
        ...customRows.map((row) => [
          customMcpServerId(row.id),
          {
            status: row.healthStatus === "ready" ? "live" : "unavailable",
            toolCount: Array.isArray(row.selectedToolNames) ? row.selectedToolNames.length : 0,
            checkedAt: row.lastTestedAt?.toISOString() || null,
            error: row.lastError || null,
          },
        ]),
      ]),
    },
  };
}
