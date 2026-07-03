import { describe, expect, it } from "vitest";
import { parseSseBlockToChatEvents, parseWirePayloadToChatEvents } from "../../../client/src/lib/chat-event-parser";

describe("chat event parser", () => {
  it("parses HTTP transport sentinels", () => {
    expect(parseSseBlockToChatEvents("data: [DONE]\n\n")).toEqual([
      { type: "transport.done", transport: "http" },
    ]);

    expect(parseSseBlockToChatEvents('data: {"__stream_end":true}\n\n')).toEqual([
      { type: "transport.stream_end", transport: "http" },
    ]);
  });

  it("parses recover and length-limit transport events", () => {
    expect(parseSseBlockToChatEvents('data: {"__stream_truncated":true,"adoptId":"lgc-1","streamEndMs":123,"chatCompletionId":"chatcmpl-x"}\n\n')).toEqual([
      {
        type: "transport.truncated",
        transport: "http",
        adoptId: "lgc-1",
        sessionKey: undefined,
        streamEndMs: 123,
        startedAt: undefined,
        chatCompletionId: "chatcmpl-x",
        endReason: undefined,
        reason: undefined,
      },
    ]);

    expect(parseWirePayloadToChatEvents({ __stream_end_length: true })).toEqual([
      { type: "transport.length_limit" },
    ]);
  });

  it("parses OpenAI-compatible delta and finish_reason together", () => {
    const events = parseSseBlockToChatEvents('data: {"choices":[{"delta":{"reasoning_content":"think","content":[{"type":"text","text":"pong"}]},"finish_reason":"stop"}]}\n\n');

    expect(events).toEqual([
      { type: "delta", content: "pong" },
      { type: "finish_reason", reason: "stop" },
    ]);
  });

  it("does not treat OpenAI error:null chunks as transport errors", () => {
    expect(parseWirePayloadToChatEvents({ error: null, choices: [{ delta: { content: "ok" } }] })).toEqual([
      { type: "delta", content: "ok" },
    ]);
  });

  it("parses content block arrays explicitly", () => {
    expect(parseWirePayloadToChatEvents({ choices: [{ delta: { content: [{ type: "text", text: "hello" }, { text: " world" }] } }] })).toEqual([
      { type: "delta", content: "hello world" },
    ]);
  });

  it("parses tool and workspace events from SSE event names", () => {
    expect(parseSseBlockToChatEvents('event: tool_call\ndata: {"id":"tc1","name":"search","arguments":"{}"}\n\n')).toEqual([
      {
        type: "tool_call",
        phase: "start",
        toolCallId: "tc1",
        name: "search",
        args: "{}",
        gateway: false,
      },
    ]);

    expect(parseSseBlockToChatEvents('event: workspace_files\ndata: {"adoptId":"lgc-1","files":[{"name":"a.md","size":10,"path":"/out/a.md"}]}\n\n')).toEqual([
      { type: "workspace.files", adoptId: "lgc-1", files: [{ name: "a.md", size: 10, path: "/out/a.md" }] },
    ]);
  });

  it("parses WS business and status events", () => {
    expect(parseWirePayloadToChatEvents({ type: "connected", sessionKey: "agent:x", agentId: "x" })).toEqual([
      { type: "transport.connected", transport: "ws", sessionKey: "agent:x", agentId: "x" },
    ]);

    expect(parseWirePayloadToChatEvents({ _event: "agent_status", kind: "progress", tool: "shell", step: 1, total: 3, label: "running" })).toEqual([
      {
        type: "item_status",
        kind: "progress",
        tool: "shell",
        step: 1,
        total: 3,
        label: "running",
        elapsedMs: undefined,
        text: undefined,
      },
    ]);
  });

  it("promotes jiuwenswarm workflow updates to first-class chat events", () => {
    expect(parseWirePayloadToChatEvents({
      _event: "jiuwen_event",
      event_type: "workflow.updated",
      delta: {
        phase: "research",
        status: "running",
        agent_id: "analyst",
        workflow_id: "wf-1",
        run_id: "run-1",
        message: "reading filings",
      },
    })).toEqual([{
      type: "workflow.updated",
      phase: "research",
      status: "running",
      agentId: "analyst",
      workflowId: "wf-1",
      runId: "run-1",
      message: "reading filings",
      data: {
        phase: "research",
        status: "running",
        agent_id: "analyst",
        workflow_id: "wf-1",
        run_id: "run-1",
        message: "reading filings",
      },
    }]);
  });

  it("filters mismatched sessionKey when expectedSessionKey is provided", () => {
    expect(parseWirePayloadToChatEvents(
      { sessionKey: "agent:other:main", choices: [{ delta: { content: "leak" } }] },
      "",
      { expectedSessionKey: "agent:mine:main" },
    )).toEqual([]);

    expect(parseWirePayloadToChatEvents(
      { sessionKey: "agent:mine:main", choices: [{ delta: { content: "safe" } }] },
      "",
      { expectedSessionKey: "agent:mine:main" },
    )).toEqual([{ type: "delta", content: "safe" }]);
  });

  it("parses a production-style HTTP preview fixture", () => {
    const preview = [
      'data: {"id":"chatcmpl_real","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"}}]}',
      "",
      'data: {"id":"chatcmpl_real","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"哈哈"},"finish_reason":null}]}',
      "",
      'data: {"id":"chatcmpl_real","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"📡"},"finish_reason":null}]}',
      "",
      'data: {"id":"chatcmpl_real","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "",
    ].join("\n");

    const events = preview
      .split(/\n\n/)
      .flatMap((block) => parseSseBlockToChatEvents(block));

    expect(events).toEqual([
      { type: "delta", content: "哈哈" },
      { type: "delta", content: "📡" },
      { type: "finish_reason", reason: "stop" },
    ]);
  });
});
