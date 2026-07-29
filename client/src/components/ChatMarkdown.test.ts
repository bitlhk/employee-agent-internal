import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

Object.assign(globalThis, { React });
const { ChatMarkdown } = await import("./ChatMarkdown");

function render(
  content: string,
  phase: "streaming" | "final" = "final",
  knowledgeSourceIndexes: number[] = [],
  knowledgeCitationLabels: Record<number, string> = {},
  knowledgeCitationUrls: Record<number, string> = {},
) {
  return renderToStaticMarkup(React.createElement(ChatMarkdown, {
    content,
    phase,
    knowledgeSourceIndexes,
    knowledgeCitationLabels,
    knowledgeCitationUrls,
  }));
}

describe("ChatMarkdown", () => {
  it("renders valid multi-level headings without rewriting their markers", () => {
    const html = render("## 二级标题\n\n### 三级标题");
    expect(html).toContain('<h2 id="二级标题"');
    expect(html).toContain('<h3 id="三级标题"');
    expect(html).not.toContain("># 二级标题<");
  });

  it("renders a number-sign table header as a three-column GFM table", () => {
    const html = render([
      "## 已读完的 12 本书",
      "",
      "| # | 书名 | 作者 |",
      "|---|------|------|",
      "| 1 | 大明王朝1566（全集） | 刘和平 |",
    ].join("\n"));
    expect(html).toContain("<table");
    expect((html.match(/<th(?:\s|>)/g) || []).length).toBe(3);
    expect(html).toMatch(/<th[^>]*>#<\/th>/);
  });

  it("does not reinterpret fenced Markdown as document structure", () => {
    const html = render("```markdown\n## 示例\n```");
    expect(html).toContain("lingxia-codeblock");
    expect(html).not.toContain('<h2 id="示例"');
  });

  it("links known knowledge citations without rewriting code", () => {
    const html = render("住宿标准为 600 元[知识1]。`[知识1]`", "final", [1]);
    expect(html).toContain('href="#ea-knowledge-source-message-1"');
    expect(html).toContain('class="lingxia-md-citation"');
    expect(html).toContain("[知识1]</code>");
  });

  it("renders citation pages from trusted source metadata", () => {
    const html = render("市场份额为 7.67%[知识2]。", "final", [2], { 2: "第 27 页" });
    expect(html).toContain("[2 · 第 27 页]");
    expect(html).toContain('href="#ea-knowledge-source-message-2"');
  });

  it("opens a trusted knowledge citation at its original document page", () => {
    const href = "/api/knowledge/documents/doc_123/content?adoptId=lgj_test&knowledgeBaseId=kb_test#page=27";
    const html = render("市场份额为 7.67%[知识2]。", "final", [2], { 2: "第 27 页" }, { 2: href });
    expect(html).toContain(`href="${href.replaceAll("&", "&amp;")}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('class="lingxia-md-citation"');
  });

  it("normalizes an unbracketed table source into a clickable citation", () => {
    const html = render("| 风险 | 来源 |\n|---|---|\n| 毛利率波动 | 知识3 |", "final", [3], { 3: "第 33 页" });
    expect(html).toContain("[3 · 第 33 页]");
    expect(html).toContain('href="#ea-knowledge-source-message-3"');
  });
});
