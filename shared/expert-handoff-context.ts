export const EA_EXPERT_HANDOFF_SCHEMA = "ea.expert_handoff.v1" as const;

export type ExpertHandoffContext = {
  schema: typeof EA_EXPERT_HANDOFF_SCHEMA;
  expertName: string;
  status: "processing" | "waiting_input" | "completed" | "failed";
  goal?: string;
  latestSummary?: string;
  artifacts?: string[];
};

const START = "[EA_EXPERT_HANDOFF_V1]";
const END = "[/EA_EXPERT_HANDOFF_V1]";
const BLOCK_RE = /\n*\[EA_EXPERT_HANDOFF_V1\]\s*[\s\S]*?\s*\[\/EA_EXPERT_HANDOFF_V1\]\s*/g;

function clean(value: unknown, maxLength: number): string {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function normalizeExpertHandoff(input: ExpertHandoffContext): ExpertHandoffContext {
  return {
    schema: EA_EXPERT_HANDOFF_SCHEMA,
    expertName: clean(input.expertName, 128) || "专家",
    status: ["processing", "waiting_input", "completed", "failed"].includes(input.status)
      ? input.status
      : "completed",
    ...(clean(input.goal, 800) ? { goal: clean(input.goal, 800) } : {}),
    ...(clean(input.latestSummary, 1800) ? { latestSummary: clean(input.latestSummary, 1800) } : {}),
    ...(Array.isArray(input.artifacts) && input.artifacts.length > 0
      ? { artifacts: input.artifacts.map((item) => clean(item, 255)).filter(Boolean).slice(0, 20) }
      : {}),
  };
}

export function buildExpertHandoffRuntimeMessage(message: string, input: ExpertHandoffContext): string {
  const handoff = normalizeExpertHandoff(input);
  return [
    message.trim(),
    "",
    START,
    "以下是平台提供的专家协作交接信息。请将它作为当前会话背景，不要向用户复述内部标记。",
    JSON.stringify(handoff),
    END,
  ].join("\n");
}

export function stripExpertHandoffRuntimeMessage(message: unknown): string {
  return String(message || "").replace(BLOCK_RE, "\n").trim();
}
