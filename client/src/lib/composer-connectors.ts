export type ComposerConnector = {
  serverId: string;
  name: string;
  description: string;
  category: string;
  source: "preset" | "public" | "optional" | "personal";
  catalogId?: string | null;
  configured: boolean;
  status: "available" | "disabled" | "missing";
  liveStatus?: "live" | "fallback" | "unavailable" | "unsupported";
  enabledForAgent: boolean;
  grantMode: "default" | "optional";
};

export type ComposerConnectorResponse = {
  items?: Array<{
    id?: string;
    name?: string;
    description?: string;
    category?: string;
    children?: Array<Partial<ComposerConnector> & { id?: string }>;
  }>;
  enabledServerIds?: string[];
  disabledServerIds?: string[];
};

export function flattenComposerConnectors(payload: ComposerConnectorResponse): ComposerConnector[] {
  return (Array.isArray(payload.items) ? payload.items : [])
    .flatMap((group) => {
      const isCustomGroup = group.id === "custom-user-mcp" || group.category === "个人连接";
      return (Array.isArray(group.children) ? group.children : []).map((child) => ({
        serverId: String(child.serverId || child.id || "").trim(),
        // Curated groups carry the localized business name; custom rows carry the user's name.
        name: String(
          isCustomGroup
            ? child.name || group.name || child.serverId || child.id || "连接"
            : group.name || child.name || child.serverId || child.id || "连接",
        ).trim(),
        description: String(
          isCustomGroup
            ? child.description || group.description || ""
            : group.description || child.description || "",
        ).trim(),
        category: String(group.category || child.category || "业务连接").trim(),
        source: (isCustomGroup
          ? "personal"
          : /公共|公开/.test(String(group.category || child.category || ""))
            ? "public"
            : child.grantMode === "default" ? "preset" : "optional") as ComposerConnector["source"],
        catalogId: child.catalogId ? String(child.catalogId) : null,
        configured: Boolean(child.configured),
        status: (child.status === "available" || child.status === "disabled"
          ? child.status
          : "missing") as ComposerConnector["status"],
        liveStatus: child.liveStatus,
        enabledForAgent: child.enabledForAgent !== false,
        grantMode: (child.grantMode === "default" ? "default" : "optional") as ComposerConnector["grantMode"],
      }));
    })
    .filter((item) => item.serverId)
    .sort((a, b) => Number(b.enabledForAgent) - Number(a.enabledForAgent) || a.name.localeCompare(b.name, "zh-CN"));
}
