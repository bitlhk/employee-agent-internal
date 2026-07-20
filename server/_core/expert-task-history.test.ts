import { describe, expect, it } from "vitest";
import {
  buildExpertTaskHistoryMessages,
  buildExpertTaskHistorySessions,
  expertConversationIdFromSessionKey,
  expertHistorySessionKey,
  mergeExpertTaskHistorySessions,
} from "./expert-task-history";

const completedTask = {
  id: "agt_1234567890abcdef",
  sourceConversationId: "conv_expert_one",
  sourceMessageId: "lx-user-one",
  input: "分析这家公司的估值",
  resultMarkdown: "估值分析已完成。",
  status: "succeeded",
  agentId: "wind-alice",
  agentName: "万得金融专家",
  createdAt: "2026-07-21T01:00:00.000Z",
  completedAt: "2026-07-21T01:00:08.000Z",
};

describe("expert task history", () => {
  it("uses a validated synthetic session key", () => {
    expect(expertHistorySessionKey("conv_expert_one")).toBe("ea-expert:conv_expert_one");
    expect(expertConversationIdFromSessionKey("ea-expert:conv_expert_one")).toBe("conv_expert_one");
    expect(expertConversationIdFromSessionKey("ea-expert:../../etc/passwd")).toBe("");
  });

  it("rebuilds the user prompt and expert task marker", () => {
    const messages = buildExpertTaskHistoryMessages([completedTask]);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ id: "lx-user-one", role: "user", text: "分析这家公司的估值" });
    expect(messages[1]).toMatchObject({ role: "assistant" });
    expect(messages[1].text).toContain("已提交任务给 **万得金融专家**");
    expect(messages[1].text).toContain("agt_1234567890abcdef");
  });

  it("groups tasks into a durable expert-only conversation", () => {
    const sessions = buildExpertTaskHistorySessions([completedTask]);
    expect(sessions).toEqual([
      expect.objectContaining({
        conversationId: "conv_expert_one",
        sessionKey: "ea-expert:conv_expert_one",
        title: "分析这家公司的估值",
        preview: "估值分析已完成。",
        messageCount: 2,
      }),
    ]);
  });

  it("merges expert tasks into an existing runtime conversation", () => {
    const runtime = [{
      conversationId: "conv_expert_one",
      sessionKey: "sess_lgj-demo_web_conv_expert_one_e1",
      title: "普通对话",
      preview: "运行时回复",
      searchText: "普通对话 运行时回复",
      messageCount: 2,
      createdAt: Date.parse("2026-07-21T00:59:00.000Z"),
      updatedAt: Date.parse("2026-07-21T01:01:00.000Z"),
    }];
    const merged = mergeExpertTaskHistorySessions(runtime, buildExpertTaskHistorySessions([completedTask]), 20);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      sessionKey: "sess_lgj-demo_web_conv_expert_one_e1",
      title: "普通对话",
      preview: "运行时回复",
      messageCount: 4,
    });
    expect(merged[0].searchText).toContain("估值分析已完成");
  });
});
