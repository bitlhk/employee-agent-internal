import type { Request } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { csrfAllowedOrigins, isCookieMutationAllowed } from "./csrf";
import { COOKIE_NAME } from "@shared/const";

const originalEnv = { ...process.env };
afterEach(() => { process.env = { ...originalEnv }; });

function request(headers: Record<string, string>, method = "POST"): Request {
  return { method, headers } as Request;
}

describe("cookie CSRF protection", () => {
  const cookie = `${COOKIE_NAME}=signed-session`;

  it("rejects cross-site browser mutations carrying a session cookie", () => {
    const allowed = csrfAllowedOrigins(["https://app.example.com"]);
    expect(isCookieMutationAllowed(request({ cookie, origin: "https://evil.example", "sec-fetch-site": "cross-site" }), allowed)).toBe(false);
  });

  it("allows configured frontend origins", () => {
    const allowed = csrfAllowedOrigins(["https://app.example.com"]);
    expect(isCookieMutationAllowed(request({ cookie, origin: "https://app.example.com", "sec-fetch-site": "same-origin" }), allowed)).toBe(true);
    expect(isCookieMutationAllowed(request({ cookie, origin: "https://app.example.com", "sec-fetch-site": "cross-site" }), allowed)).toBe(true);
  });

  it("does not interfere with bearer/internal clients or requests without session cookies", () => {
    const allowed = csrfAllowedOrigins(["https://app.example.com"]);
    expect(isCookieMutationAllowed(request({ authorization: "Bearer token", cookie, origin: "https://evil.example" }), allowed)).toBe(true);
    expect(isCookieMutationAllowed(request({ origin: "https://evil.example" }), allowed)).toBe(true);
  });

  it("keeps legacy non-browser cookie clients compatible when browser metadata is absent", () => {
    expect(isCookieMutationAllowed(request({ cookie }), csrfAllowedOrigins([]))).toBe(true);
  });
});
