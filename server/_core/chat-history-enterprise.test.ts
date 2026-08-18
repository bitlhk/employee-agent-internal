import { describe, expect, it } from "vitest";
import {
  extractJiuwenChatMessagesFromRecords,
  normalizeEnterpriseHistorySessions,
} from "./chat-history";
import { resolveEnterpriseHistoryMaxPages } from "./enterprise-runtime-history";

describe("enterprise runtime chat history", () => {
  it("allows bounded compatibility paging for pre-compaction transcripts", () => {
    expect(resolveEnterpriseHistoryMaxPages(200, undefined)).toBe(20);
    expect(resolveEnterpriseHistoryMaxPages(500, "6")).toBe(10);
    expect(resolveEnterpriseHistoryMaxPages(200, "1000")).toBe(40);
    expect(resolveEnterpriseHistoryMaxPages(200, "invalid")).toBe(20);
  });

  it("groups enterprise session epochs and filters unrelated sessions", () => {
    const sessions = normalizeEnterpriseHistorySessions({
      adoptId: "lgj-user",
      limit: 20,
      sessions: [
        {
          session_id: "sess_lgj-user_web_conv_alpha_e1",
          channel_id: "web",
          title: "第一次咨询",
          message_count: 2,
          created_at: 100,
          last_message_at: 110,
        },
        {
          session_id: "sess_lgj-user_web_conv_alpha_e2",
          channel_id: "web",
          title: "",
          message_count: 4,
          created_at: 120,
          last_message_at: 130,
        },
        {
          session_id: "sess_other_web_conv_hidden_e1",
          channel_id: "web",
          title: "其他用户",
          last_message_at: 200,
        },
      ],
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      conversationId: "conv_alpha",
      sessionKey: "sess_lgj-user_web_conv_alpha_e2",
      title: "第一次咨询",
      messageCount: 6,
      createdAt: 100_000,
      updatedAt: 130_000,
      runtime: "jiuwenswarm-enterprise",
    });
  });

  it("normalizes remotely returned history records without exposing EA runtime context", () => {
    const messages = extractJiuwenChatMessagesFromRecords([
      {
        id: "u1",
        role: "user",
        timestamp: 100,
        content: "【EA平台会话上下文】\ncurrentConversationId: conv_alpha\ncurrentJiuwenSessionId: sess_alpha\n如果本轮需要创建定时任务且投递到当前对话，请在 create_scheduled_task 参数中传 conversation_id=currentConversationId、session_id=currentJiuwenSessionId、delivery_channel=conversation。\n你好",
      },
      {
        id: "a1",
        request_id: "req1",
        role: "assistant",
        timestamp: 101,
        event_type: "chat.delta",
        content: "你好，",
      },
      {
        id: "a2",
        request_id: "req1",
        role: "assistant",
        timestamp: 102,
        event_type: "chat.delta",
        content: "今天有什么可以帮你？",
      },
    ], 20, "lgj-user");

    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "你好"],
      ["assistant", "你好，今天有什么可以帮你？"],
    ]);
  });

  it("preserves whitespace-only deltas used by markdown formatting", () => {
    const messages = extractJiuwenChatMessagesFromRecords([
      {
        id: "u1",
        role: "user",
        timestamp: 100,
        content: "请给我天气信息",
      },
      ...["**天气**", "\n\n", "- ", "北京", "：", "晴朗", "\n", "- ", "上海", "：", "多云"].map((content, index) => ({
        id: `a${index}`,
        request_id: "req1",
        role: "assistant",
        timestamp: 101 + index,
        event_type: "chat.delta",
        content,
      })),
    ], 20, "lgj-user");

    expect(messages[1]?.text).toBe("**天气**\n\n- 北京：晴朗\n- 上海：多云");
  });
});
