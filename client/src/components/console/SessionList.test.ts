import { describe, expect, it } from "vitest";
import {
  formatSessionTimestamp,
  groupForTimestamp,
  groupSessionConversations,
  type SessionListConversation,
} from "./SessionList";

const NOW = new Date(2026, 6, 19, 12, 0, 0).getTime();

function session(
  conversationId: string,
  updatedAt: number,
  pinnedAt?: number,
): SessionListConversation {
  return {
    conversationId,
    title: conversationId,
    preview: "",
    messageCount: 1,
    createdAt: updatedAt,
    updatedAt,
    pinnedAt,
  };
}

describe("session history groups", () => {
  it("groups pinned, today, recent-week and older sessions in display order", () => {
    const today = new Date(2026, 6, 19, 9, 5).getTime();
    const thisWeek = new Date(2026, 6, 16, 18, 0).getTime();
    const earlier = new Date(2026, 5, 30, 18, 0).getTime();
    const groups = groupSessionConversations([
      session("older", earlier),
      session("today", today),
      session("pinned", earlier, NOW - 1_000),
      session("week", thisWeek),
    ], NOW);

    expect(groups.map((group) => group.key)).toEqual(["pinned", "today", "week", "earlier"]);
    expect(groups.map((group) => group.sessions[0]?.conversationId)).toEqual([
      "pinned",
      "today",
      "week",
      "older",
    ]);
  });

  it("uses seven calendar days including today for the week group", () => {
    expect(groupForTimestamp(new Date(2026, 6, 19, 0, 1).getTime(), NOW)).toBe("today");
    expect(groupForTimestamp(new Date(2026, 6, 13, 0, 1).getTime(), NOW)).toBe("week");
    expect(groupForTimestamp(new Date(2026, 6, 12, 23, 59).getTime(), NOW)).toBe("earlier");
  });
});

describe("session timestamps", () => {
  it("formats timestamps for today, this week and older sessions", () => {
    expect(formatSessionTimestamp(new Date(2026, 6, 19, 9, 5).getTime(), NOW)).toBe("09:05");
    expect(formatSessionTimestamp(new Date(2026, 6, 18, 9, 5).getTime(), NOW)).toBe("周六");
    expect(formatSessionTimestamp(new Date(2026, 5, 30, 9, 5).getTime(), NOW)).toBe("6月30日");
  });
});
