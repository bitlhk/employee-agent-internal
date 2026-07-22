export type ExpertAgent = {
  id: string;
  name: string;
  description: string;
  icon?: string;
  tags?: string;
  providerType?: string;
  adapterProtocol?: string;
  executionMode?: string;
  interactionMode: "single" | "session";
  source?: "platform" | "personal";
  routeReady: boolean;
  reason?: string;
  healthStatus?: string;
  capabilities: string[];
  usageCount: number;
  lastHealthCheck?: string | null;
};

export type ExpertAgentsResponse = {
  agents?: Partial<ExpertAgent>[];
  error?: string;
};

export function normalizeExpertAgents(payload: ExpertAgentsResponse): ExpertAgent[] {
  return (Array.isArray(payload.agents) ? payload.agents : [])
    .map((agent) => ({
      id: String(agent.id || "").trim(),
      name: String(agent.name || agent.id || "专家").trim(),
      description: String(agent.description || "").trim(),
      icon: String(agent.icon || "").trim(),
      tags: String(agent.tags || "").trim(),
      providerType: String(agent.providerType || "").trim(),
      adapterProtocol: String(agent.adapterProtocol || "").trim(),
      executionMode: String(agent.executionMode || "async").trim(),
      interactionMode: (agent.interactionMode === "session" ? "session" : "single") as ExpertAgent["interactionMode"],
      source: (agent.source === "personal" ? "personal" : "platform") as ExpertAgent["source"],
      routeReady: agent.routeReady === true,
      reason: String(agent.reason || "").trim(),
      healthStatus: String(agent.healthStatus || "unknown").trim(),
      capabilities: Array.isArray(agent.capabilities)
        ? agent.capabilities.map((item) => String(item || "").trim()).filter(Boolean)
        : [],
      usageCount: Math.max(0, Number(agent.usageCount || 0)),
      lastHealthCheck: agent.lastHealthCheck || null,
    }))
    .filter((agent) => agent.id)
    .sort((left, right) => Number(right.routeReady) - Number(left.routeReady) || left.name.localeCompare(right.name, "zh-CN"));
}

export function expertSupportsAttachments(expert: ExpertAgent): boolean {
  return expert.capabilities.some((capability) => ["files", "attachments", "multimodal"].includes(capability.toLowerCase()));
}

export function expertTaskMessage(expertName: string, _taskId: string, continuation = false): string {
  return continuation
    ? `好的，已将你的选择交给 **${expertName}**，它会继续处理。`
    : `**${expertName}** 已接手，正在为你处理。`;
}
