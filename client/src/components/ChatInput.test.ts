import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatInput } from "./ChatInput";

describe("ChatInput toolbar", () => {
  it("places model, voice and send controls together on the right", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatInput, {
        value: "",
        onChange: vi.fn(),
        onSend: vi.fn(),
        voiceOnRight: true,
        showUtilityButtons: false,
        rightControls: React.createElement("span", { "data-control": "model" }, "模型"),
        renderAddMenu: () => React.createElement("button", { "aria-label": "添加" }, "+"),
      }),
    );

    const modelIndex = html.indexOf('data-control="model"');
    const voiceIndex = html.indexOf('aria-label="语音输入"');
    const sendIndex = html.indexOf('title="发送"');
    expect(modelIndex).toBeGreaterThan(-1);
    expect(voiceIndex).toBeGreaterThan(modelIndex);
    expect(sendIndex).toBeGreaterThan(voiceIndex);
    expect(html).not.toContain("导出 Markdown");
    expect(html).not.toContain('aria-label="新对话"');
  });

  it("exposes attachment availability to the custom add menu", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatInput, {
        value: "",
        onChange: vi.fn(),
        onSend: vi.fn(),
        streaming: true,
        renderAddMenu: ({ disabled }) => React.createElement("span", {
          "data-attachment-disabled": String(disabled),
        }),
      }),
    );

    expect(html).toContain('data-attachment-disabled="true"');
  });

  it("keeps the send action available for a selected interaction without text", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatInput, {
        value: "",
        onChange: vi.fn(),
        onSend: vi.fn(),
        canSubmitWithoutContent: true,
        interactionPanel: React.createElement("section", { "data-interaction": "pending" }, "请选择"),
      }),
    );

    expect(html.indexOf('data-interaction="pending"')).toBeLessThan(html.indexOf("main-chat-input"));
    expect(html).not.toContain('class="lingxia-send-btn" disabled=""');
  });
});
