export type ToolVisualKind =
  | "agent"
  | "browser"
  | "code"
  | "database"
  | "file"
  | "image"
  | "mcp"
  | "skill"
  | "terminal"
  | "web"
  | "generic";

export function classifyToolName(name: string): ToolVisualKind {
  const normalized = String(name || "").toLowerCase().replace(/[-\s]+/g, "_");

  if (/skill|capabilit/.test(normalized)) return "skill";
  if (/mcp|connector|integration/.test(normalized)) return "mcp";
  if (/browser|navigate|screenshot|page_|computer_use/.test(normalized)) return "browser";
  if (/bash|shell|terminal|command|exec/.test(normalized)) return "terminal";
  if (/read_file|write_file|list_file|workspace|attachment|document|file/.test(normalized)) return "file";
  if (/sql|mysql|postgres|database|db_query|query_db/.test(normalized)) return "database";
  if (/image|vision|ocr|video|media/.test(normalized)) return "image";
  if (/agent|delegate|handoff|task_submit/.test(normalized)) return "agent";
  if (/python|javascript|typescript|code|script/.test(normalized)) return "code";
  if (/search|weather|news|web|fetch|http/.test(normalized)) return "web";
  return "generic";
}
