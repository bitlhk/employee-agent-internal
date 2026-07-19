import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ConversationNavigator,
  buildConversationNavigatorItems,
  getVisibleConversationRailItems,
  type ConversationNavigatorSource,
} from "./ConversationNavigator";

describe("buildConversationNavigatorItems", () => {
  it("keeps user prompts only and flattens markdown for compact labels", () => {
    const messages: ConversationNavigatorSource[] = [
      { id: "u1", role: "user", text: "## 帮我分析\n\n**这份报告**" },
      { id: "a1", role: "assistant", text: "处理中" },
      { id: "u2", role: "user", text: "继续" },
    ];

    expect(buildConversationNavigatorItems(messages)).toEqual([
      { id: "u1", label: "帮我分析 这份报告", fullLabel: "帮我分析 这份报告" },
      { id: "u2", label: "继续", fullLabel: "继续" },
    ]);
  });

  it("uses attachment names instead of the upload placeholder", () => {
    const items = buildConversationNavigatorItems([
      {
        id: "u1",
        role: "user",
        text: "请查看我上传的附件。",
        attachments: [{ name: "年度报告.pdf" }, { name: "附表.xlsx" }],
      },
    ]);

    expect(items[0]).toEqual({
      id: "u1",
      label: "附件：年度报告.pdf 等 2 个",
      fullLabel: "附件：年度报告.pdf 等 2 个",
    });
  });

  it("truncates very long prompts without splitting unicode characters", () => {
    const [item] = buildConversationNavigatorItems([
      { id: "u1", role: "user", text: "量".repeat(60) },
    ]);

    expect(Array.from(item.label)).toHaveLength(55);
    expect(item.label.endsWith("...")).toBe(true);
  });
});

describe("ConversationNavigator", () => {
  it("stays hidden until a conversation has at least two prompts", () => {
    const html = renderToStaticMarkup(
      React.createElement(ConversationNavigator, {
        items: [{ id: "u1", label: "你好", fullLabel: "你好" }],
        onNavigate: vi.fn(),
      }),
    );

    expect(html).toBe("");
  });

  it("marks the prompt nearest the reading position", () => {
    const html = renderToStaticMarkup(
      React.createElement(ConversationNavigator, {
        items: [
          { id: "u1", label: "第一个问题", fullLabel: "第一个问题" },
          { id: "u2", label: "第二个问题", fullLabel: "第二个问题" },
        ],
        activeId: "u2",
        onNavigate: vi.fn(),
      }),
    );

    expect(html).toContain('aria-label="打开会话提纲"');
    expect(html.match(/conversation-navigator__mark/g)).toHaveLength(2);
    expect(html).not.toContain("conversation-navigator__header");
    expect(html).not.toContain("conversation-navigator__index");
    expect(html).toContain('aria-current="location"');
    expect(html).toContain("第二个问题");
  });

  it("caps the rail at twenty-four marks while keeping the active prompt visible", () => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      id: `u${index + 1}`,
      label: `问题 ${index + 1}`,
      fullLabel: `问题 ${index + 1}`,
    }));

    const visibleItems = getVisibleConversationRailItems(items, "u36");
    expect(visibleItems).toHaveLength(24);
    expect(visibleItems.some((item) => item.id === "u36")).toBe(true);

    const html = renderToStaticMarkup(
      React.createElement(ConversationNavigator, {
        items,
        activeId: "u36",
        onNavigate: vi.fn(),
      }),
    );
    expect(html.match(/conversation-navigator__mark/g)).toHaveLength(24);
    expect(html.match(/conversation-navigator__item/g)).toHaveLength(40);
  });
});
