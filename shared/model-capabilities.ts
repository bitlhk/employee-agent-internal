export type ModelCapabilities = {
  tools: boolean;
  vision: boolean;
  parallelTools: boolean;
  streaming: boolean;
  contextWindowTokens: number;
  source: "runtime" | "inferred";
};

export type ModelCapabilityRequirements = Partial<Pick<ModelCapabilities, "tools" | "vision" | "parallelTools" | "streaming">>;

type ModelCapabilityInput = {
  id?: string | null;
  modelName?: string | null;
  alias?: string | null;
  provider?: string | null;
  contextWindowTokens?: number | null;
};

const NON_CHAT_MODEL_RE = /(?:embedding|embed|rerank|re-rank|tts|speech|audio|image[-_ ]?(?:gen|generation)|text-to-image)/i;
const VISION_MODEL_RE = /(?:qwen[^\s/]*[-_ ]?(?:vl|vision)|qvq|gpt-(?:4(?:o|\.1)?|5)|o[134](?:\b|-)|claude-(?:3|4)|gemini|glm-(?:4v|4\.\d+v)|vision|multimodal)/i;
const PARALLEL_TOOL_MODEL_RE = /(?:openpangu|pangu|glm|deepseek|qwen|gpt|o[134](?:\b|-)|claude|gemini)/i;

function modelFingerprint(input: ModelCapabilityInput): string {
  return [input.id, input.modelName, input.alias, input.provider]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function inferredContextWindow(fingerprint: string): number {
  if (/gemini/.test(fingerprint)) return 1_000_000;
  if (/gpt-5/.test(fingerprint)) return 400_000;
  if (/claude/.test(fingerprint)) return 200_000;
  if (/(?:openpangu|pangu|glm|deepseek|qwen|gpt-4|o[134](?:\b|-))/.test(fingerprint)) return 128_000;
  return 0;
}

export function inferModelCapabilities(input: ModelCapabilityInput): ModelCapabilities {
  const fingerprint = modelFingerprint(input);
  const runtimeContext = Math.max(0, Number(input.contextWindowTokens || 0) || 0);
  const chatModel = Boolean(fingerprint) && !NON_CHAT_MODEL_RE.test(fingerprint);
  return {
    tools: chatModel,
    vision: chatModel && VISION_MODEL_RE.test(fingerprint),
    parallelTools: chatModel && PARALLEL_TOOL_MODEL_RE.test(fingerprint),
    streaming: chatModel,
    contextWindowTokens: runtimeContext || inferredContextWindow(fingerprint),
    source: runtimeContext > 0 ? "runtime" : "inferred",
  };
}

export function modelMeetsCapabilities(
  capabilities: ModelCapabilities,
  requirements: ModelCapabilityRequirements = {},
): boolean {
  return Object.entries(requirements).every(([key, required]) => (
    required !== true || capabilities[key as keyof ModelCapabilityRequirements] === true
  ));
}

export function isImageAttachmentName(value: string): boolean {
  return /\.(?:png|jpe?g|webp|gif|bmp|tiff?)$/i.test(String(value || "").trim());
}
