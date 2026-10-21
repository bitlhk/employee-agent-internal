import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ status: "waiting", calendarUpdated: false, confirmations: [] as unknown[] }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ collab: { goals: { invalidate: vi.fn() } } }),
    collab: {
      goals: { useQuery: () => ({ data: [{ id: "goal", objective: "完整任务指令", message: "详细办理情况", status: state.status, calendarUpdated: state.calendarUpdated, confirmations: state.confirmations }] }) },
      cancelGoal: { useMutation: () => ({ mutate: vi.fn() }) },
      resumeGoal: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));
vi.mock("./SchedulingChatConfirmations", () => ({ SchedulingChatConfirmations: () => null }));
vi.mock("./SchedulingAvailabilityMatrix", () => ({ GoalAvailability: () => null }));
Object.assign(globalThis, { React });
const { CollaborationActivity } = await import("./CollaborationActivity");
const render = () => renderToStaticMarkup(React.createElement(CollaborationActivity, { adoptId: "A", focusId: "goal", onOpenCalendar: () => {} }));
beforeEach(() => { state.calendarUpdated = false; state.confirmations = []; });
it("distinguishes waiting for replies from owner confirmation and folds technical detail", () => {
  state.status = "waiting";
  state.confirmations = [];
  const html = render();
  expect(html).toContain("等待回复");
  expect(html).not.toContain("需要你确认");
  expect(html).toMatch(/<details[^>]*>[\s\S]*完整任务指令[\s\S]*<\/details>/);
  expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  state.confirmations = [{ kind: "reschedule", id: "draft" }];
  expect(render()).toContain("需要你确认");
  expect(render()).not.toContain("查看日历");
});
it("keeps completed cards compact and preserves current-page calendar navigation", () => {
  state.status = "completed";
  state.confirmations = [];
  state.calendarUpdated = true;
  const html = render();
  expect(html).toContain("已完成");
  expect(html).not.toContain("停止协作");
  expect(html).toContain("查看日历");
  expect(html).not.toContain('target="_blank"');
});
it.each(["completed", "waiting", "failed", "cancelled"])("does not imply a calendar change for %s without a receipt", status => {
  state.status = status;
  const html = render();
  expect(html).not.toContain("查看日历");
  expect(html).not.toContain("日历已更新");
  if (status === "completed") expect(html).toContain("方案或建议");
});
