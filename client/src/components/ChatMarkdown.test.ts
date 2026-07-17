import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

Object.assign(globalThis, { React });
const { ChatMarkdown } = await import("./ChatMarkdown");

function render(content: string, phase: "streaming" | "final" = "final") {
  return renderToStaticMarkup(React.createElement(ChatMarkdown, { content, phase }));
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
});
