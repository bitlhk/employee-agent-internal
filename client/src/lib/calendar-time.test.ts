import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calendarFormat,
  calendarInputInstant,
  calendarInputValue,
} from "./calendar-time";
import {
  calendarRange,
  dateKey,
  eventsForDay,
  timedEventLayout,
} from "./calendar-view";

afterEach(() => vi.unstubAllEnvs());
describe.each(["America/Tijuana", "UTC", "Asia/Tokyo"])(
  "Beijing calendar on a %s device",
  zone => {
    it("converts editor values and day boundaries independently of the host zone", () => {
      vi.stubEnv("TZ", zone);
      expect(calendarInputInstant("2026-10-13T09:30")).toBe(
        "2026-10-13T01:30:00.000Z"
      );
      expect(calendarInputValue("2026-10-12T16:30:00Z")).toBe(
        "2026-10-13T00:30"
      );
      expect(dateKey(new Date("2026-10-12T16:30:00Z"))).toBe("2026-10-13");
      expect(calendarRange("2026-10-13", "day").start.toISOString()).toBe(
        "2026-10-12T16:00:00.000Z"
      );
      expect(
        calendarFormat("2026-10-12T16:30:00Z", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
      ).toBe("00:30");
    });
    it("places a UTC afternoon meeting on the correct Beijing date and hour", () => {
      vi.stubEnv("TZ", zone);
      const event = {
        id: "meeting",
        title: "meeting",
        start: "2026-10-12T16:30:00Z",
        end: "2026-10-12T17:30:00Z",
        allDay: false,
        busy: true,
        location: "",
      };
      const day = calendarRange("2026-10-13", "day").start;
      expect(
        eventsForDay([event], calendarRange("2026-10-12", "day").start)
      ).toEqual([]);
      expect(timedEventLayout([event], day)[0]).toMatchObject({
        from: 30,
        to: 90,
      });
    });
  }
);
