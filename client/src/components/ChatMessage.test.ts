import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolCallEntry } from "./ChatMessage";

Object.assign(globalThis, { React });
const { ChatMessage } = await import("./ChatMessage");

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
});
