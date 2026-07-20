import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

Object.assign(globalThis, { React });
const { ToolDetailRenderer } = await import("./ToolDetailRenderer");

describe("ToolDetailRenderer", () => {
  it("uses MCP-specific detail labels", () => {
    const html = renderToStaticMarkup(React.createElement(ToolDetailRenderer, {
      tool: {
        name: "mcp_wealth_assistant_customer__customer_list",
        arguments: '{"page":1}',
        result: '{"items":[]}',
        status: "done",
      },
    }));

    expect(html).toContain('data-tool-kind="mcp"');
    expect(html).toContain("请求参数");
    expect(html).toContain("返回结果");
  });

  it("uses terminal labels and preserves an error state", () => {
    const html = renderToStaticMarkup(React.createElement(ToolDetailRenderer, {
      tool: {
        name: "bash",
        arguments: '{"command":"pwd"}',
        result: "permission denied",
        status: "error",
      },
    }));

    expect(html).toContain('data-tool-kind="terminal"');
    expect(html).toContain("命令参数");
    expect(html).toContain("错误");
    expect(html).toContain("lingxia-toolcard__pre--danger");
  });
});
