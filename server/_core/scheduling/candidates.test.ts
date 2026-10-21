import { describe, it, expect } from "vitest";
import { generateCandidates, wallInstants } from "./candidates";
describe("Candidate timezone boundaries", () => {
  it("maps Shanghai wall time and skips past times and weekends", () => {
    const slots = generateCandidates(
      {
        startDate: "2026-10-12",
        endDate: "2026-10-18",
        timeZone: "Asia/Shanghai",
        durationMinutes: 60,
      },
      Date.parse("2026-10-12T02:00:00Z")
    );
    expect(slots[0].start).toBe("2026-10-12T02:30:00.000Z");
    expect(
      slots.every(slot => ![0, 6].includes(new Date(slot.start).getUTCDay()))
    ).toBe(true);
    expect(slots.at(-1)?.end).toBe("2026-10-16T10:00:00.000Z");
  });
  it("does not invent nonexistent DST wall times and retains both fold instants", () => {
    expect(wallInstants("2026-03-08", 150, "America/New_York")).toEqual([]);
    expect(
      wallInstants("2026-11-01", 90, "America/New_York").map(value =>
        new Date(value).toISOString()
      )
    ).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]);
  });
  it("rejects invalid zones, reversed ranges, and periods over a month", () => {
    const input = {
      startDate: "2026-10-12",
      endDate: "2026-10-13",
      timeZone: "Asia/Shanghai",
      durationMinutes: 60,
    };
    expect(() => generateCandidates({ ...input, timeZone: "guess" })).toThrow();
    expect(() =>
      generateCandidates({ ...input, endDate: "2026-10-11" })
    ).toThrow();
    expect(() =>
      generateCandidates({ ...input, endDate: "2026-12-01" })
    ).toThrow();
  });
  it("includes the last local date and defaults to weekday 09:00-18:00 windows", () => {
    const slots = generateCandidates(
      {
        startDate: "2026-10-23",
        endDate: "2026-10-26",
        timeZone: "Asia/Shanghai",
        durationMinutes: 30,
      },
      Date.parse("2026-10-22T00:00:00Z")
    );
    expect(slots[0]).toEqual({
      start: "2026-10-23T01:00:00.000Z",
      end: "2026-10-23T01:30:00.000Z",
    });
    expect(slots.at(-1)?.end).toBe("2026-10-26T10:00:00.000Z");
    expect(
      slots.every(slot =>
        ["2026-10-23", "2026-10-26"].includes(slot.start.slice(0, 10))
      )
    ).toBe(true);
  });
  it("uses Sunday=0 and permits 31 inclusive dates but rejects 32", () => {
    const input = {
      startDate: "2026-10-01",
      endDate: "2026-10-31",
      timeZone: "Asia/Shanghai",
      durationMinutes: 30,
      weekdays: [0],
      dayStart: "10:00",
      dayEnd: "10:30",
    };
    const slots = generateCandidates(input, Date.parse("2026-09-30T00:00:00Z"));
    expect(slots.map(slot => slot.start)).toEqual([
      "2026-10-04T02:00:00.000Z",
      "2026-10-11T02:00:00.000Z",
      "2026-10-18T02:00:00.000Z",
      "2026-10-25T02:00:00.000Z",
    ]);
    expect(() =>
      generateCandidates({ ...input, endDate: "2026-11-01" })
    ).toThrow();
  });
});
