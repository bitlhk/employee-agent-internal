import { expect, it } from "vitest";
import { extractJiuwenChatMessagesFromRecords } from "./chat-history";
it("retains visible cards and final replies while keeping progress only in durable runtime context", () => {
  const row = (id: string, content: string, hidden = false) => ({ role: "assistant", request_id: `ea-context-${id}`, content, event_type: "chat.final", timestamp: 1792560000, ea_conversation: { resource: "run:1", actions: [], ...(hidden ? { presentation: "context-only" } : {}) } });
  const records = [row("1", "请求卡片"), row("2", "审批中", true), row("3", "查询中", true), row("4", "最终方案")];
  const messages = extractJiuwenChatMessagesFromRecords(records);
  expect(messages.map(m => m.text)).toEqual(["请求卡片", "最终方案"]);
  expect(records.length).toBe(4);
});
