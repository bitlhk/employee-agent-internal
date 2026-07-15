const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "__auto": "自动",
  "modelarts-maas/glm-5": "GLM-5",
  "glm5/glm-5": "GLM-5",
  "modelarts-maas/glm-5.1": "GLM-5.1",
  "glm5/glm-5.1": "GLM-5.1",
  "modelarts-maas/glm-5.2": "GLM-5.2",
  "glm5/glm-5.2": "GLM-5.2",
  "maas/deepseek-v4-flash": "DeepSeek-V4-Flash",
  "deepseek/deepseek-v4-flash": "DeepSeek-V4-Flash",
  "deepseek/deepseek-v4-pro": "DeepSeek-V4-Pro",
  "deepseek/deepseek-chat": "DeepSeek Chat",
  "openai-codex/gpt-5.5": "GPT-5.5",
  "openai/gpt-5.5": "GPT-5.5",
  "legacy/legacy-agent": "Legacy Agent",
};

export function formatModelName(modelId?: string | null, fallback = "默认模型") {
  const id = String(modelId || "").trim();
  if (!id || id === "default") return fallback;
  const known = MODEL_DISPLAY_NAMES[id];
  if (known) return known;
  if (id.includes("/")) return id.split("/").pop() || id;
  return id;
}

export function getModelProviderLabel(modelId?: string | null) {
  const id = String(modelId || "").trim();
  if (!id.includes("/")) return "";
  return id.split("/")[0] || "";
}
