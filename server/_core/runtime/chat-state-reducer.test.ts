import { describe, expect, it } from "vitest";
import { reduceAgentChatState, type AgentChatMessage } from "../../../client/src/lib/chat-state-reducer";

const base = (text = ""): AgentChatMessage[] => [
  { id: "u1", role: "user", text: "hi", timeLabel: "10:00" },
  { id: "a1", role: "assistant", text, timeLabel: "10:00" },
];

describe("reduceAgentChatState", () => {
  it("appends delta to the targeted assistant immutably", () => {
    const input = base("hello");
    const output = reduceAgentChatState(input, { type: "delta", content: " world" }, { targetMessageId: "a1" });

    expect(output).not.toBe(input);
    expect(output[1]).toEqual({ ...input[1], text: "hello world" });
    expect(input[1].text).toBe("hello");
  });

  it("tracks thinking content and marks it done when text delta arrives", () => {
    const withThinking = reduceAgentChatState(base(), { type: "thinking", content: "plan" }, { targetMessageId: "a1", nowMs: 1000 });
    expect(withThinking[1].toolCalls?.[0]).toMatchObject({
      id: "thinking-1000",
      name: "thinking",
      result: "plan",
      status: "running",
    });

    const withDelta = reduceAgentChatState(withThinking, { type: "delta", content: "answer" }, { targetMessageId: "a1", nowMs: 2500 });
    expect(withDelta[1].text).toBe("answer");
    expect(withDelta[1].toolCalls?.[0]).toMatchObject({ status: "done", durationMs: 1500 });
  });

  it("handles tool start and result by toolCallId", () => {
    const started = reduceAgentChatState(base(), {
      type: "tool_call",
      phase: "start",
      toolCallId: "tc1",
      name: "search",
      args: "{}",
    }, { targetMessageId: "a1", nowMs: 100 });

    const done = reduceAgentChatState(started, {
      type: "tool_call",
      phase: "result",
      toolCallId: "tc1",
      result: "ok",
    }, { targetMessageId: "a1", nowMs: 350 });

    expect(done[1].toolCalls?.[0]).toMatchObject({
      id: "tc1",
      name: "search",
      result: "ok",
      status: "done",
      durationMs: 250,
    });
  });

  it("attaches workspace files as a pseudo tool card", () => {
    const output = reduceAgentChatState(base(), {
      type: "workspace.files",
      adoptId: "lgc-1",
      files: [{ name: "report.md", size: 12, path: "/out/report.md" }],
    }, { targetMessageId: "a1", nowMs: 200 });

    expect(output[1].toolCalls?.[0]).toMatchObject({
      id: "ws-files-200",
      name: "[产出文件]",
      result: "report.md",
      status: "done",
      executor: "native",
      adoptId: "lgc-1",
    });
  });

  it("marks the targeted message as recovering without touching later assistants", () => {
    const messages: AgentChatMessage[] = [
      ...base("partial"),
      { id: "a2", role: "assistant", text: "newer", timeLabel: "10:01" },
    ];

    const output = reduceAgentChatState(messages, { type: "transport.truncated", streamEndMs: 1 }, { targetMessageId: "a1" });

    expect(output[1]).toMatchObject({ recovering: true, partialText: "partial" });
    expect(output[2]).toEqual(messages[2]);
  });

  it("marks thinking done on finish_reason stop", () => {
    const withThinking = reduceAgentChatState(base(), { type: "thinking", content: "plan" }, { targetMessageId: "a1", nowMs: 1000 });
    const stopped = reduceAgentChatState(withThinking, { type: "finish_reason", reason: "stop" }, { targetMessageId: "a1", nowMs: 1600 });

    expect(stopped[1].toolCalls?.[0]).toMatchObject({ status: "done", durationMs: 600 });
  });

  it("updates assistant status from item_status events", () => {
    const output = reduceAgentChatState(base(), { type: "item_status", text: "搜索中..." }, { targetMessageId: "a1" });

    expect(output[1].status).toBe("搜索中...");
  });

  it("uses messageId from transport.truncated when present", () => {
    const messages: AgentChatMessage[] = [
      ...base("partial"),
      { id: "a2", role: "assistant", text: "newer", timeLabel: "10:01" },
    ];

    const output = reduceAgentChatState(messages, { type: "transport.truncated", messageId: "a1", streamEndMs: 1 });

    expect(output[1]).toMatchObject({ recovering: true, partialText: "partial" });
    expect(output[2]).toEqual(messages[2]);
  });

  it("recovers a targeted message by messageId", () => {
    const messages = reduceAgentChatState(base("partial"), { type: "transport.truncated", messageId: "a1", streamEndMs: 1 });
    const output = reduceAgentChatState(messages, { type: "transport.recovered", messageId: "a1", text: "full answer" });

    expect(output[1]).toMatchObject({
      text: "full answer",
      recovering: false,
      recovered: true,
      recoveryFailed: false,
      partialText: undefined,
    });
  });

  it("marks recovery failures without losing partial text", () => {
    const messages = reduceAgentChatState(base("partial"), { type: "transport.truncated", messageId: "a1", streamEndMs: 1 });
    const output = reduceAgentChatState(messages, { type: "transport.recovery_failed", messageId: "a1", reason: "timeout" });

    expect(output[1]).toMatchObject({
      recovering: false,
      recovered: false,
      recoveryFailed: true,
    });
    expect(output[1].text).toContain("partial");
    expect(output[1].text).toContain("内容恢复失败");
  });

  it("appends length-limit warning once", () => {
    const once = reduceAgentChatState(base("answer"), { type: "transport.length_limit" }, { targetMessageId: "a1" });
    const twice = reduceAgentChatState(once, { type: "transport.length_limit" }, { targetMessageId: "a1" });

    expect(once[1].text).toContain("已达模型长度上限");
    expect(twice[1].text).toBe(once[1].text);
  });

  it("writes transport errors only into empty assistant placeholders", () => {
    const empty = reduceAgentChatState(base(), { type: "transport.error", message: "boom" }, { targetMessageId: "a1" });
    const nonEmpty = reduceAgentChatState(base("keep"), { type: "transport.error", message: "boom" }, { targetMessageId: "a1" });

    expect(empty[1].text).toBe("（boom）");
    expect(nonEmpty[1].text).toBe("keep");
  });
});
