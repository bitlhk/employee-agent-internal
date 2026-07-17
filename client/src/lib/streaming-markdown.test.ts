import { describe, expect, it } from "vitest";
import { stabilizeStreamingMarkdown, streamingMarkdownRenderDelay } from "./streaming-markdown";

describe("streaming Markdown stabilization", () => {
  it("keeps normal prose streaming without delay-specific formatting", () => {
    expect(stabilizeStreamingMarkdown("正在整理结")).toBe("正在整理结");
    expect(streamingMarkdownRenderDelay("正在整理结")).toBe(48);
  });

  it("holds a table until its header separator is complete", () => {
    expect(stabilizeStreamingMarkdown("查询结果\n\n| 项目 | 内容 |\n")).toBe("查询结果\n\n");
    expect(stabilizeStreamingMarkdown("查询结果\n\n| 项目 | 内容 |\n| --- | --")).toBe("查询结果\n\n");
  });

  it("reveals complete rows atomically while holding the active row", () => {
    const partial = [
      "查询结果",
      "",
      "| 项目 | 内容 |",
      "| --- | --- |",
      "| 状态 | 正常 |",
      "| 说明 | 正在生",
    ].join("\n");
    const rendered = stabilizeStreamingMarkdown(partial);
    expect(rendered).toContain("| 状态 | 正常 |");
    expect(rendered).not.toContain("正在生");
    expect(streamingMarkdownRenderDelay(partial)).toBe(90);
  });

  it("still closes an unfinished code fence during streaming", () => {
    expect(stabilizeStreamingMarkdown("```ts\nconst value = 1;")).toBe("```ts\nconst value = 1;\n```");
    expect(stabilizeStreamingMarkdown("```text\n| not | a partial table")).toBe("```text\n| not | a partial table\n```");
  });

  it("completes inline syntax only in the streaming render copy", () => {
    expect(stabilizeStreamingMarkdown("正在输出 **重点")).toBe("正在输出 **重点**");
  });

  it("leaves a complete heading and numbered GFM table byte-for-byte unchanged", () => {
    const complete = [
      "## 已读完的 12 本书",
      "",
      "| # | 书名 | 作者 |",
      "|---|------|------|",
      "| 1 | 大明王朝1566（全集） | 刘和平 |",
    ].join("\n");
    expect(stabilizeStreamingMarkdown(complete)).toBe(complete);
  });
});
