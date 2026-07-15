import { describe, expect, it } from "vitest";
import { formatModelName } from "./modelDisplay";

describe("formatModelName", () => {
  it("does not expose the automatic model's internal id", () => {
    expect(formatModelName("__auto")).toBe("自动");
  });
});
