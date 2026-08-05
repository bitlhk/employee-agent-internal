import type { AgentTask } from "@/components/AgentTaskCard";
import type { JiuwenPermissionRequestCard } from "@/components/ChatMessage";
import { parseAgentTaskArtifacts } from "@shared/agent-artifact";
import type { ExpertHandoffContext } from "@shared/expert-handoff-context";

const JIUWEN_PERMISSION_MARKER_RE =
  /<!--EA_JIUWEN_PERMISSION:([A-Za-z0-9+/=]+)-->/g;

export type ComposerSkillOption = {
  id: string;
  label: string;
  desc: string;
  source: string;
  initial: string;
  requiredMcpServers: string[];
};

function composerSkillInitial(skill: any, id: string): string {
  const candidates = [
    skill?.name,
    skill?.source?.name,
    skill?.source?.skillId,
    id,
  ];
  for (const candidate of candidates) {
    const match = String(candidate || "").match(/[A-Za-z]/);
    if (match) return match[0].toUpperCase();
  }
  return "S";
}

export function flattenComposerSkills(groups: any): ComposerSkillOption[] {
  const raw = [
    ...(Array.isArray(groups?.shared) ? groups.shared : []),
    ...(Array.isArray(groups?.system) ? groups.system : []),
    ...(Array.isArray(groups?.private) ? groups.private : []),
  ];
  const seen = new Set<string>();
  const out: ComposerSkillOption[] = [];
  for (const skill of raw) {
    const id = String(skill?.id || "").trim();
    if (!id || seen.has(id)) continue;
    const enabled = skill?.enabled !== false;
    const ready = !skill?.state || skill.state === "ready";
    const runnable = skill?.runnable !== false && skill?.active !== false;
    if (!enabled || !ready || !runnable) continue;
    seen.add(id);
    out.push({
      id,
      label:
        String(
          skill?.source?.displayName ||
            skill?.displayName ||
            skill?.label ||
            skill?.name ||
            id
        ).trim() || id,
      desc: String(
        skill?.desc || skill?.description || skill?.source?.description || ""
      ).trim(),
      source: String(skill?.scope || skill?.source || "skill").trim(),
      initial: composerSkillInitial(skill, id),
      requiredMcpServers: Array.isArray(skill?.requirements?.mcpServers)
        ? skill.requirements.mcpServers
            .map((value: unknown) => String(value || "").trim())
            .filter(Boolean)
        : [],
    });
  }
  return out.sort((left, right) =>
    left.label.localeCompare(right.label, "zh-CN")
  );
}

function encodeJiuwenPermissionMarker(permission: JiuwenPermissionRequestCard) {
  try {
    const payload = {
      requestId: permission.requestId,
      source: permission.source || "permission_interrupt",
      kind: permission.kind || (permission.source === "ask_user_interrupt" ? "question" : "permission"),
      title: permission.title || "权限审批",
      question: permission.question || "",
      command: permission.command || "",
      toolName: permission.toolName || "",
      options: permission.options || [],
      questions: permission.questions || [],
      state: permission.state || "pending",
    };
    return `\n\n<!--EA_JIUWEN_PERMISSION:${btoa(
      encodeURIComponent(JSON.stringify(payload))
    )}-->`;
  } catch {
    return "";
  }
}

