import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { JiuwenInteractionPrompt } from "./JiuwenInteractionPrompt";

describe("JiuwenInteractionPrompt", () => {
  it("renders every runtime question and its actual choices", () => {
    const html = renderToStaticMarkup(React.createElement(JiuwenInteractionPrompt, {
      request: {
        requestId: "ask-1",
        source: "ask_user_interrupt",
        kind: "question",
        title: "客户类型",
        question: "请选择客户类型",
        questions: [
          {
            header: "客户类型",
            question: "请选择客户类型",
            options: [{ label: "新保客户" }, { label: "续保客户" }],
            multiSelect: false,
          },
          {
            header: "难度",
            question: "请选择难度",
            options: [{ label: "简单" }, { label: "困难" }],
            multiSelect: false,
          },
        ],
      },
      selections: { "0": ["续保客户"] },
      onToggle: vi.fn(),
    }));

    expect(html).toContain("继续前请确认");
    expect(html).toContain("续保客户");
    expect(html).toContain("请选择难度");
    expect(html).not.toContain("本次允许");
    expect(html).toContain('aria-checked="true"');
  });
});
