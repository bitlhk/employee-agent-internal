import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatHistoryDeletionStore } from "./chat-history-deletion-store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("chat history deletion store", () => {
  it("persists a deletion across store instances", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-chat-deletion-"));
    roots.push(root);
    const file = path.join(root, "deletions.json");
    const first = new ChatHistoryDeletionStore(file);

    first.markDeleted({
      adoptId: "lgj-user",
      conversationId: "conv-1",
      sessionIds: ["session-e1", "session-e2"],
      enterpriseCleanupPending: true,
      deletedAt: "2026-08-25T08:00:00.000Z",
    });

    const reloaded = new ChatHistoryDeletionStore(file);
    expect(reloaded.isDeleted("lgj-user", "conv-1")).toBe(true);
    expect(reloaded.isDeleted("lgj-user", "conv-2")).toBe(false);
    expect(reloaded.entry("lgj-user", "conv-1")).toMatchObject({
      sessionIds: ["session-e1", "session-e2"],
      enterpriseCleanupPending: true,
    });
  });

  it("merges session epochs while updating cleanup state", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-chat-deletion-"));
    roots.push(root);
    const store = new ChatHistoryDeletionStore(path.join(root, "deletions.json"));

    store.markDeleted({
      adoptId: "lgj-user",
      conversationId: "conv-1",
      sessionIds: ["session-e1"],
      enterpriseCleanupPending: true,
    });
    store.markDeleted({
      adoptId: "lgj-user",
      conversationId: "conv-1",
      sessionIds: ["session-e2"],
      enterpriseCleanupPending: false,
    });

    expect(store.entry("lgj-user", "conv-1")).toMatchObject({
      sessionIds: ["session-e1", "session-e2"],
      enterpriseCleanupPending: false,
    });
  });
});
