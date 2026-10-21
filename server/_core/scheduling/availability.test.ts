import { describe, expect, it } from "vitest";
import { availabilityForSlots, commonSlotIndices } from "./availability";
import { coordinationInputSchema } from "../../../shared/scheduling";
const slots = [
  { start: "2026-10-13T09:00:00Z", end: "2026-10-13T10:00:00Z" },
  { start: "2026-10-13T10:00:00Z", end: "2026-10-13T11:00:00Z" },
];
describe("Availability projection", () => {
  it("treats touching endpoints as non-conflicting and ignores transparent events", () => {
    const event = { id: "private", title: "private meeting", location: "private location", start: slots[0].start, end: slots[0].end, allDay: false, busy: true };
    expect(availabilityForSlots([event], slots)).toEqual(["busy", "free"]);
    expect(availabilityForSlots([{ ...event, busy: false }], slots)).toEqual(["free", "free"]);
  });
  it("does not claim free for an all-day event without the owner's timezone", () => {
    expect(availabilityForSlots([{ id: "day", title: "private", location: "", start: "2026-10-13", end: "2026-10-14", allDay: true, busy: true }], slots)).toEqual(["unknown", "unknown"]);
  });
  it("uses the owner's zone for all-day events and excludes the end date", () => {
    const event = { id: "day", title: "Private", location: "", start: "2026-10-13", end: "2026-10-14", allDay: true, busy: true };
    const boundaries = [{ start: "2026-10-12T16:00:00Z", end: "2026-10-12T17:00:00Z" }, { start: "2026-10-13T16:00:00Z", end: "2026-10-13T17:00:00Z" }];
    expect(availabilityForSlots([event], boundaries, "Asia/Shanghai")).toEqual(["busy", "free"]);
  });
  it("requires every reply to be explicitly free", () => {
    expect(commonSlotIndices([["free", "free"], ["unknown", "free"], ["free", "free"]], 2)).toEqual([1]);
    expect(commonSlotIndices([], 2)).toEqual([]);
    expect(commonSlotIndices([["free"], ["free", "free"]], 2)).toEqual([0]);
  });
  it("rejects identity injection, repeated participants, and overlarge windows", () => {
    const input = { requestKey: "00000000-0000-4000-8000-000000000001", title: "Meeting", participantIds: [2], slots };
    expect(coordinationInputSchema.safeParse(input).success).toBe(true);
    expect(coordinationInputSchema.safeParse({ ...input, executionUserId: 2 }).success).toBe(false);
    expect(coordinationInputSchema.safeParse({ ...input, participantIds: [2, 2] }).success).toBe(false);
    expect(coordinationInputSchema.safeParse({ ...input, slots: [{ start: slots[0].start, end: "2026-12-01T00:00:00Z" }] }).success).toBe(false);
  });
});
