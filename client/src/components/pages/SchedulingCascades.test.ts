import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const query = vi.hoisted(() => ({
  data: [] as unknown[],
  error: null as Error | null,
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      scheduling: {
        cascades: { invalidate: vi.fn() },
        meetings: { invalidate: vi.fn() },
        events: { invalidate: vi.fn() },
      },
    }),
    scheduling: {
      cascades: { useQuery: () => query },
      confirmCascade: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      stopCascade: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
  },
}));
Object.assign(globalThis, { React });
const { SchedulingCascades } = await import("./SchedulingCascades");
const render = () =>
  renderToStaticMarkup(React.createElement(SchedulingCascades));
function plan(status: string, compensated = false) {
  return {
    id: "test",
    title: "关联会议",
    status,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    steps: [
      {
        key: "move-b",
        previous: {
          time: { start: "2099-01-01T10:00Z", end: "2099-01-01T11:00Z" },
        },
        event: {
          time: { start: "2099-01-01T12:00Z", end: "2099-01-01T13:00Z" },
        },
        dependsOn: [],
        state: "completed",
        compensated,
      },
    ],
    errorCode: null,
    stopRequested: false,
  };
}
beforeEach(() => {
  query.data = [];
  query.error = null;
});
describe("cascade owner review", () => {
  it("does not replace the normal calendar experience when there are no plans", () => {
    expect(render()).toBe("");
  });
  it("shows partial success and separately offers compensation without claiming full completion", () => {
    query.data = [plan("partial")];
    const html = render();
    expect(html).toContain("部分调整完成");
    expect(html).toContain("恢复已调整的原安排");
    expect(html).not.toContain("确认整组调整");
    expect(html).toContain("原安排：");
    expect(html).toContain("新安排：");
    expect(html).toContain("沿用原会议参与人");
  });
  it("disables confirmation for expired proposals", () => {
    query.data = [
      {
        ...plan("pending"),
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    ];
    expect(render()).toMatch(
      /<button[^>]*disabled=""[^>]*>确认整组调整<\/button>/
    );
  });
  it("does not offer another compensation after every successful step was restored", () => {
    query.data = [plan("compensated", true)];
    expect(render()).not.toContain("恢复已调整的原安排");
  });
});
