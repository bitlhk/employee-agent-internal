import { describe, expect, it } from "vitest";
import { parseMessageFeedbackReasonCodes } from "./message-feedback";

describe("message feedback parsing", () => {
  it("keeps known reasons and drops malformed or unknown values", () => {
    expect(parseMessageFeedbackReasonCodes('["incorrect","tool_failed","unknown",42]')).toEqual([
      "incorrect",
      "tool_failed",
    ]);
  });

  it("fails closed for invalid JSON", () => {
    expect(parseMessageFeedbackReasonCodes("not-json")).toEqual([]);
  });
});
