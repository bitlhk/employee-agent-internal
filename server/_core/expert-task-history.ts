export const EXPERT_HISTORY_SESSION_PREFIX = "ea-expert:";

export type ExpertHistoryTask = {
  id: string;
  sourceConversationId?: string | null;
  sourceMessageId?: string | null;
  input?: string | null;
  resultMarkdown?: string | null;
  errorMessage?: string | null;
  status?: string | null;
  agentName?: string | null;
  agentId?: string | null;
  createdAt?: string | Date | number | null;
  startedAt?: string | Date | number | null;
  completedAt?: string | Date | number | null;
  updatedAt?: string | Date | number | null;
};

export type ExpertHistoryMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timeLabel: string;
  timestamp: number;
};

export type ExpertHistorySession = {
  conversationId: string;
  sessionKey: string;
  title: string;
  preview: string;
  searchText: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
};

function timeMs(value: ExpertHistoryTask["createdAt"], fallback = 0): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function compactText(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncateText(value: unknown, max: number): string {
  const text = compactText(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function conversationId(value: unknown): string {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) ? id : "";
}

function taskAgentName(task: ExpertHistoryTask): string {
  return compactText(task.agentName || task.agentId) || "金融专家";
}

function taskMessage(task: ExpertHistoryTask): string {
  return `已提交任务给 **${taskAgentName(task)}**，完成后结果会自动写回。\n\n任务编号：\`${task.id}\``;
}

function taskUpdatedAt(task: ExpertHistoryTask, createdAt: number): number {
  return timeMs(task.completedAt, 0)
    || timeMs(task.updatedAt, 0)
    || timeMs(task.startedAt, 0)
    || createdAt;
}

function taskPreview(task: ExpertHistoryTask): string {
  return truncateText(task.resultMarkdown || task.errorMessage || task.input, 42);
}

function historyTimeLabel(timestamp: number): string {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function expertHistorySessionKey(value: string): string {
  const id = conversationId(value);
  return id ? `${EXPERT_HISTORY_SESSION_PREFIX}${id}` : "";
}

export function expertConversationIdFromSessionKey(value: unknown): string {
  const key = String(value || "");
  if (!key.startsWith(EXPERT_HISTORY_SESSION_PREFIX)) return "";
  return conversationId(key.slice(EXPERT_HISTORY_SESSION_PREFIX.length));
}

export function buildExpertTaskHistoryMessages(
  tasks: ExpertHistoryTask[],
  maxMessages = 200,
): ExpertHistoryMessage[] {
  return tasks
    .filter((task) => task?.id && compactText(task.input))
    .slice()
    .sort((a, b) => timeMs(a.createdAt) - timeMs(b.createdAt) || String(a.id).localeCompare(String(b.id)))
    .flatMap((task) => {
      const createdAt = timeMs(task.createdAt, Date.now());
      return [
        {
          id: String(task.sourceMessageId || `${task.id}:user`),
          role: "user" as const,
          text: String(task.input || "").trim(),
          timeLabel: historyTimeLabel(createdAt),
          timestamp: createdAt,
        },
        {
          id: `${task.id}:assistant`,
          role: "assistant" as const,
          text: taskMessage(task),
          timeLabel: historyTimeLabel(createdAt + 1),
          timestamp: createdAt + 1,
        },
      ];
    })
    .slice(-Math.max(1, maxMessages));
}

export function buildExpertTaskHistorySessions(tasks: ExpertHistoryTask[]): ExpertHistorySession[] {
  const grouped = new Map<string, ExpertHistoryTask[]>();
  for (const task of tasks) {
    const id = conversationId(task.sourceConversationId);
    if (!id || !task?.id || !compactText(task.input)) continue;
    grouped.set(id, [...(grouped.get(id) || []), task]);
  }

  return Array.from(grouped.entries()).map(([id, rows]) => {
    const ordered = rows.slice().sort((a, b) => timeMs(a.createdAt) - timeMs(b.createdAt));
    const first = ordered[0];
    const latest = ordered.slice().sort((a, b) => {
      const aCreated = timeMs(a.createdAt);
      const bCreated = timeMs(b.createdAt);
      return taskUpdatedAt(b, bCreated) - taskUpdatedAt(a, aCreated);
    })[0];
    const createdAt = Math.min(...ordered.map((task) => timeMs(task.createdAt, Date.now())));
    const updatedAt = Math.max(...ordered.map((task) => {
      const created = timeMs(task.createdAt, createdAt);
      return taskUpdatedAt(task, created);
    }));
    return {
      conversationId: id,
      sessionKey: expertHistorySessionKey(id),
      title: truncateText(first?.input, 24) || "专家任务",
      preview: taskPreview(latest),
      searchText: compactText(ordered.flatMap((task) => [task.input, task.resultMarkdown, task.errorMessage]).join(" ")).slice(0, 12000),
      messageCount: ordered.length * 2,
      createdAt,
      updatedAt,
    };
  }).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function mergeExpertTaskHistorySessions<T extends {
  conversationId: string;
  sessionKey?: string;
  title?: string;
  preview?: string;
  searchText?: string;
  messageCount?: number;
  createdAt?: number;
  updatedAt?: number;
}>(runtimeSessions: T[], expertSessions: ExpertHistorySession[], limit: number): Array<T | ExpertHistorySession> {
  const merged = new Map<string, T | ExpertHistorySession>();
  for (const session of runtimeSessions) merged.set(session.conversationId, session);

  for (const expert of expertSessions) {
    const runtime = merged.get(expert.conversationId);
    if (!runtime) {
      merged.set(expert.conversationId, expert);
      continue;
    }
    const runtimeCreatedAt = Number(runtime.createdAt || runtime.updatedAt || 0);
    const runtimeUpdatedAt = Number(runtime.updatedAt || runtimeCreatedAt || 0);
    const expertIsEarlier = expert.createdAt < runtimeCreatedAt;
    const expertIsLater = expert.updatedAt >= runtimeUpdatedAt;
    merged.set(expert.conversationId, {
      ...runtime,
      title: expertIsEarlier ? expert.title : (runtime.title || expert.title),
      preview: expertIsLater ? expert.preview : (runtime.preview || expert.preview),
      searchText: compactText(`${runtime.searchText || ""} ${expert.searchText}`),
      messageCount: Number(runtime.messageCount || 0) + expert.messageCount,
      createdAt: Math.min(runtimeCreatedAt || expert.createdAt, expert.createdAt),
      updatedAt: Math.max(runtimeUpdatedAt, expert.updatedAt),
    } as T);
  }

  return Array.from(merged.values())
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, Math.max(1, limit));
}
