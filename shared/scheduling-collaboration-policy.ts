type Settings = {
  displayName?: string | null;
  acceptTask?: "off" | "approval" | "auto";
  allowedTaskTypes?: string | null;
  sharingPolicy?: "none" | "result-only";
  visibilityMode?: string;
  schedulingAcceptTask?: "off" | "approval" | "auto" | null;
  schedulingSharingPolicy?: "none" | "result-only" | null;
  schedulingDiscoverable?: boolean | null;
};

// Unconfigured scheduling uses existing calendar consent for automatic reception.
// Explicit scheduling choices are preserved. Calendar settings affect
// scheduling only, never permissions for general or custom task types.
export function collaborationSettingsForTask<T extends Settings>(
  settings: T,
  taskType: string
): T;
export function collaborationSettingsForTask<T extends Settings>(
  settings: T | null | undefined,
  taskType: string
): T | Settings | null | undefined;
export function collaborationSettingsForTask<T extends Settings>(
  settings: T | null | undefined,
  taskType: string
) {
  if (taskType !== "scheduling") return settings;
  return {
    ...settings,
    displayName: settings?.displayName,
    acceptTask: settings?.schedulingAcceptTask ?? ("auto" as const),
    allowedTaskTypes: JSON.stringify(["scheduling"]),
    sharingPolicy:
      settings?.schedulingSharingPolicy ??
      settings?.sharingPolicy ??
      ("none" as const),
    visibilityMode:
      settings?.schedulingDiscoverable == null
        ? settings?.visibilityMode
        : settings.schedulingDiscoverable
          ? "public"
          : "private",
  };
}
