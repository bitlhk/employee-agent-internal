import { describe, expect, it } from "vitest";
import { computePreviewRuns } from "./schedule-preview";

describe("cron schedule preview", () => {
  it("does not return expired once schedules", () => {
    const result = computePreviewRuns({
      adoptId: "lgj-test",
      schedule: { kind: "once", runAt: "2026-04-01T00:00:00.000Z", display: "past" },
      count: 5,
    }, new Date("2026-04-30T00:00:00.000Z"));
    expect(result.runs).toEqual([]);
  });

  it("returns interval previews from now", () => {
    const result = computePreviewRuns({
      adoptId: "lgj-test",
      schedule: { kind: "interval", intervalMinutes: 15, display: "每 15 分钟" },
      count: 2,
    }, new Date("2026-04-30T00:00:00.000Z"));
    expect(result.runs.map((run) => run.runAt)).toEqual([
      "2026-04-30T00:15:00.000Z",
      "2026-04-30T00:30:00.000Z",
    ]);
  });

  it("applies a wake offset without changing the run time", () => {
    const result = computePreviewRuns({
      adoptId: "lgj-test",
      schedule: { kind: "interval", intervalMinutes: 30, display: "每 30 分钟" },
      count: 1,
      wakeOffsetSeconds: 300,
    }, new Date("2026-04-30T00:00:00.000Z"));
    expect(result.runs[0]).toEqual({
      runAt: "2026-04-30T00:30:00.000Z",
      wakeAt: "2026-04-30T00:25:00.000Z",
    });
  });
});
