const KNOWLEDGE_CONTEXT_RE = /<ea_knowledge_context>[\s\S]*?<\/ea_knowledge_context>\s*/gi;
const SECURITY_POLICY_RE = /<ea_security_policy>[\s\S]*?<\/ea_security_policy>\s*/gi;
const USER_REQUEST_RE = /<user_request>\s*([\s\S]*?)\s*<\/user_request>/gi;
const SELECTED_SKILL_HEADINGS = [
  "【本轮已由用户在输入框选择技能 Chip】",
  "【本轮已由平台根据用户请求匹配技能】",
  "【本轮已由用户选择岗位技能】",
  "【本轮已由平台匹配岗位技能】",
] as const;
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
  if (!SELECTED_SKILL_HEADINGS.some((heading) => text.startsWith(heading))) return text;
  const markerIndex = text.lastIndexOf(SELECTED_SKILL_QUESTION_MARKER);
  if (markerIndex < 0) return text;
  return text.slice(markerIndex + SELECTED_SKILL_QUESTION_MARKER.length).trim();
}

export function stripEaSecurityRuntimeContext(value: unknown): string {
  return String(value || "").replace(SECURITY_POLICY_RE, "").trim();
}

export function stripEaInternalRuntimeContext(value: unknown): string {
  return stripEaSelectedSkillRuntimeContext(
    stripEaKnowledgeRuntimeContext(stripEaSecurityRuntimeContext(value)),
  );
}
