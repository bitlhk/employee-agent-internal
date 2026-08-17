import { describe, expect, it } from "vitest";
import { parseJiuwenUsageRequest, usageDateKey } from "./usage-events";

describe("usage events", () => {
  it("normalizes enterprise and standalone requests to the same user-turn key", () => {
    const base = {
      adoptId: "lgj-test",
      ts: "2026-08-17T03:06:17.412Z",
      userId: 42,
      sessionId: "sess-test",
      clientRunId: "run-123",
    };

    const enterprise = parseJiuwenUsageRequest({ ...base, event: "gateway_chat_request" });
    const standalone = parseJiuwenUsageRequest({ ...base, event: "chat_stream_request" });

    expect(enterprise).toMatchObject({
      adoptId: "lgj-test",
      userId: 42,
      sessionId: "sess-test",
    });
    expect(enterprise?.key).toBe(standalone?.key);
  });

  it("does not count completion and unrelated runtime events as user turns", () => {
    expect(parseJiuwenUsageRequest({
      event: "gateway_chat_complete",
      adoptId: "lgj-test",
      ts: "2026-08-17T03:06:20.000Z",
    })).toBeNull();
    expect(parseJiuwenUsageRequest({ event: "tool_call" })).toBeNull();
  });

  it("uses the configured Shanghai reporting day instead of the UTC day", () => {
    expect(usageDateKey("2026-08-16T16:30:00.000Z")).toBe("2026-08-17");
  });
});
