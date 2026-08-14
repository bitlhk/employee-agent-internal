import type { Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getClawByAgentId: vi.fn(),
  getClawByAdoptId: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("../db", () => ({
  getClawByAgentId: mocks.getClawByAgentId,
  getClawByAdoptId: mocks.getClawByAdoptId,
}));
vi.mock("./audit-events", () => ({
  auditRequest: () => ({}),
  recordAuditBestEffort: mocks.recordAudit,
}));

import { authorizeAndBindInternalRuntimeRequest } from "./internal-runtime-request";
import {
  issueInternalRuntimeToken,
  resetConsumedInternalRuntimeTokensForTests,
} from "./internal-runtime-token";

const originalEnv = { ...process.env };
const audience = "urn:ea:internal-mcp:custom-mcp";

function request(token: string, headers: Record<string, string> = {}): Request {
  return {
    headers: { authorization: `Bearer ${token}`, ...headers },
    socket: { remoteAddress: "127.0.0.1" },
    ip: "127.0.0.1",
    method: "POST",
    path: "/api/internal/custom-mcp/mcp",
  } as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetConsumedInternalRuntimeTokensForTests();
  process.env.INTERNAL_RUNTIME_TOKEN_SECRET = "current-runtime-secret-that-is-long-enough-2026";
  process.env.INTERNAL_RUNTIME_TOKEN_REQUIRED = "true";
  mocks.getClawByAgentId.mockResolvedValue({
    agentId: "jiuwen_lgj-demo",
    adoptId: "lgj-demo",
    status: "active",
  });
  mocks.recordAudit.mockResolvedValue(undefined);
});

afterEach(() => { process.env = { ...originalEnv }; });

async function token(adoptId = "lgj-demo") {
  return (await issueInternalRuntimeToken({
    runtimeId: "jiuwenswarm-local",
    agentId: "jiuwen_lgj-demo",
    adoptId,
    audience,
  })).token;
}

describe("internal runtime request identity", () => {
  it("binds signed claims as the only trusted request identity", async () => {
    const req = request(await token());
    await expect(authorizeAndBindInternalRuntimeRequest(req, audience)).resolves.toBe(true);
    expect(req.headers["x-linggan-agent-id"]).toBe("jiuwen_lgj-demo");
    expect(req.headers["x-jiuwen-channel-id"]).toBe("lgj-demo");
  });

  it("rejects a signed adoption that is not bound to the runtime Agent", async () => {
    await expect(authorizeAndBindInternalRuntimeRequest(request(await token("lgj-other")), audience)).resolves.toBe(false);
    expect(mocks.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "security.internal_runtime_identity.denied",
      result: "denied",
    }));
  });

  it("rejects tampered identity headers and a wrong audience", async () => {
    await expect(authorizeAndBindInternalRuntimeRequest(
      request(await token(), { "x-jiuwen-channel-id": "lgj-other" }),
      audience,
    )).resolves.toBe(false);
    await expect(authorizeAndBindInternalRuntimeRequest(
      request(await token()),
      "urn:ea:internal-mcp:platform-tools",
    )).resolves.toBe(false);
  });

  it("rejects a replay of an already consumed jti", async () => {
    const signed = await token();
    await expect(authorizeAndBindInternalRuntimeRequest(request(signed), audience)).resolves.toBe(true);
    await expect(authorizeAndBindInternalRuntimeRequest(request(signed), audience)).resolves.toBe(false);
    expect(mocks.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { reason: "runtime token jti has already been consumed" },
    }));
  });
});
