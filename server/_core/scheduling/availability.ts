import type { Availability, CalendarEvent, SchedulingRange } from "../../../shared/scheduling";
import { wallInstants } from "./timezone";

export function availabilityForSlots(events: CalendarEvent[], slots: SchedulingRange[], timeZone?: string): Availability[] {
  return slots.map(slot => {
    const start = Date.parse(slot.start); const end = Date.parse(slot.end);
    let uncertain = false;
    for (const event of events.filter(item => item.busy)) {
      if (event.allDay) {
        if (timeZone) {
          const starts = wallInstants(event.start, 0, timeZone); const ends = wallInstants(event.end, 0, timeZone);
          if (starts.length && ends.length) {
            if (start < Math.max(...ends) && end > Math.min(...starts)) return "busy";
            continue;
          }
        }
        // Without the owner's timezone, a date-only event must not produce a false free result.
        const earliest = Date.parse(event.start) - 14 * 3_600_000;
        const latest = Date.parse(event.end) + 12 * 3_600_000;
        if (start < latest && end > earliest) uncertain = true;
      } else if (Date.parse(event.start) < end && Date.parse(event.end) > start) return "busy";
    }
    return uncertain ? "unknown" : "free";
  });
}

export function commonSlotIndices(replies: Availability[][], slotCount: number): number[] {
  if (!replies.length) return [];
  return Array.from({ length: slotCount }, (_, index) => index).filter(index => replies.every(reply => reply[index] === "free"));
}
