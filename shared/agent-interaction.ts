export const EA_INTERACTION_SCHEMA = "ea.interaction.v1" as const;

export type AgentInteractionOption = {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
};

export type AgentInteraction = {
  schema: typeof EA_INTERACTION_SCHEMA;
  interactionId: string;
  type: "single_choice";
  title: string;
  description?: string;
  options: AgentInteractionOption[];
  allowCustom: boolean;
  allowNote: boolean;
  submitMode: "immediate" | "confirm";
};

export type AgentInteractionResponse = {
  schema: typeof EA_INTERACTION_SCHEMA;
  interactionId: string;
  optionId?: string;
  customText?: string;
  note?: string;
};

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function parseAgentInteraction(value: unknown): AgentInteraction | null {
  const input = record(value);
  if (!input || input.schema !== EA_INTERACTION_SCHEMA || input.type !== "single_choice") return null;

  const interactionId = cleanText(input.interactionId, 128);
  const title = cleanText(input.title, 240);
  if (!SAFE_ID_RE.test(interactionId) || !title || !Array.isArray(input.options)) return null;

  const seen = new Set<string>();
  const options: AgentInteractionOption[] = [];
  for (const rawOption of input.options.slice(0, 8)) {
    const option = record(rawOption);
    if (!option) return null;
    const id = cleanText(option.id, 128);
    const label = cleanText(option.label, 160);
    if (!SAFE_ID_RE.test(id) || !label || seen.has(id)) return null;
    seen.add(id);
    const description = cleanText(option.description, 360);
    options.push({
      id,
      label,
      ...(description ? { description } : {}),
      ...(option.recommended === true ? { recommended: true } : {}),
    });
  }
  if (options.length < 1) return null;

  const description = cleanText(input.description, 600);
  return {
    schema: EA_INTERACTION_SCHEMA,
    interactionId,
    type: "single_choice",
    title,
    ...(description ? { description } : {}),
    options,
    allowCustom: input.allowCustom === true,
    allowNote: input.allowNote === true,
    submitMode: input.submitMode === "immediate" ? "immediate" : "confirm",
  };
}

export function parseAgentInteractionResponse(
  value: unknown,
  interaction: AgentInteraction,
): AgentInteractionResponse | null {
  const input = record(value);
  if (!input || input.interactionId !== interaction.interactionId) return null;

  const optionId = cleanText(input.optionId, 128);
  const customText = cleanText(input.customText, 4_000);
  const note = cleanText(input.note, 4_000);
  if (optionId && !interaction.options.some((option) => option.id === optionId)) return null;
  if (customText && !interaction.allowCustom) return null;
  if (note && !interaction.allowNote) return null;
  if (!optionId && !customText) return null;

  return {
    schema: EA_INTERACTION_SCHEMA,
    interactionId: interaction.interactionId,
    ...(optionId ? { optionId } : {}),
    ...(customText ? { customText } : {}),
    ...(note ? { note } : {}),
  };
}

export function agentInteractionResponseText(
  interaction: AgentInteraction,
  response: AgentInteractionResponse,
): string {
  const option = interaction.options.find((item) => item.id === response.optionId);
  const choice = option?.label || response.customText || "";
  return [choice, response.note ? `补充：${response.note}` : ""].filter(Boolean).join("\n");
}

export function agentInteractionAgentInput(
  interaction: AgentInteraction,
  response: AgentInteractionResponse,
): string {
  const option = interaction.options.find((item) => item.id === response.optionId);
  const lines = [
    `[用户已回应：${interaction.title}]`,
    option ? `选择：${option.label}` : `自定义回答：${response.customText || ""}`,
  ];
  if (response.note) lines.push(`补充说明：${response.note}`);
  return lines.join("\n");
}
