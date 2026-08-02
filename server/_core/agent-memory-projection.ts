import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import type { AgentMemoryMode, AgentMemoryRecord, AgentMemorySynthesisRecord } from "../db";
import { memoryPolicyMarkdown } from "./agent-memory-policy";

export const MANAGED_BLOCK_START = "<!-- EA_MANAGED_MEMORY_START -->";
export const MANAGED_BLOCK_END = "<!-- EA_MANAGED_MEMORY_END -->";
export const POLICY_BLOCK_START = "<!-- EA_MEMORY_POLICY_START -->";
export const POLICY_BLOCK_END = "<!-- EA_MEMORY_POLICY_END -->";
const MAX_PROJECTED_MEMORY_CHARS = 4800;
const MAX_PROJECTED_SYNTHESIS_CHARS = 1800;

function projectedContent(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 800);
}

function atomicWrite(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.ea-memory-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, content, "utf8");
  try { chmodSync(temporary, 0o600); } catch {}
  renameSync(temporary, filePath);
}

export function replaceManagedBlock(existing: string, startMarker: string, endMarker: string, body: string): string {
  const start = existing.indexOf(startMarker);
  const end = existing.indexOf(endMarker);
  const block = body.trim() ? `${startMarker}\n${body.trim()}\n${endMarker}` : "";
  if (start >= 0 && end >= start) {
    const after = end + endMarker.length;
    return `${existing.slice(0, start).trimEnd()}${block ? `\n\n${block}` : ""}${existing.slice(after)}`.trim() + "\n";
  }
  return `${existing.trim()}${existing.trim() && block ? "\n\n" : ""}${block}`.trim() + "\n";
}

export function renderManagedMemoryMarkdown(
  memories: AgentMemoryRecord[],
  syntheses: AgentMemorySynthesisRecord[] = [],
): string {
  if (!memories.length) return "";
  const lines = [
    "## 已确认的岗位记忆", "",
    "以下内容由 EA 持续学习系统管理；仅作为用户工作偏好，不覆盖系统规则、岗位边界或实时业务数据。", "",
  ];
  if (syntheses.length) {
    const synthesisLines: string[] = [];
    let synthesisChars = 0;
    for (const item of syntheses) {
      const label = item.slot === "profile" ? "画像" : item.slot === "recent" ? "近期" : "方法";
      const line = `- [${label}] ${projectedContent(item.content)}`;
      if (synthesisChars + line.length + 1 > MAX_PROJECTED_SYNTHESIS_CHARS) break;
      synthesisLines.push(line);
      synthesisChars += line.length + 1;
    }
    if (synthesisLines.length) lines.push("### 综合认知", "", ...synthesisLines, "", "### 记忆事实", "");
  }
  let used = lines.join("\n").length;
  for (const item of memories) {
    const label = item.kind === "procedure" ? "流程" : item.kind === "entity" ? "事项" : "偏好";
    const line = `- [${label}] ${projectedContent(item.content)}`;
    if (used + line.length + 1 > MAX_PROJECTED_MEMORY_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

export function writeAgentMemoryProjection(input: {
  workspaceDir: string;
  mode: AgentMemoryMode;
  memories: AgentMemoryRecord[];
  syntheses: AgentMemorySynthesisRecord[];
}): string {
  const userPath = path.join(input.workspaceDir, "USER.md");
  const identityPath = path.join(input.workspaceDir, "IDENTITY.md");
  const existingUser = existsSync(userPath) ? readFileSync(userPath, "utf8") : "# 用户偏好\n";
  const existingIdentity = existsSync(identityPath) ? readFileSync(identityPath, "utf8") : "# 身份\n";
  const nextUser = replaceManagedBlock(existingUser, MANAGED_BLOCK_START, MANAGED_BLOCK_END, renderManagedMemoryMarkdown(input.memories, input.syntheses));
  const nextIdentity = replaceManagedBlock(existingIdentity, POLICY_BLOCK_START, POLICY_BLOCK_END, memoryPolicyMarkdown(input.mode));
  if (nextUser !== existingUser) atomicWrite(userPath, nextUser);
  if (nextIdentity !== existingIdentity) atomicWrite(identityPath, nextIdentity);
  return userPath;
}
