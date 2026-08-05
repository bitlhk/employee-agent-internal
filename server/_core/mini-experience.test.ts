import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendClawAdoptionEvent: vi.fn(async () => undefined),
  createClawAdoption: vi.fn(async () => 123),
  createUser: vi.fn(async () => 99),
  getClawByAdoptId: vi.fn(),
  getUserByOpenId: vi.fn(async () => undefined),
  updateClawAdoptionStatus: vi.fn(async () => undefined),
  upsertClawProfileSettings: vi.fn(async () => undefined),
  provision: vi.fn(async () => ({ ok: true })),
  reconcileSkills: vi.fn(async () => ({ ok: true })),
  reconcileMcp: vi.fn(async () => ({ ok: true })),
  writeRoleScope: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../db", () => ({
  appendClawAdoptionEvent: mocks.appendClawAdoptionEvent,
  createClawAdoption: mocks.createClawAdoption,
  createUser: mocks.createUser,
  getClawByAdoptId: mocks.getClawByAdoptId,
  getUserByOpenId: mocks.getUserByOpenId,
  updateClawAdoptionStatus: mocks.updateClawAdoptionStatus,
  upsertClawProfileSettings: mocks.upsertClawProfileSettings,
}));

vi.mock("../routers/role-runtime-adapters", () => ({
  isJiuwenSwarmProvisionEnabled: () => true,
  getRoleRuntimeAdapter: () => ({
    provision: mocks.provision,
    reconcileSkills: mocks.reconcileSkills,
    reconcileMcp: mocks.reconcileMcp,
  }),
}));

vi.mock("./jiuwenswarm-role-scope", () => ({
  writeJiuwenSwarmRoleScopeManifest: mocks.writeRoleScope,
}));

vi.mock("./observability/logger", () => ({
  logError: mocks.logError,
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

process.env.MINIPROGRAM_EXPERIENCE_TOKEN = "e".repeat(32);
process.env.INTERNAL_API_KEY = "i".repeat(32);
process.env.PORT = "5174";

const { registerMiniExperienceRoutes } = await import("./mini-experience");

const adoption = {
  id: 123,
  userId: 99,
  adoptId: "lgj-mini-123456789012345678901234",
  agentId: "jiuwen_lgj-mini-123456789012345678901234",
  status: "active",
  permissionProfile: "starter",
  roleTemplate: "general-assistant",
  industry: "general",
  runtime: "jiuwenswarm",
  ttlDays: 30,
  entryUrl: "https://work.example/claw/test",
  expiresAt: new Date(),
  lastError: null,
  lastActivityAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function post(
  url: string,
  body: Record<string, unknown>,
  token?: string
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    request.on("error", reject);
    request.end(payload);
  });
}

describe("EA Mini Program experience route", () => {
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    registerMiniExperienceRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClawByAdoptId.mockReset();
    mocks.getClawByAdoptId
      .mockResolvedValueOnce(null)
      .mockResolvedValue(adoption);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          'data: {"choices":[{"delta":{"content":"试用回答"}}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
      )
    );
  });

  it("rejects callers without the dedicated experience token", async () => {
    const response = await post(
      `${baseUrl}/api/internal/miniprogram/experience/chat`,
      {}
    );

    expect(response.status).toBe(401);
  });

  it("provisions an isolated empty-scope agent and proxies restricted chat", async () => {
    const response = await post(
      `${baseUrl}/api/internal/miniprogram/experience/chat`,
      {
        subject: "a".repeat(64),
        message: "你好",
        conversationId: "mini-conversation-123",
      },
      process.env.MINIPROGRAM_EXPERIENCE_TOKEN
    );

    expect(response.status, response.body).toBe(200);
    expect(response.body).toContain("试用回答");
    expect(mocks.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        loginMethod: "miniprogram_experience",
        accessLevel: "public_only",
      })
    );
    expect(mocks.provision).toHaveBeenCalledWith(
      expect.objectContaining({ permissionProfile: "starter" })
    );
    expect(mocks.writeRoleScope).toHaveBeenCalledWith(
      expect.objectContaining({
        activeMcpServerIds: [],
        includePlatformMcp: false,
      })
    );
    const upstreamRequest = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(upstreamRequest.body))).toMatchObject({
      experienceMode: "mini_trial",
      selectedSkillIds: [],
      knowledgeBaseIds: [],
    });
  });
});
