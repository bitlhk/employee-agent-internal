import { describe, expect, it } from "vitest";

import {
  a2aConversationContextId,
  a2aRuntimeContextId,
  agentDailyRequestLimit,
  cleanA2AText,
} from "./claw-agent-tasks";

describe("cleanA2AText", () => {
  it("renders embedded structured tool output without business-specific interpretation", () => {
    const result = cleanA2AText(
      `trace data={'content': '{"record":"example","score":88,"status":"ready"}'} error=None`,
    );

    expect(result).toContain("```json");
    expect(result).toContain('"score": 88');
    expect(result).toContain('"status": "ready"');
  });

  it("preserves the final Markdown response after tool traces", () => {
    const result = cleanA2AText("trace\n[tool_result]\n# Final answer\n\nDone");

    expect(result).toBe("# Final answer\n\nDone");
  });

  it("removes file inventories when files are represented as structured artifacts", () => {
    const result = cleanA2AText([
      "已完成报告并通过检查。",
      "",
      "已创建文件：",
      "- projects/report/report.pdf",
      "- projects/report/qa.json",
      "",
      "下一步：请确认内容。",
      "",
      "### 本轮产物",
      "- [report.pdf](https://files.example.com/report.pdf)",
      "",
      "下载链接 1 小时内有效。",
    ].join("\n"), { hasStructuredArtifacts: true });

    expect(result).toBe("已完成报告并通过检查。\n\n下一步：请确认内容。");
  });
});

describe("a2aConversationContextId", () => {
  it("is stable inside one conversation and isolated across conversations", () => {
    const first = a2aConversationContextId("lgj-one", "expert-one", "conversation-one");

    expect(first).toMatch(/^ea-[a-f0-9]{32}$/);
    expect(a2aConversationContextId("lgj-one", "expert-one", "conversation-one")).toBe(first);
    expect(a2aConversationContextId("lgj-one", "expert-one", "conversation-two")).not.toBe(first);
    expect(a2aConversationContextId("lgj-two", "expert-one", "conversation-one")).not.toBe(first);
    expect(a2aConversationContextId("lgj-one", "expert-two", "conversation-one")).not.toBe(first);
  });

  it("omits context for legacy tasks without conversation or session identity", () => {
    expect(a2aConversationContextId("lgj-one", "expert-one", "")).toBeUndefined();
  });
});

describe("a2aRuntimeContextId", () => {
  it("reuses the conversation context by default", () => {
    expect(a2aRuntimeContextId({}, "lgj-one", "expert-one", "conversation-one"))
      .toBe(a2aConversationContextId("lgj-one", "expert-one", "conversation-one"));
  });

  it("lets stateless experts request a fresh remote context per task", () => {
    expect(a2aRuntimeContextId(
      { reuseConversationContext: false },
      "lgj-one",
      "expert-one",
      "conversation-one",
    )).toBeUndefined();
  });
});

describe("agentDailyRequestLimit", () => {
  it("does not interrupt multi-turn personal experts with a daily call limit", () => {
    expect(agentDailyRequestLimit({ visibility: "personal", maxDailyRequests: 20 })).toBe(0);
    expect(agentDailyRequestLimit({ visibility: "platform", maxDailyRequests: 20 })).toBe(20);
  });
});
