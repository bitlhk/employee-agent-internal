import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolCallEntry } from "./ChatMessage";
Object.assign(globalThis, { React });
const { MessageAttachments } = await import("./MessageAttachments");

const internalPaths = [
  "SOUL.md",
  "AGENT.md",
  "HEARTBEAT.md",
  "coding_memory/MEMORY.md",
];
const cachedTool: ToolCallEntry = {
  id: "old-artifact",
  name: "[产出文件]",
  arguments: "{}",
  status: "done",
  ts: 1,
  adoptId: "lgj-demo",
  outputFiles: internalPaths.map(path => ({
    name: path.split("/").at(-1)!,
    wsPath: path,
    size: 1,
  })),
};
describe("message artifact visibility", () => {
  it("hides old cached internal artifacts without leaving an empty artifact heading", () => {
    const html = renderToStaticMarkup(
      React.createElement(MessageAttachments, { toolCalls: [cachedTool] })
    );
    expect(html).toBe("");
  });
  it("keeps real document, image and code exports alongside filtered cached files", () => {
    const tool: ToolCallEntry = {
      ...cachedTool,
      outputFiles: [
        ...cachedTool.outputFiles!,
        ...[
          "output/report.pdf",
          "output/table.xlsx",
          "output/chart.png",
          "output/script.py",
          "exports/AGENT.md",
        ].map(path => ({
          name: path.split("/").at(-1)!,
          wsPath: path,
          size: 12,
        })),
      ],
    };
    const html = renderToStaticMarkup(
      React.createElement(MessageAttachments, { toolCalls: [tool] })
    );
    expect(html).toContain("本轮产物");
    for (const name of [
      "report.pdf",
      "table.xlsx",
      "chart.png",
      "script.py",
      "AGENT.md",
    ])
      expect(html).toContain(name);
    expect(html).not.toContain("SOUL.md");
    expect(html).not.toContain("HEARTBEAT.md");
    expect(html).not.toContain("MEMORY.md");
  });
  it("preserves user-uploaded attachments even when the name matches an internal file", () => {
    const html = renderToStaticMarkup(
      React.createElement(MessageAttachments, {
        variant: "user",
        attachments: [
          { name: "SOUL.md", size: 12, path: "SOUL.md", adoptId: "lgj-demo" },
        ],
      })
    );
    expect(html).toContain("SOUL.md");
    expect(html).toContain("上传的附件");
    expect(html).not.toContain("本轮产物");
  });
  it("does not let cached internal files consume the twenty-file display limit", () => {
    const tool: ToolCallEntry = {
      ...cachedTool,
      outputFiles: [
        ...cachedTool.outputFiles!,
        ...Array.from({ length: 20 }, (_, i) => ({
          name: `report-${i + 1}.pdf`,
          size: 12,
          wsPath: `output/report-${i + 1}.pdf`,
        })),
      ],
    };
    const html = renderToStaticMarkup(
      React.createElement(MessageAttachments, { toolCalls: [tool] })
    );
    expect(html).toContain("report-20.pdf");
    expect(html).not.toContain("SOUL.md");
  });
});
