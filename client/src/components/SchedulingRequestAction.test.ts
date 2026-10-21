import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { releasedAvailability } from "../../../shared/scheduling-progress";
const state = vi.hoisted(() => ({
  rows: [] as Array<{
    id: number;
    taskType: string;
    status: string;
    reply?: ReturnType<typeof releasedAvailability>;
  }>,
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ collab: { incoming: { invalidate: vi.fn() } } }),
    collab: {
      schedulingRequestProgress: {
        useQuery: () => ({
          data: state.rows[0]
            ? {
                ...state.rows[0],
                requesterName: "发起人",
                matrix: { people: [], rows: [] },
              }
            : undefined,
        }),
      },
      reviewRequest: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));
Object.assign(globalThis, { React });
const { SchedulingRequestAction } = await import("./SchedulingRequestAction");
beforeEach(() => {
  state.rows = [];
});
it("shows the saved reply even after its availability expires, without a matrix", () => {
  state.rows = [
    {
      id: 42,
      taskType: "scheduling",
      status: "completed",
      reply: {
        availability: "available",
        slots: [
          {
            start: "2020-01-01T14:00:00+08:00",
            end: "2020-01-01T15:00:00+08:00",
          },
        ],
        validUntil: "2020-01-01T00:00:00Z",
        observations: [
          {
            start: "2020-01-01T11:00:00+08:00",
            end: "2020-01-01T12:00:00+08:00",
            availability: "busy",
          },
        ],
      },
    },
  ];
  const html = renderToStaticMarkup(
    React.createElement(SchedulingRequestAction, {
      adoptId: "A",
      requestId: 42,
    })
  );
  expect(html).toContain("本次回复");
  expect(html).toContain("14:00");
  expect(html).toContain("有冲突");
  expect(html).toContain("不代表当前忙闲");
  expect(html).not.toContain("<table");
});
it.each([
  ["pending", "批准本次协作"],
  ["approved", "已批准，等待助手"],
  ["running", "助手正在处理"],
  ["completed", "助手已完成"],
  ["rejected", "你已拒绝"],
  ["cancelled", "已取消"],
  ["failed", "处理失败"],
])("explains %s without declaring the request expired", (status, label) => {
  state.rows = [{ id: 42, taskType: "scheduling", status }];
  const html = renderToStaticMarkup(
    React.createElement(SchedulingRequestAction, {
      adoptId: "A",
      requestId: 42,
    })
  );
  expect(html).toContain(label);
  expect(html).toContain("发起人发来的日程询问");
  expect(html).not.toContain("<table");
  expect(html).not.toContain("候选时间确定后");
  expect(html).not.toContain("已失效");
  if (status !== "pending") expect(html).not.toContain("批准本次协作");
});
it("does not infer expiry from a missing paginated record", () => {
  expect(
    renderToStaticMarkup(
      React.createElement(SchedulingRequestAction, {
        adoptId: "A",
        requestId: 42,
      })
    )
  ).toContain("暂时无法确认其状态");
});
