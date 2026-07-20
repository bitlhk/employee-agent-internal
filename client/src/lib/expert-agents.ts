export type ExpertAgent = {
  id: string;
  name: string;
  description: string;
  icon?: string;
  tags?: string;
  providerType?: string;
  adapterProtocol?: string;
  executionMode?: string;
  routeReady: boolean;
  reason?: string;
  healthStatus?: string;
  capabilities: string[];
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
      routeReady: agent.routeReady === true,
      reason: String(agent.reason || "").trim(),
      healthStatus: String(agent.healthStatus || "unknown").trim(),
      capabilities: Array.isArray(agent.capabilities)
        ? agent.capabilities.map((item) => String(item || "").trim()).filter(Boolean)
        : [],
      lastHealthCheck: agent.lastHealthCheck || null,
    }))
    .filter((agent) => agent.id)
    .sort((left, right) => Number(right.routeReady) - Number(left.routeReady) || left.name.localeCompare(right.name, "zh-CN"));
}

export function expertSupportsAttachments(expert: ExpertAgent): boolean {
  return expert.capabilities.some((capability) => ["files", "attachments", "multimodal"].includes(capability.toLowerCase()));
}

export function expertTaskMessage(expertName: string, taskId: string): string {
  return `已提交任务给 **${expertName}**，完成后结果会自动写回。\n\n任务编号：\`${taskId}\``;
}
