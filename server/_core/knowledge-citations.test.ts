import { describe, expect, it } from "vitest";
import { formatKnowledgeCitations, validateKnowledgeCitations } from "@shared/knowledge-citations";

describe("knowledge citation validation", () => {
  it("normalizes valid references and removes unknown source ids", () => {
    const result = validateKnowledgeCitations(
      "结论一[知识1 第 162 页]，结论二[知识9]，结论三[知识2]。",
      [1, 2],
    );
    expect(result.text).toBe("结论一[知识1]，结论二，结论三[知识2]。");
    expect(result.normalizedCount).toBe(1);
    expect(result.removedCount).toBe(1);
  });

  it("does not rewrite examples inside fenced code blocks", () => {
    const result = validateKnowledgeCitations("正文[知识1]\n`[知识99]`\n```text\n[知识99]\n```", [1]);
    expect(result.text).toContain("正文[知识1]");
    expect(result.text).toContain("`[知识99]`");
    expect(result.text).toContain("[知识99]");
  });

  it("normalizes compact Markdown headings for knowledge answers", () => {
    const result = validateKnowledgeCitations("#一、核心业务\n## 二级标题[知识1]", [1]);
    expect(result.text).toBe("# 一、核心业务\n## 二级标题[知识1]");
    expect(result.markdownNormalizedCount).toBe(1);
  });

  it("formats copied citations with server-provided page labels", () => {
    expect(formatKnowledgeCitations("结论[知识2]，`[知识2]`", { 2: "第 27 页" })).toBe(
      "结论[2 · 第 27 页]，`[知识2]`",
    );
  });
});
