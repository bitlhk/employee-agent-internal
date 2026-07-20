import { describe, expect, it } from "vitest";
import {
  applyAssistantFinalSnapshot,
  mergeAssistantStreamText,
  parseRuntimeRunDescriptor,
} from "./assistant-stream";

const markdown = [
  "## 已读完的 12 本书",
  "",
  "| # | 书名 | 作者 |",
  "|---|------|------|",
  "| 1 | 大明王朝1566（全集） | 刘和平 |",
  "| 2 | 明末农民战争史 | 顾诚 |",
].join("\n");

describe("assistant stream contract", () => {
  it("accepts only complete runtime run descriptors", () => {
    expect(parseRuntimeRunDescriptor({
      __run: { runId: "client-1", requestId: "request-1", sessionId: "session-1" },
    })).toEqual({ runId: "client-1", requestId: "request-1", sessionId: "session-1" });
    expect(parseRuntimeRunDescriptor({ __run: { requestId: "request-2", sessionId: "session-2" } })).toEqual({
      runId: "request-2",
      requestId: "request-2",
      sessionId: "session-2",
    });
    expect(parseRuntimeRunDescriptor({ __run: { requestId: "request-only" } })).toBeNull();
  });

  it("preserves Markdown across every character boundary", () => {
    for (let split = 0; split <= markdown.length; split += 1) {
      expect(mergeAssistantStreamText(markdown.slice(0, split), markdown.slice(split))).toBe(markdown);
    }
  });

  it("uses an explicit snapshot mode instead of guessing from text prefixes", () => {
    expect(mergeAssistantStreamText("#", "# 标题", "delta")).toBe("## 标题");
    expect(mergeAssistantStreamText("旧内容", markdown, "snapshot")).toBe(markdown);
  });

  it("replaces a malformed stream with the authoritative final snapshot", () => {
    const messages = [{ id: "assistant-1", role: "assistant", text: "| 书名 | 作者 |", status: "正在生成回复..." }];
    const next = applyAssistantFinalSnapshot(messages, "assistant-1", markdown);
    expect(next[0].text).toBe(markdown);
    expect(next[0].status).toBeUndefined();
  });
});
