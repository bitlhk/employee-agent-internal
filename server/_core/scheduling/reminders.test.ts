import { describe, it, expect } from "vitest";
import { dueReminderEvents } from "./reminders";
describe("In-app reminder window", () => {
  it("selects future busy events in the 15 minute window without all-day, transparent or expired events", () => {
    const now = Date.parse("2026-10-12T09:00:00Z");
    const event = { id: "own", title: "own", location: "", allDay: false, busy: true, start: new Date(now + 15 * 60_000).toISOString(), end: new Date(now + 30 * 60_000).toISOString() };
    const events = [event, { ...event, id: "later", start: new Date(now + 16 * 60_000).toISOString() }, { ...event, id: "started", start: new Date(now).toISOString() }, { ...event, id: "transparent", busy: false }, { ...event, id: "allDay", allDay: true }];
    expect(dueReminderEvents(events, now)).toEqual([event]);
  });
});
