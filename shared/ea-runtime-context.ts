const KNOWLEDGE_CONTEXT_RE = /<ea_knowledge_context>[\s\S]*?<\/ea_knowledge_context>\s*/gi;
const USER_REQUEST_RE = /<user_request>\s*([\s\S]*?)\s*<\/user_request>/gi;
const SELECTED_SKILL_HEADING = "【本轮已由用户在输入框选择技能 Chip】";
const SELECTED_SKILL_QUESTION_MARKER = "\n用户问题：";

export function stripEaKnowledgeRuntimeContext(value: unknown): string {
  const text = String(value || "").trim();
  if (!text.toLowerCase().includes("<ea_knowledge_context>")) return text;

  const requests = Array.from(text.matchAll(USER_REQUEST_RE));
  const latestRequest = requests.at(-1)?.[1];
  if (latestRequest != null) return latestRequest.trim();
  return text.replace(KNOWLEDGE_CONTEXT_RE, "").trim();
}

export function stripEaSelectedSkillRuntimeContext(value: unknown): string {
  const text = String(value || "").trim();
  if (!text.startsWith(SELECTED_SKILL_HEADING)) return text;
  const markerIndex = text.lastIndexOf(SELECTED_SKILL_QUESTION_MARKER);
  if (markerIndex < 0) return text;
  return text.slice(markerIndex + SELECTED_SKILL_QUESTION_MARKER.length).trim();
}

export function stripEaInternalRuntimeContext(value: unknown): string {
  return stripEaSelectedSkillRuntimeContext(stripEaKnowledgeRuntimeContext(value));
}
