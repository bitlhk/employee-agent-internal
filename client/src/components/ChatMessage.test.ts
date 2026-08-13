import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolCallEntry } from "./ChatMessage";

Object.assign(globalThis, { React });
const { ChatMessage, ToolExecutionReceipt } = await import("./ChatMessage");

function renderToolTimeline(
  toolCalls: ToolCallEntry[],
  options: { status?: string; streaming?: boolean; processingDurationMs?: number } = {},
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
      processingDurationMs: options.processingDurationMs,
    }),
  );
}

describe("ChatMessage tool timeline", () => {
  it("renders a compact Context Receipt from a persisted tool result", () => {
    const contextReceipt = {
      schema: "ea.context-receipt.v1",
      receiptId: "crpt_test",
      taskId: "WM-GT-02",
      principalFingerprint: "p".repeat(64),
      provided: {
        knowledge: [{ assetId: "policy-v22", label: "适当性制度 V2.2", version: "V2.2", contentHash: "h".repeat(64) }],
        businessData: [{ sourceSystem: "wealth_customer_mcp", label: "当前客户画像", entityRef: "customer-fingerprint", asOf: "2026-08-13T08:00:00.000Z", resultFingerprint: "d".repeat(64) }],
        memory: [],
        capabilities: [{ capabilityId: "prepare_wealth_allocation_context", label: "配置筛选", version: "1", sideEffect: "read" }],
      },
      cited: { knowledgeAssetIds: [] },
      applied: { policyDecisions: [], capabilityExecutions: [] },
      excluded: [],
      readiness: { status: "READY", requestedOutcome: "allocation", allowedOutcomes: ["allocation"], deniedOutcomes: [], reasons: [], remediation: [], decisionFingerprint: "r".repeat(64) },
      createdAt: "2026-08-13T08:00:00.000Z",
      receiptFingerprint: "f".repeat(64),
    };
    const html = renderToStaticMarkup(React.createElement(ChatMessage, {
      role: "assistant",
      text: "已完成配置建议。",
      isLast: true,
      isPlaceholder: false,
      streaming: false,
      displayName: "财富经理助手",
      modelId: "test-model",
      timeLabel: "16:00",
      toolCalls: [{
        id: "call-context",
        name: "prepare_wealth_allocation_context",
        arguments: "{}",
        result: `EA_WEALTH_ALLOCATION_CONTEXT:${JSON.stringify({ contextReceipt })}`,
        status: "done",
        ts: Date.now(),
      }],
    }));
    expect(html).toContain("本次依据");
    expect(html).toContain("2 项企业上下文");
    expect(html).toContain("当前就绪");
    expect(html).not.toContain("适当性制度 V2.2");
  });

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

  it("uses the authoritative end-to-end duration after a runtime timeout", () => {
    const html = renderToolTimeline(
      [
        {
          id: "call-timeout",
          name: "fetch_webpage",
          arguments: '{"url":"https://example.com"}',
          result: "ok",
          status: "done",
          durationMs: 1200,
          ts: Date.now() - 1200,
        },
      ],
      { streaming: false, processingDurationMs: 300_000 },
    );

    expect(html).toContain("5m 0s");
    expect(html).not.toContain("1s");
  });

  it("renders a compact source trigger for completed web results", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMessage, {
        role: "assistant",
        text: "这是检索后的回答。",
        isLast: true,
        isPlaceholder: false,
        streaming: false,
        displayName: "测试助手",
        modelId: "test-model",
        timeLabel: "09:00",
        toolCalls: [{
          id: "web-1",
          name: "fetch_webpage",
          arguments: '{"url":"https://example.com/report"}',
          result: "URL: https://example.com/report\nStatus: 200\nTitle: 示例报告\nContent:\n正文",
          status: "done",
          ts: Date.now(),
        }],
      }),
    );

    expect(html).toContain("lingxia-web-source-trigger");
    expect(html).toContain("查看 1 条来源");
    expect(html).toContain("来源");
  });

  it("groups duplicate displayed knowledge sources while retaining citation anchors", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMessage, {
        messageId: "msg-weather",
        role: "assistant",
        text: "结论一[知识1]，结论二[知识2]，结论三[知识3]，结论四[知识4]。",
        isLast: true,
        isPlaceholder: false,
        streaming: false,
        displayName: "测试助手",
        modelId: "test-model",
        timeLabel: "09:01",
        knowledgeSources: [1, 2, 3, 4].map((index) => ({
          index,
          chunkId: `doc-${index}:c1`,
          parentId: `doc-${index}:p1`,
          knowledgeBaseId: `kb-${index}`,
          knowledgeBaseName: "企业知识",
          documentId: `doc-${index}`,
          documentName: "SOURCES.md",
          position: "正文",
        })),
      }),
    );

    expect((html.match(/SOURCES\.md/g) || [])).toHaveLength(2);
    expect(html).toContain("正文 · 4 处");
    expect(html).toContain('id="ea-knowledge-source-msg-weather-4"');
  });

  it("does not display retrieved knowledge sources that the response never cites", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMessage, {
        role: "assistant",
        text: "这条回答没有使用知识库资料。",
        isLast: true,
        isPlaceholder: false,
        streaming: false,
        displayName: "测试助手",
        modelId: "test-model",
        timeLabel: "09:01",
        knowledgeSources: [{
          index: 1,
          chunkId: "doc-1:c1",
          parentId: "doc-1:p1",
          knowledgeBaseId: "kb-1",
          knowledgeBaseName: "企业知识",
          documentId: "doc-1",
          documentName: "不相关资料.md",
          position: "正文",
        }],
      }),
    );

    expect(html).not.toContain("参考资料");
    expect(html).not.toContain("不相关资料.md");
  });

  it("does not display a model-authored knowledge marker without source metadata", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMessage, {
        role: "assistant",
        text: "公开工具返回了这条信息。[知识1]",
        isLast: true,
        isPlaceholder: false,
        streaming: false,
        displayName: "测试助手",
        modelId: "test-model",
        timeLabel: "09:01",
      }),
    );

    expect(html).toContain("公开工具返回了这条信息。");
    expect(html).not.toContain("知识1");
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
    expect(html).toContain("本轮产物");
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

  it("renders a compact governed-memory receipt after an explicit save", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMessage, {
        role: "assistant",
        text: "好的，后续会按这个顺序处理。",
        isLast: true,
        isPlaceholder: false,
        streaming: false,
        displayName: "测试助手",
        modelId: "test-model",
        timeLabel: "09:00",
        onForgetMemory: () => undefined,
        toolCalls: [{
          id: "memory-1",
          name: "mcp_platform_tools_remember_preference",
          arguments: '{"content":"先提示风险，再给产品建议"}',
          result: JSON.stringify({
            content: [{
              type: "text",
              text: 'EA_MEMORY_RECEIPT:{"action":"remembered","id":42,"content":"先提示风险，再给产品建议"}',
            }],
          }),
          status: "done",
          ts: Date.now(),
        }],
      }),
    );

    expect(html).toContain("lingxia-memory-receipt");
    expect(html).toContain("已记住");
    expect(html).toContain("先提示风险，再给产品建议");
    expect(html).toContain("撤销");
  });
});
