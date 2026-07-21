import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ExpertInteractionPrompt } from "./ExpertInteractionPrompt";

describe("ExpertInteractionPrompt", () => {
  it("renders compact choices and the selected state inside the composer", () => {
    const html = renderToStaticMarkup(React.createElement(ExpertInteractionPrompt, {
      expertName: "PPT 专家",
      interaction: {
        schema: "ea.interaction.v1",
        interactionId: "style-1",
        type: "single_choice",
        title: "请选择风格",
        options: [
          { id: "brief", label: "简洁汇报" },
          { id: "full", label: "完整方案", recommended: true },
        ],
        allowCustom: true,
        allowNote: true,
        submitMode: "confirm",
      },
      selectedOptionId: "full",
      onSelect: vi.fn(),
    }));

    expect(html).toContain("PPT 专家需要确认");
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("推荐");
  });
});
