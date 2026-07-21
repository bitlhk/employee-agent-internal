import { describe, expect, it } from "vitest";

import {
  buildPersonalExpertRuntimeConfig,
  isStandardA2AResponseEvent,
  parsePersonalExpertEndpoint,
  personalExpertConnectionFingerprint,
} from "./personal-experts";

describe("personal expert configuration", () => {
  it("accepts a public HTTPS A2A URL and removes its fragment", () => {
    expect(parsePersonalExpertEndpoint("https://agent.example.com/a2a#debug").toString())
      .toBe("https://agent.example.com/a2a");
  });

  it.each([
    "http://agent.example.com/a2a",
    "https://user:password@agent.example.com/a2a",
    "https://agent.example.com/a2a?api_key=secret",
    "not-a-url",
  ])("rejects unsafe endpoint %s", (value) => {
    expect(() => parsePersonalExpertEndpoint(value)).toThrow();
  });

  it("uses the constrained standard A2A profile", () => {
    expect(buildPersonalExpertRuntimeConfig("bearer")).toEqual({
      stream: false,
      method: "message/send",
      timeoutMs: 300_000,
      executionMode: "async",
      maxConcurrent: 1,
      authType: "bearer",
      interactionMode: "single",
    });
  });

  it("binds successful connection tests to owner, agent and credential", () => {
    const config = {
      endpointUrl: "https://agent.example.com/a2a",
      authType: "bearer" as const,
      credential: "token-one",
    };
    const base = personalExpertConnectionFingerprint({ userId: 1, adoptId: "lgj-one" }, config);
    expect(personalExpertConnectionFingerprint({ userId: 2, adoptId: "lgj-one" }, config)).not.toBe(base);
    expect(personalExpertConnectionFingerprint({ userId: 1, adoptId: "lgj-two" }, config)).not.toBe(base);
    expect(personalExpertConnectionFingerprint(
      { userId: 1, adoptId: "lgj-one" },
      { ...config, credential: "token-two" },
    )).not.toBe(base);
  });

  it("accepts standard A2A message and task responses only", () => {
    expect(isStandardA2AResponseEvent({
      jsonrpc: "2.0",
      id: "rpc-1",
      result: { kind: "message", messageId: "msg-1", role: "agent", parts: [{ kind: "text", text: "ok" }] },
    })).toBe(true);
    expect(isStandardA2AResponseEvent({
      jsonrpc: "2.0",
      id: "rpc-2",
      result: { kind: "task", id: "task-1", status: { state: "completed" } },
    })).toBe(true);
    expect(isStandardA2AResponseEvent({ result: { echoed: { text: "ok" } } })).toBe(false);
  });
});
