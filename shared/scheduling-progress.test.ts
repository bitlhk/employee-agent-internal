import { expect, it } from "vitest";
import { availabilityCell, requestedSlots } from "./scheduling-progress";
const slot = {
  start: "2026-10-28T11:00:00+08:00",
  end: "2026-10-28T12:00:00+08:00",
};
const reply = JSON.stringify({
  availability: "available",
  slots: [],
  validUntil: "2026-10-29T00:00:00Z",
  observations: [{ ...slot, availability: "busy" }],
});
it("keeps approval, errors, sharing and expired observations distinct", () => {
  const cell = (status: string, shared = true, now = 0) =>
    availabilityCell(status, shared, reply, slot, [slot], now);
  expect(cell("pending")).toBe("pending");
  expect(cell("approved")).toBe("running");
  expect(cell("failed")).toBe("failed");
  expect(cell("completed", false)).toBe("unshared");
  expect(cell("completed")).toBe("busy");
  expect(cell("completed", true, Date.parse("2026-11-01T00:00:00Z"))).toBe(
    "expired"
  );
});
it("does not infer omitted times as busy or parse natural language as verified slots", () => {
  expect(requestedSlots(JSON.stringify({ query: "明天下午" }))).toEqual([]);
  expect(
    availabilityCell(
      "completed",
      true,
      JSON.stringify({
        availability: "available",
        slots: [],
        validUntil: "2026-10-29T00:00:00Z",
      }),
      slot,
      [slot],
      0
    )
  ).toBe("unknown");
  expect(
    requestedSlots(JSON.stringify({ slots: [{ ...slot, private: "private" }] }))
  ).toEqual([]);
});
