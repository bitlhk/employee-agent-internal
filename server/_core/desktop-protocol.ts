export const EA_DESKTOP_PROTOCOL = {
  name: "ea.desktop",
  version: 2,
  minVersion: 1,
} as const;

export type DesktopRuntimeType = "jiuwenswarm" | "legacy_archived" | "unknown";

export const EA_DESKTOP_FEATURES = {
  chatStreaming: true,
  sessionHistory: true,
  sessionSearch: true,
  modelSelection: true,
  files: true,
  skillCatalog: true,
  skillInstall: true,
  skillToggle: false,
  toolCatalog: true,
  connectorManagement: false,
  experts: false,
  memory: true,
  schedules: true,
  channels: true,
  localBridge: false,
} as const;

export function resolveDesktopRuntimeType(
  adoptId?: string | null
): DesktopRuntimeType {
  const normalized = String(adoptId || "")
    .trim()
    .toLowerCase();
  if (/(^|_)lgj-/.test(normalized)) return "jiuwenswarm";
  if (/(^|_)lg[ch]-/.test(normalized)) return "legacy_archived";
  return "unknown";
}

export function desktopProtocolMetadata(adoptId?: string | null) {
  return {
    protocol: EA_DESKTOP_PROTOCOL,
    runtime: {
      type: resolveDesktopRuntimeType(adoptId),
      mode: "enterprise" as const,
    },
    features: EA_DESKTOP_FEATURES,
  };
}
