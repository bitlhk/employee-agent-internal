const RETIRED_SKILL_MARKET_ROUTES = new Set([
  "GET /api/claw/shared-packages",
  "POST /api/claw/skill-package/publish",
  "POST /api/claw/skill-market/install",
]);

export function isRetiredSkillMarketRoute(method: string, requestPath: string): boolean {
  const normalizedPath = `/${String(requestPath || "").split("/").filter(Boolean).join("/")}`;
  return RETIRED_SKILL_MARKET_ROUTES.has(`${String(method || "").toUpperCase()} ${normalizedPath}`);
}

export function toPublicSkillMarketItem(item: Record<string, unknown>) {
  return {
    id: Number(item.id),
    skillId: String(item.skillId || ""),
    name: String(item.name || item.skillId || ""),
    description: String(item.description || ""),
    author: String(item.author || ""),
    version: String(item.version || "1.0.0"),
    category: String(item.category || "general"),
    origin: String(item.origin || "opensource"),
    license: String(item.license || ""),
    roleTag: String(item.roleTag || ""),
    provider: String(item.provider || ""),
    downloadCount: Number(item.downloadCount || 0),
  };
}
