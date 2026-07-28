import { describe, expect, it } from "vitest";
import {
  buildCapturedKnowledgeMarkdown,
  normalizeCapturedKnowledgeText,
  normalizeCapturedKnowledgeTitle,
} from "./knowledge-capture";

describe("knowledge capture", () => {
  it("builds an answer-only knowledge document", () => {
    const markdown = buildCapturedKnowledgeMarkdown({
      title: "  ## 客户经营复盘  ",
      answer: "先给结论，再展开依据。",
      capturedAt: new Date("2026-07-28T01:00:00.000Z"),
    });
    expect(markdown).toContain("# 客户经营复盘");
    expect(markdown).toContain("## 沉淀内容");
    expect(markdown).toContain("先给结论，再展开依据。");
    expect(markdown).not.toContain("## 本轮问题");
  });

  it("includes the question only for full-turn capture", () => {
    const markdown = buildCapturedKnowledgeMarkdown({
      title: "制度问答",
      question: "差旅住宿标准是多少？",
      answer: "按职级和城市分类执行。",
      includeQuestion: true,
      capturedAt: new Date("2026-07-28T01:00:00.000Z"),
    });
    expect(markdown).toContain("## 本轮问题");
    expect(markdown).toContain("差旅住宿标准是多少？");
  });

  it("removes private runtime paths and normalizes titles", () => {
    expect(normalizeCapturedKnowledgeText("产物在 /home/a/.jiuwenswarm/agent/workspace/report.md"))
      .toBe("产物在 workspace/report.md");
    expect(normalizeCapturedKnowledgeTitle("###  风控\n复盘  ")).toBe("风控 复盘");
  });
});
