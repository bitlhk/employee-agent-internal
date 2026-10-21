import type { CalendarEvent } from "../../../shared/scheduling";
import { calendarWallDate } from "./calendar-time";
export type CalendarView = "day" | "week" | "month";
export const dateKey = (d: Date) =>
  calendarWallDate(d).toISOString().slice(0, 10);
export function calendarRange(date: string, view: CalendarView) {
  let start = new Date(`${date}T00:00:00+08:00`);
  if (!Number.isFinite(start.getTime()))
    throw new Error("Invalid calendar date");
  if (view === "month")
    start = new Date(`${date.slice(0, 7)}-01T00:00:00+08:00`);
  if (view === "week")
    start.setUTCDate(
      start.getUTCDate() - ((calendarWallDate(start).getUTCDay() + 6) % 7)
    );
  const end = new Date(start);
  if (view === "month")
    end.setUTCDate(
      end.getUTCDate() +
        new Date(
          Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)
        ).getUTCDate()
    );
  else end.setUTCDate(end.getUTCDate() + (view === "week" ? 7 : 1));
  const days: Date[] = [];
  for (let d = new Date(start); d < end; d.setUTCDate(d.getUTCDate() + 1))
    days.push(new Date(d));
  return { start, end, days };
}
export function moveCalendarDate(
  date: string,
  view: CalendarView,
  direction: number
) {
  const d = new Date(`${date}T00:00:00Z`);
  if (view === "month") {
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + direction);
  } else d.setUTCDate(d.getUTCDate() + direction * (view === "week" ? 7 : 1));
  return d.toISOString().slice(0, 10);
}
export function eventsForDay(events: CalendarEvent[], day: Date) {
  const next = new Date(day);
  next.setUTCDate(next.getUTCDate() + 1);
  const key = dateKey(day);
  return events
    .filter(e =>
      e.allDay
        ? e.start <= key && e.end > key
        : Date.parse(e.start) < next.getTime() &&
          Date.parse(e.end) > day.getTime()
    )
    .sort(
      (a, b) =>
        Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start)
    );
}
export function timedEventLayout(events: CalendarEvent[], day: Date) {
  const next = new Date(day);
  next.setUTCDate(next.getUTCDate() + 1);
  const positioned = eventsForDay(events, day)
    .filter(e => !e.allDay)
    .map(event => {
      const start = new Date(event.start),
        end = new Date(event.end);
      const from =
        start < day
          ? 0
          : calendarWallDate(start).getUTCHours() * 60 + start.getUTCMinutes();
      const to =
        end >= next
          ? 1440
          : calendarWallDate(end).getUTCHours() * 60 + end.getUTCMinutes();
      return { event, from, to: Math.max(from + 1, to), lane: 0, columns: 1 };
    })
    .sort((a, b) => a.from - b.from || b.to - a.to);
  let group: typeof positioned = [],
    ends: number[] = [],
    groupEnd = -1;
  const finish = () => {
    for (const item of group) item.columns = ends.length;
    group = [];
    ends = [];
  };
  for (const item of positioned) {
    if (item.from >= groupEnd) finish();
    let lane = ends.findIndex(end => end <= item.from);
    if (lane < 0) lane = ends.length;
    ends[lane] = item.to;
    item.lane = lane;
    group.push(item);
    groupEnd = Math.max(groupEnd, item.to);
  }
  finish();
  return positioned;
}
// Partition month requests to preserve the existing API range contract.
export function calendarQueryRanges(date: string, view: CalendarView) {
  const range = calendarRange(date, view);
  const middle = new Date(range.start);
  middle.setUTCDate(middle.getUTCDate() + Math.min(15, range.days.length));
  return {
    range,
    first: { start: range.start.toISOString(), end: middle.toISOString() },
    second:
      middle < range.end
        ? { start: middle.toISOString(), end: range.end.toISOString() }
        : null,
  };
}
