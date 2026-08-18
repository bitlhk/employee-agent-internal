import { describe, expect, it } from "vitest";
import { conversationHasMeaningfulContent } from "./chat-session-state";

describe("conversationHasMeaningfulContent", () => {
  it("reuses an existing empty conversation", () => {
    expect(conversationHasMeaningfulContent([], { messageCount: 0, preview: "" })).toBe(false);
    expect(conversationHasMeaningfulContent([
      { role: "system", text: "runtime metadata" },
    ], { messageCount: 0, preview: "" })).toBe(false);
  });

  it("starts a new conversation after user-visible content exists", () => {
    expect(conversationHasMeaningfulContent([
      { role: "user", text: "帮我准备客户拜访" },
    ], { messageCount: 0, preview: "" })).toBe(true);
    expect(conversationHasMeaningfulContent([], { messageCount: 2, preview: "" })).toBe(true);
    expect(conversationHasMeaningfulContent([], { messageCount: 0, preview: "已有摘要" })).toBe(true);
  });
});
