import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  internalMcpAudience,
  issueInternalRuntimeToken,
  verifyInternalRuntimeToken,
} from "./internal-runtime-token";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.INTERNAL_RUNTIME_TOKEN_SECRET = "current-runtime-secret-that-is-long-enough-2026";
  process.env.INTERNAL_RUNTIME_TOKEN_TTL_SECONDS = "30";
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.useRealTimers();
});

describe("internal runtime tokens", () => {
  it("maps the role MCP gateway to its own audience", () => {
    expect(internalMcpAudience("/api/internal/role-mcp/mcp"))
      .toBe("urn:ea:internal-mcp:role-mcp");
  });

  it("binds runtime, Agent, adoption, audience, expiry, and jti", async () => {
    const audience = internalMcpAudience("/api/internal/custom-mcp/mcp");
    const issued = await issueInternalRuntimeToken({
      runtimeId: "jiuwenswarm-local",
      agentId: "jiuwen_lgj-demo",
      adoptId: "lgj-demo",
      audience,
    });
    await expect(verifyInternalRuntimeToken(issued.token, audience)).resolves.toMatchObject({
      runtimeId: "jiuwenswarm-local",
      agentId: "jiuwen_lgj-demo",
      adoptId: "lgj-demo",
      audience,
      jti: expect.stringMatching(/^irt_/),
    });
    await expect(verifyInternalRuntimeToken(
      issued.token,
      internalMcpAudience("/api/internal/platform-tools/mcp"),
    )).rejects.toThrow();
  });

  it("accepts a previous rotation secret for verification but signs with the current secret", async () => {
    process.env.INTERNAL_RUNTIME_TOKEN_SECRET = "previous-runtime-secret-that-is-long-enough";
    const issued = await issueInternalRuntimeToken({
      runtimeId: "jiuwenswarm-local",
      agentId: "jiuwen_lgj-demo",
      adoptId: "lgj-demo",
      audience: "urn:ea:internal-mcp:custom-mcp",
    });
    process.env.INTERNAL_RUNTIME_TOKEN_SECRET = "new-runtime-secret-that-is-long-enough-2026";
    process.env.INTERNAL_RUNTIME_TOKEN_PREVIOUS_SECRETS = "previous-runtime-secret-that-is-long-enough";
    await expect(verifyInternalRuntimeToken(issued.token, "urn:ea:internal-mcp:custom-mcp")).resolves.toMatchObject({
      adoptId: "lgj-demo",
    });
  });

  it("rejects an expired token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T01:00:00.000Z"));
    const issued = await issueInternalRuntimeToken({
      runtimeId: "jiuwenswarm-local",
      agentId: "jiuwen_lgj-demo",
      adoptId: "lgj-demo",
      audience: "urn:ea:internal-mcp:custom-mcp",
    });
    vi.setSystemTime(new Date("2026-08-14T01:01:00.000Z"));
    await expect(verifyInternalRuntimeToken(issued.token, "urn:ea:internal-mcp:custom-mcp")).rejects.toThrow();
  });
});