export function extractJiuwenPermissionMarker(text: string): {
  text: string;
  permission?: JiuwenPermissionRequestCard;
} {
  let permission: JiuwenPermissionRequestCard | undefined;
  const cleanText = String(text || "")
    .replace(JIUWEN_PERMISSION_MARKER_RE, (_match, encoded: string) => {
      try {
        const parsed = JSON.parse(decodeURIComponent(atob(encoded)));
        if (parsed?.requestId) {
          permission = {
            requestId: String(parsed.requestId),
            source: String(parsed.source || "permission_interrupt"),
            kind: parsed.kind === "question" || parsed.source === "ask_user_interrupt" ? "question" : "permission",
            title: String(parsed.title || "权限审批"),
            question: String(parsed.question || ""),
            command: parsed.command ? String(parsed.command) : undefined,
            toolName: parsed.toolName ? String(parsed.toolName) : undefined,
            options: Array.isArray(parsed.options) ? parsed.options : undefined,
            questions: Array.isArray(parsed.questions) ? parsed.questions : undefined,
            state:
              parsed.state === "approved" ||
              parsed.state === "rejected" ||
              parsed.state === "answered" ||
              parsed.state === "error"
                ? parsed.state
                : "pending",
          };
        }
      } catch {}
      return "";
    })
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  return { text: cleanText, permission };
}

export function withJiuwenPermissionMarker(
  text: string,
  permission: JiuwenPermissionRequestCard
) {
  const extracted = extractJiuwenPermissionMarker(text);
  const visibleText = extracted.text || (permission.kind === "question"
    ? "我还需要你补充一些信息，选择后即可继续。"
    : "需要你的授权才能继续执行。");
  return `${visibleText}${encodeJiuwenPermissionMarker(permission)}`;
}

export function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 8000
): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

export function extractAgentTaskIds(text: unknown): string[] {
  return Array.from(
    String(text || "").matchAll(/\bagt_[A-Za-z0-9]{8,64}\b/g),
    match => match[0]
  );
}

export function messageAgentTaskIds(message: {
  text?: string;
  agentTaskIds?: string[];
}): string[] {
  return Array.from(
    new Set(
      [
        ...(Array.isArray(message.agentTaskIds) ? message.agentTaskIds : []),
        ...extractAgentTaskIds(message.text),
      ].filter(id => /^agt_[A-Za-z0-9]{8,64}$/.test(id))
    )
  );
}

function agentTaskTimestamp(task: AgentTask): number {
  const value =
    task.updatedAt ||
    task.updated_at ||
    task.completedAt ||
    task.completed_at ||
    task.createdAt ||
    task.created_at;
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function compactExpertSummary(value: unknown): string {
  return String(value || "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/```[a-z0-9_-]*|```/gi, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1800);
}

export function buildExpertHandoff(
  tasks: AgentTask[],
  expertId: string,
  expertName: string
): ExpertHandoffContext | null {
  const related = tasks
    .filter(task => String(task.agentId || task.agent_id || "") === expertId)
    .sort(
      (left, right) => agentTaskTimestamp(left) - agentTaskTimestamp(right)
    );
  if (related.length === 0) return null;
  const latest = related.at(-1)!;
  const byId = new Map(related.map(task => [task.id, task]));
  let root = latest;
  const visited = new Set<string>();
  while (root.parentTaskId || root.parent_task_id) {
    const parentId = String(root.parentTaskId || root.parent_task_id || "");
    if (!parentId || visited.has(parentId)) break;
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    root = parent;
  }
  const status = String(latest.status || "");
  const interactionStatus = String(
    latest.interactionStatus || latest.interaction_status || ""
  );
  const handoffStatus: ExpertHandoffContext["status"] =
    interactionStatus === "pending"
      ? "waiting_input"
      : status === "pending" || status === "running"
        ? "processing"
        : status === "failed" || status === "cancelled"
          ? "failed"
          : "completed";
  const artifacts = related.flatMap(task =>
    parseAgentTaskArtifacts(task.artifactsJson || task.artifacts_json).map(
      artifact => artifact.name
    )
  );
  return {
    schema: "ea.expert_handoff.v1",
    expertName,
    status: handoffStatus,
    goal: compactExpertSummary(root.input || root.prompt),
    latestSummary: compactExpertSummary(
      latest.resultMarkdown ||
        latest.result_markdown ||
        latest.result ||
        latest.errorMessage ||
        latest.error_message
    ),
    artifacts: Array.from(new Set(artifacts)).slice(0, 20),
  };
}
