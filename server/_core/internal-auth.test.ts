import type { Request } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { isAuthorizedInternalRequest } from "./helpers";

const originalEnv = { ...process.env };
afterEach(() => { process.env = { ...originalEnv }; });

function request(token: string): Request {
  return {
    headers: { "x-internal-key": token },
    socket: { remoteAddress: "203.0.113.8" },
  } as Request;
}

describe("internal API authentication", () => {
  it("accepts only the exact configured credential", () => {
    process.env.NODE_ENV = "production";
    expect(isAuthorizedInternalRequest(request("correct"), "correct")).toBe(true);
    expect(isAuthorizedInternalRequest(request("wrong"), "correct")).toBe(false);
    expect(isAuthorizedInternalRequest(request(""), "correct")).toBe(false);
  });
});
