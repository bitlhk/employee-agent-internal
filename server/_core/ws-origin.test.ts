import type { IncomingMessage } from "http";
import { afterEach, describe, expect, it } from "vitest";
import { isAllowedWebSocketOrigin } from "./ws-origin";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("WebSocket Origin validation", () => {
  it("accepts configured origins", () => {
    process.env.WS_ALLOWED_ORIGINS = "https://app.example.com, https://admin.example.com";
    expect(isAllowedWebSocketOrigin(request({ origin: "https://app.example.com", host: "api.example.com" }))).toBe(true);
  });

  it("accepts the request's same origin behind HTTPS proxy", () => {
    expect(isAllowedWebSocketOrigin(request({
      origin: "https://app.example.com",
      host: "127.0.0.1:5180",
      "x-forwarded-host": "app.example.com",
      "x-forwarded-proto": "https",
    }))).toBe(true);
  });

  it("rejects missing, wildcard, and cross-site origins", () => {
    process.env.CORS_ORIGIN = "*";
    expect(isAllowedWebSocketOrigin(request({ host: "app.example.com" }))).toBe(false);
    expect(isAllowedWebSocketOrigin(request({ origin: "https://evil.example", host: "app.example.com" }))).toBe(false);
  });
});
