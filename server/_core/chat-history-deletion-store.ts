import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { APP_ROOT } from "./helpers";
import { writeJsonFileAtomicSync } from "./atomic-json-file";

type ChatHistoryDeletionEntry = {
  adoptId: string;
  conversationId: string;
  sessionIds: string[];
  deletedAt: string;
  enterpriseCleanupPending: boolean;
};

type ChatHistoryDeletionFile = {
  version: 1;
  entries: Record<string, ChatHistoryDeletionEntry>;
};

function normalizedId(value: unknown, maxLength = 192): string {
  return String(value || "").trim().slice(0, maxLength);
}

function entryKey(adoptId: string, conversationId: string): string {
  return `${adoptId}\u0000${conversationId}`;
}

function emptyFile(): ChatHistoryDeletionFile {
  return { version: 1, entries: {} };
}

export class ChatHistoryDeletionStore {
  constructor(private readonly filePath: string) {}

  private read(): ChatHistoryDeletionFile {
    try {
      if (!existsSync(this.filePath)) return emptyFile();
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (parsed?.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
        return emptyFile();
      }
      return parsed as ChatHistoryDeletionFile;
    } catch {
      return emptyFile();
    }
  }

  markDeleted(input: {
    adoptId: string;
    conversationId: string;
    sessionIds?: string[];
    enterpriseCleanupPending?: boolean;
    deletedAt?: string;
  }): ChatHistoryDeletionEntry | null {
    const adoptId = normalizedId(input.adoptId, 128);
    const conversationId = normalizedId(input.conversationId);
    if (!adoptId || !conversationId) return null;
    const store = this.read();
    const key = entryKey(adoptId, conversationId);
    const previous = store.entries[key];
    const sessionIds = Array.from(new Set([
      ...(previous?.sessionIds || []),
      ...(input.sessionIds || []),
    ].map((value) => normalizedId(value)).filter(Boolean))).slice(0, 32);
    const entry: ChatHistoryDeletionEntry = {
      adoptId,
      conversationId,
      sessionIds,
      deletedAt: normalizedId(input.deletedAt || previous?.deletedAt || new Date().toISOString(), 64),
      enterpriseCleanupPending: Boolean(input.enterpriseCleanupPending),
    };
    store.entries[key] = entry;
    writeJsonFileAtomicSync(this.filePath, store);
    return entry;
  }

  isDeleted(adoptIdInput: string, conversationIdInput: string): boolean {
    const adoptId = normalizedId(adoptIdInput, 128);
    const conversationId = normalizedId(conversationIdInput);
    if (!adoptId || !conversationId) return false;
    return Boolean(this.read().entries[entryKey(adoptId, conversationId)]);
  }

  entry(adoptIdInput: string, conversationIdInput: string): ChatHistoryDeletionEntry | null {
    const adoptId = normalizedId(adoptIdInput, 128);
    const conversationId = normalizedId(conversationIdInput);
    if (!adoptId || !conversationId) return null;
    return this.read().entries[entryKey(adoptId, conversationId)] || null;
  }
}

export const chatHistoryDeletionStore = new ChatHistoryDeletionStore(
  process.env.CHAT_HISTORY_DELETION_STORE_PATH
    || path.join(APP_ROOT, "data", "chat-history-deletions.json"),
);
