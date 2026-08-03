import type { AgentMemoryKind, AgentMemoryStatus } from "../db";
import { createHash } from "crypto";

export type MemoryObservationDecision = "observe" | "update" | "conflict" | "ignore";
export type MemoryEvidenceInput = {
  sourceType: "explicit" | "conversation" | "feedback" | "legacy";
  channel: string;
  sessionId?: string;
  requestId?: string;
  conversationId?: string;
  messageId?: string;
  sourceText: string;
  metadata?: Record<string, unknown>;
};

function enabled(value: unknown): boolean {
  return !/^(0|false|no|off)$/i.test(String(value || "true"));
}

export const managedMemoryEnabled = () => enabled(process.env.EA_MANAGED_MEMORY_ENABLED);
export const memoryConflictReviewEnabled = () => enabled(process.env.EA_MEMORY_CONFLICT_REVIEW_ENABLED);
export const memorySourceSnippetsEnabled = () => enabled(process.env.EA_MEMORY_SOURCE_SNIPPETS_ENABLED);

export function memoryEvidenceHash(input: MemoryEvidenceInput, content: string): string {
  return createHash("sha256").update([
    input.sourceType, input.channel, input.sessionId || "", input.requestId || "",
    input.conversationId || "", input.messageId || "", normalizedMemoryContent(content),
  ].join("\0")).digest("hex");
}

function normalizedMemoryContent(value: unknown): string {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

export function decideMemoryObservation(input: {
  currentStatus: AgentMemoryStatus;
  currentKind: AgentMemoryKind;
  currentContent: string;
  proposedKind: AgentMemoryKind;
  proposedContent: string;
  explicit: boolean;
  conflictReviewEnabled?: boolean;
}): MemoryObservationDecision {
  if (["forgotten", "rejected"].includes(input.currentStatus) && !input.explicit) return "ignore";
  const changed = input.currentKind !== input.proposedKind
    || normalizedMemoryContent(input.currentContent) !== normalizedMemoryContent(input.proposedContent);
  if (!changed) return "observe";
  if (input.explicit || input.currentStatus === "candidate" || input.conflictReviewEnabled === false) return "update";
  return "conflict";
}
