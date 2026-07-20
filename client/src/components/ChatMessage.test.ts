import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolCallEntry } from "./ChatMessage";

Object.assign(globalThis, { React });
const { ChatMessage, ToolExecutionReceipt } = await import("./ChatMessage");

function renderToolTimeline(
  toolCalls: ToolCallEntry[],
  options: { status?: string; streaming?: boolean } = {},
) {
  return renderToStaticMarkup(
    React.createElement(ChatMessage, {
      role: "assistant",
      text: "",
      status: options.status,
      isLast: true,
      isPlaceholder: true,
      streaming: options.streaming ?? true,
      displayName: "测试助手",
      modelId: "test-model",
      timeLabel: "09:00",
      toolCalls,
    }),
  );
}

describe("ChatMessage tool timeline", () => {
  it("distinguishes chat roles without rendering repeated avatars or labels", () => {
    const userHtml = renderToStaticMarkup(
      React.createElement(ChatMessage, {
        role: "user",
        text: "请分析这份报告",
        isLast: false,
        isPlaceholder: false,
        streaming: false,
        displayName: "测试助手",
        modelId: "test-model",
        timeLabel: "09:00",
      }),
    );
    const assistantHtml = renderToStaticMarkup(
      React.createElement(ChatMessage, {
        role: "assistant",
        text: "这是分析结果。",
        isLast: true,
        isPlaceholder: false,
        streaming: false,
        displayName: "测试助手",
        modelId: "test-model",
        timeLabel: "09:01",
      }),
    );

    expect(userHtml).toContain("lingxia-bubble-user");
    expect(userHtml).toContain("lingxia-user-message-time");
    expect(userHtml).not.toContain("You ·");
    expect(userHtml).not.toContain("lingxia-avatar");
    expect(assistantHtml).toContain("lingxia-bubble-ai");
    expect(assistantHtml).not.toContain("lingxia-avatar");
  });

  it("renders a collapsed running summary without mounting detail content", () => {
    const html = renderToolTimeline(
      [
        {
          id: "call-1",
          name: "web_search",
          arguments: '{"query":"test"}',
          status: "running",
          ts: Date.now(),
        },
      ],
      { status: "正在调用工具：web_search" },
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("lingxia-tool-summary__loader");
    expect(html).toContain("搜索网页");
    expect(html).not.toContain("lingxia-tool-timeline-panel");
    expect(html).not.toContain("lingxia-bubble-ai");
  });

  it("uses the matching tool icon after the call completes", () => {
    const html = renderToolTimeline(
      [
        {
          id: "call-2",
          name: "web_search",
          arguments: '{"query":"test"}',
          result: "ok",
          status: "done",
          durationMs: 1200,
          ts: Date.now() - 1200,
        },
      ],
      { streaming: false },
    );

    expect(html).toContain("is-done");
    expect(html).toContain("lucide-search");
    expect(html).toContain("完成");
  });

  it("shows execution evidence only when the runtime provides it", () => {
    const withEvidence = renderToStaticMarkup(
      React.createElement(ToolExecutionReceipt, { toolCalls: [{
        id: "call-evidence",
        name: "mcp_customer_query",
        arguments: "{}",
        result: "ok",
        status: "done",
        durationMs: 300,
        ts: Date.now() - 300,
        executor: "sandbox",
        auditId: "audit-001",
        adoptId: "lgj-test",
      }] }),
    );
    const withoutEvidence = renderToStaticMarkup(
      React.createElement(ToolExecutionReceipt, { toolCalls: [{
        id: "call-plain",
        name: "web_search",
        arguments: "{}",
        result: "ok",
        status: "done",
        ts: Date.now(),
      }] }),
    );

    expect(withEvidence).toContain("执行凭据");
    expect(withEvidence).toContain("实例身份已绑定");
    expect(withEvidence).toContain("沙箱隔离");
    expect(withEvidence).toContain("审计留痕 1 条");
    expect(withoutEvidence).not.toContain("执行凭据");
  });

  it("moves the post-tool phase into the timeline instead of a duplicate bubble", () => {
    const html = renderToolTimeline(
      [
        {
          id: "call-3",
          name: "read_file",
          arguments: '{"path":"report.md"}',
          result: "ok",
          status: "done",
          durationMs: 400,
          ts: Date.now() - 400,
        },
      ],
      { status: "正在整理结果..." },
    );

    expect(html).toContain("正在整理结果...");
    expect(html).toContain("lingxia-tool-summary__loader");
    expect(html).not.toContain("lingxia-bubble-ai");
  });

  it("keeps the waiting bubble when no tool timeline is available", () => {
    const html = renderToolTimeline([], { status: "正在连接..." });

    expect(html).toContain("lingxia-bubble-ai");
    expect(html).toContain("正在连接...");
  });

  it("renders generated files as direct message attachments", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMessage, {
        role: "assistant",
        text: "报告已经生成。",
        isLast: true,
        isPlaceholder: false,
        streaming: false,
        displayName: "测试助手",
        modelId: "test-model",
        timeLabel: "09:00",
        toolCalls: [{
          id: "files-1",
          name: "[产出文件]",
          arguments: "{}",
          result: "report.pdf",
          status: "done",
          ts: Date.now(),
          adoptId: "lgj-test",
          outputFiles: [{ name: "report.pdf", size: 2048, wsPath: "output/report.pdf" }],
        }],
      }),
    );

    expect(html).toContain("lingxia-message-attachments");
    expect(html).toContain("report.pdf");
    expect(html).toContain("2.0 KB");
    expect(html).toContain('title="预览"');
    expect(html).toContain('title="下载"');
    expect(html).not.toContain("lingxia-tool-summary");
  });

  it("renders uploaded files as user attachment cards without exposing workspace paths", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMessage, {
        role: "user",
        text: "请帮我看看这篇论文",
        isLast: false,
        isPlaceholder: false,
        streaming: false,
        displayName: "测试助手",
        modelId: "test-model",
        timeLabel: "09:00",
        attachments: [{
          name: "量子线路.pdf",
          size: 328 * 1024,
          path: "prompt_attachment/quantum.pdf",
          adoptId: "lgj-test",
        }],
      }),
    );

    expect(html).toContain("请帮我看看这篇论文");
    expect(html).toContain("量子线路.pdf");
    expect(html).toContain("328.0 KB");
    expect(html).toContain('aria-label="上传的附件"');
    expect(html).not.toContain("prompt_attachment/quantum.pdf");
    expect(html).not.toContain("workspace path");
  });

  it("renders feedback actions only for a completed assistant reply", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMessage, {
        role: "assistant",
        text: "这是完整回复。",
        isLast: true,
        isPlaceholder: false,
        streaming: false,
        displayName: "测试助手",
        modelId: "test-model",
        timeLabel: "09:00",
        feedback: { rating: "positive", reasonCodes: [] },
        onFeedback: () => undefined,
      }),
    );

    expect(html).toContain('title="撤销有帮助反馈"');
    expect(html).toContain('title="没有帮助"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-feedback="positive"');
    expect(html).not.toContain("测试助手 · test-model");
    expect(html).not.toContain("↑");
    expect(html).not.toContain("ctx");
  });
});
