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
