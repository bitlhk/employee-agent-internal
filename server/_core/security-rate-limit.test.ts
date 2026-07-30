import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { COOKIE_NAME } from "@shared/const";
import { sdk } from "./sdk";
import { clawChatRateLimitKey } from "./security";

function request(headers: Record<string, string>, body: Record<string, unknown> = {}): Request {
  return {
    headers,
    body,
    ip: "203.0.113.8",
    socket: { remoteAddress: "203.0.113.8" },
  } as Request;
}

describe("claw chat rate-limit key", () => {
  it("does not let an untrusted adoptId select another user's bucket", async () => {
    const first = await clawChatRateLimitKey(request({}, { adoptId: "victim-a" }));
    const second = await clawChatRateLimitKey(request({}, { adoptId: "victim-b" }));
    expect(first).toBe(second);
    expect(first).not.toContain("victim");
  });

  it("uses a non-reversible digest of a verified session identity", async () => {
    const session = await sdk.signSession({
      userId: 42,
      name: "rate-limit-user",
      authVersion: "version-1",
    });
    const key = await clawChatRateLimitKey(request({ cookie: `${COOKIE_NAME}=${session}` }));
    expect(key).toMatch(/^auth:[a-f0-9]{24}$/);
    expect(key).not.toContain(session);
  });

  it("does not let invalid cookies create arbitrary rate-limit buckets", async () => {
    const first = await clawChatRateLimitKey(request({ cookie: `${COOKIE_NAME}=forged-a` }));
    const second = await clawChatRateLimitKey(request({ cookie: `${COOKIE_NAME}=forged-b` }));
    expect(first).toBe("203.0.113.8");
    expect(second).toBe(first);
  });
});
