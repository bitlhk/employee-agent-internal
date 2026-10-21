import { describe, expect, it } from "vitest";
import {
  calendarRange,
  calendarQueryRanges,
  dateKey,
  eventsForDay,
  moveCalendarDate,
  timedEventLayout,
} from "./calendar-view";
describe("calendar dates and event placement", () => {
  it("keeps overlapping events in separate lanes and sizes them by occupied time", () => {
    const date = calendarRange("2026-10-12", "day").start;
    const events = [
      [9, 11],
      [10, 12],
      [12, 13],
    ].map(([start, end], i) => ({
      id: String(i),
      title: "会议",
      allDay: false,
      busy: true,
      location: "",
      start: new Date(
        `2026-10-12T${String(start).padStart(2, "0")}:00:00+08:00`
      ).toISOString(),
      end: new Date(
        `2026-10-12T${String(end).padStart(2, "0")}:00:00+08:00`
      ).toISOString(),
    }));
    const layout = timedEventLayout(events, date);
    expect(layout.map(e => e.columns)).toEqual([2, 2, 1]);
    expect(layout[0].lane).not.toBe(layout[1].lane);
    expect(layout[0].to - layout[0].from).toBe(120);
  });
  it("uses Monday weeks and Beijing calendar arithmetic across month and year boundaries", () => {
    const week = calendarRange("2027-01-01", "week");
    expect(dateKey(week.start)).toBe("2026-12-28");
    expect(week.days).toHaveLength(7);
    expect(dateKey(calendarRange("2028-02-28", "month").end)).toBe(
      "2028-03-01"
    );
    expect(moveCalendarDate("2026-01-31", "month", 1)).toBe("2026-02-01");
  });
  it("splits month reads to preserve the existing API range limit, without gaps", () => {
    const value = calendarQueryRanges("2026-10-10", "month");
    expect(value.first.end).toBe(value.second!.start);
    for (const range of [value.first, value.second!])
      expect(
        Date.parse(range.end) - Date.parse(range.start)
      ).toBeLessThanOrEqual(31 * 86_400_000);
    expect(calendarQueryRanges("2026-10-10", "day").second).toBeNull();
  });
  it("places overnight and all-day events on each occupied day, respecting exclusive ends", () => {
    const events = [
      {
        id: "all",
        title: "all",
        start: "2026-10-12",
        end: "2026-10-14",
        allDay: true,
        busy: true,
        location: "",
      },
      {
        id: "night",
        title: "night",
        start: new Date("2026-10-12T23:00:00+08:00").toISOString(),
        end: new Date("2026-10-13T01:00:00+08:00").toISOString(),
        allDay: false,
        busy: true,
        location: "",
      },
    ];
    expect(
      eventsForDay(events, calendarRange("2026-10-13", "day").start).map(
        e => e.id
      )
    ).toEqual(["all", "night"]);
    expect(
      eventsForDay(events, calendarRange("2026-10-14", "day").start)
    ).toHaveLength(0);
  });
});
