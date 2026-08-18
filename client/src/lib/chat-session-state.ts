export const makeLxMsgId = () =>
  `lx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
export const makeClientRunId = () =>
  `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
export const makeConversationId = () =>
  `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
export const webConversationStorageKey = (userId: string, adoptId: string) =>
  `agent_web_conversation_${userId}_${adoptId}`;
export const legacyWebConversationStorageKeys = (
  userId: string,
  adoptId: string
) => [
  `lingxia_web_conversation_${userId}_${adoptId}`,
  `lingxia_web_conversation_${adoptId}`,
];
export const webMessagesStorageKey = (
  userId: string,
  adoptId: string,
  conversationId: string
) => `agent_web_messages_${userId}_${adoptId}_${conversationId}`;
export const legacyWebMessagesStorageKeys = (
  userId: string,
  adoptId: string,
  conversationId: string
) => [
  `lgc_msgs_${userId}_${adoptId}_${conversationId}`,
  `lgc_msgs_${adoptId}_${conversationId}`,
];
export const webDraftStorageKey = (
  userId: string,
  adoptId: string,
  conversationId: string
) => `agent_web_draft_${userId}_${adoptId}_${conversationId}`;
export const webExpertModeStorageKey = (
  userId: string,
  adoptId: string,
  conversationId: string
) => `agent_web_expert_${userId}_${adoptId}_${conversationId}`;
export const webKnowledgeStorageKey = (
  userId: string,
  adoptId: string,
  conversationId: string
) => `agent_web_knowledge_${userId}_${adoptId}_${conversationId}`;
export const legacyWebDraftStorageKey = (
  userId: string,
  adoptId: string,
  conversationId: string
) => `lingxia_web_draft_${userId}_${adoptId}_${conversationId}`;
export const webInputHistoryStorageKey = (userId: string, adoptId: string) =>
  `agent_web_input_history_${userId}_${adoptId}`;
export const legacyWebInputHistoryStorageKey = (
  userId: string,
  adoptId: string
) => `lingxia_web_input_history_${userId}_${adoptId}`;
export const webSessionIndexStorageKey = (userId: string, adoptId: string) =>
  `agent_web_sessions_${userId}_${adoptId}`;
export const legacyWebSessionIndexStorageKey = (
  userId: string,
  adoptId: string
) => `lingxia_web_sessions_${userId}_${adoptId}`;
export const webHiddenSessionsStorageKey = (userId: string, adoptId: string) =>
  `agent_web_sessions_hidden_${userId}_${adoptId}`;
export const legacyWebHiddenSessionsStorageKey = (
  userId: string,
  adoptId: string
) => `lingxia_web_sessions_hidden_${userId}_${adoptId}`;
export const clawStatusStorageKey = (userId: string, adoptId: string) =>
  `agent_claw_status_${userId}_${adoptId}`;
export const legacyClawStatusStorageKey = (userId: string, adoptId: string) =>
  `lingxia_claw_status_${userId}_${adoptId}`;
export const clawModelStorageKey = (userId: string, adoptId: string) =>
  `agent_claw_model_${userId}_${adoptId}`;
export const legacyClawModelStorageKey = (userId: string, adoptId: string) =>
  `lingxia_claw_model_${userId}_${adoptId}`;
export const clawModelFallbackStorageKey = (adoptId: string) =>
  `agent_claw_model_public_${adoptId}`;
export const legacyClawModelFallbackStorageKey = (adoptId: string) =>
  `lingxia_claw_model_public_${adoptId}`;

export const WORKSPACE_PANEL_WIDTH_KEY = "employee_agent_workspace_panel_width";
export const WORKSPACE_PANEL_DEFAULT_WIDTH = 400;
export const WORKSPACE_PANEL_MIN_WIDTH = 320;
export const WORKSPACE_PANEL_MAX_WIDTH = 560;

export function initialWorkspacePanelWidth(): number {
  try {
    const saved = Number(localStorage.getItem(WORKSPACE_PANEL_WIDTH_KEY));
    if (Number.isFinite(saved) && saved > 0) {
      return Math.min(
        WORKSPACE_PANEL_MAX_WIDTH,
        Math.max(WORKSPACE_PANEL_MIN_WIDTH, saved)
      );
    }
  } catch {}
  return WORKSPACE_PANEL_DEFAULT_WIDTH;
}

export type WebChatSessionRecord = {
  conversationId: string;
  sessionKey?: string;
  sessionId?: string;
  title: string;
  customTitle?: string;
  autoTitle?: boolean;
  preview: string;
  searchText?: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  sourceUpdatedAt?: number;
  sortUpdatedAt?: number;
  pinnedAt?: number;
  attention?: "running" | "needs_action" | "failed";
};

export function normalizeSessionText(text: string) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function compactSessionSearchText(text: string) {
  return normalizeSessionSearchText(text).replace(/\s+/g, "");
}

export function normalizeSessionSearchText(text: string) {
  return normalizeSessionText(text).toLowerCase();
}

function stripSessionMessagePrefix(text: string) {
  return String(text || "")
    .replace(
      /^\[[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s+GMT[+-]\d+\]\s*/g,
      ""
    )
    .trim();
}

function truncateSessionText(text: string, max = 28) {
  const normalized = normalizeSessionText(stripSessionMessagePrefix(text));
  if (!normalized) return "";
  return normalized.length > max
    ? `${normalized.slice(0, max)}...`
    : normalized;
}

export function inferSessionTitle(
  messages: Array<{ role?: string; text?: string }>
) {
  const firstUser = messages.find(
    message =>
      message.role === "user" && normalizeSessionText(message.text || "")
  );
  return truncateSessionText(firstUser?.text || "", 24) || "新对话";
}

export function inferSessionPreview(messages: Array<{ text?: string }>) {
  const last = [...messages]
    .reverse()
    .find(message => normalizeSessionText(message.text || ""));
  return truncateSessionText(last?.text || "", 42);
}

export function conversationHasMeaningfulContent(
  messages: Array<{ role?: string; text?: string }>,
  session?: Pick<WebChatSessionRecord, "messageCount" | "preview">,
) {
  if (Number(session?.messageCount || 0) > 0) return true;
  if (normalizeSessionText(session?.preview || "")) return true;
  return messages.some(
    message =>
      (message.role === "user" || message.role === "assistant") &&
      normalizeSessionText(message.text || ""),
  );
}

export function readLocalStorageWithLegacy(
  primaryKey: string,
  legacyKeys: string[] = []
): string {
  try {
    const primary = localStorage.getItem(primaryKey);
    if (primary) return primary;
    for (const legacyKey of legacyKeys) {
      const legacy = localStorage.getItem(legacyKey);
      if (legacy) {
        localStorage.setItem(primaryKey, legacy);
        return legacy;
      }
    }
  } catch {}
  return "";
}

export function removeLocalStorageKeys(keys: Array<string | null | undefined>) {
  try {
    for (const key of keys) {
      if (key) localStorage.removeItem(key);
    }
  } catch {}
}

export function readWebSessionIndex(
  key: string,
  legacyKeys: string[] = []
): WebChatSessionRecord[] {
  try {
    const parsed = JSON.parse(
      readLocalStorageWithLegacy(key, legacyKeys) || "[]"
    );
    return Array.isArray(parsed)
      ? parsed.filter(item => item?.conversationId)
      : [];
  } catch {
    return [];
  }
}

export function writeWebSessionIndex(
  key: string,
  sessions: WebChatSessionRecord[]
) {
  try {
    localStorage.setItem(key, JSON.stringify(sessions.slice(0, 30)));
  } catch {}
}

export function readHiddenWebSessions(
  key: string,
  legacyKeys: string[] = []
): Set<string> {
  try {
    const parsed = JSON.parse(
      readLocalStorageWithLegacy(key, legacyKeys) || "[]"
    );
    return new Set(
      Array.isArray(parsed)
        ? parsed.map(item => String(item)).filter(Boolean)
        : []
    );
  } catch {
    return new Set();
  }
}

export function writeHiddenWebSessions(key: string, hidden: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify(Array.from(hidden).slice(0, 200)));
  } catch {}
}

export function sortWebSessionRecords(sessions: WebChatSessionRecord[]) {
  return [...sessions].sort((left, right) => {
    const leftPinned = Number(left.pinnedAt || 0);
    const rightPinned = Number(right.pinnedAt || 0);
    if (leftPinned || rightPinned) return rightPinned - leftPinned;
    return (
      Number(
        right.sortUpdatedAt || right.sourceUpdatedAt || right.updatedAt || 0
      ) -
      Number(left.sortUpdatedAt || left.sourceUpdatedAt || left.updatedAt || 0)
    );
  });
}

export function normalizeSessionViewRecord(
  item: any
): WebChatSessionRecord | null {
  const conversationId = String(item?.conversationId || "").trim();
  const sessionKey = String(
    item?.sessionKey || item?.runtimeSessionKey || ""
  ).trim();
  if (!conversationId || !sessionKey) return null;
  const updatedAt =
    Number(
      item?.updatedAt || item?.sourceUpdatedAt || item?.sortUpdatedAt || 0
    ) || 0;
  const sourceUpdatedAt =
    Number(item?.sourceUpdatedAt || updatedAt) || updatedAt;
  const sortUpdatedAt =
    Number(item?.sortUpdatedAt || sourceUpdatedAt || updatedAt) ||
    sourceUpdatedAt ||
    updatedAt;
  return {
    conversationId,
    sessionKey,
    sessionId:
      String(item?.sessionId || item?.jiuwenSessionId || "").trim() ||
      undefined,
    title: normalizeSessionText(String(item?.title || "新对话")),
    preview: normalizeSessionText(String(item?.preview || "")),
    searchText: normalizeSessionText(String(item?.searchText || "")),
    messageCount: Number(item?.messageCount || 0) || 0,
    createdAt:
      Number(
        item?.createdAt ||
          updatedAt ||
          sourceUpdatedAt ||
          sortUpdatedAt ||
          Date.now()
      ) || Date.now(),
    updatedAt: updatedAt || sourceUpdatedAt || sortUpdatedAt || Date.now(),
    sourceUpdatedAt: sourceUpdatedAt || updatedAt,
    sortUpdatedAt: sortUpdatedAt || sourceUpdatedAt || updatedAt,
    attention: ["running", "needs_action", "failed"].includes(String(item?.attention || ""))
      ? item.attention
      : undefined,
  };
}

export function visibleWebSessionIndex(
  key: string,
  hiddenKey?: string | null,
  legacyKeys: string[] = [],
  legacyHiddenKeys: string[] = []
): WebChatSessionRecord[] {
  const hidden = hiddenKey
    ? readHiddenWebSessions(hiddenKey, legacyHiddenKeys)
    : new Set<string>();
  return sortWebSessionRecords(
    readWebSessionIndex(key, legacyKeys).filter(
      item => item?.conversationId && !hidden.has(item.conversationId)
    )
  );
}

export function mergeWebSessionRecords(
  local: WebChatSessionRecord[],
  remote: WebChatSessionRecord[],
  hidden: Set<string>
) {
  const byConversation = new Map<string, WebChatSessionRecord>();
  for (const item of [...local, ...remote]) {
    if (!item?.conversationId || hidden.has(item.conversationId)) continue;
    const previous = byConversation.get(item.conversationId);
    const itemHasBackendSession = Boolean(item.sessionKey);
    const previousHasBackendSession = Boolean(previous?.sessionKey);
    const itemUpdatedAt = Number(item.updatedAt || 0);
    const previousUpdatedAt = Number(previous?.updatedAt || 0);
    const localMeta = {
      customTitle: previous?.customTitle || item.customTitle,
      autoTitle: Boolean(previous?.autoTitle || item.autoTitle),
      pinnedAt: previous?.pinnedAt || item.pinnedAt,
    };
    if (!previous || itemUpdatedAt >= previousUpdatedAt) {
      byConversation.set(item.conversationId, {
        ...previous,
        ...item,
        ...localMeta,
      });
    } else if (item.sessionKey && !previous.sessionKey) {
      byConversation.set(item.conversationId, {
        ...previous,
        ...localMeta,
        sessionKey: item.sessionKey,
        sessionId: item.sessionId,
        searchText: item.searchText || previous.searchText,
      });
    } else if (itemHasBackendSession && !previousHasBackendSession) {
      byConversation.set(item.conversationId, {
        ...item,
        ...previous,
        ...localMeta,
        sessionKey: item.sessionKey,
        sessionId: item.sessionId,
        searchText: item.searchText || previous.searchText,
      });
    }
  }
  return sortWebSessionRecords(Array.from(byConversation.values())).slice(
    0,
    100
  );
}
