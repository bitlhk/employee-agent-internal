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
  listClawsByUserId: vi.fn(async () => []),
  resolveEffectiveRoleAssets: vi.fn(async () => ({ skills: { default: [], optional: [] }, mcpServers: { default: [], optional: [] } })),
  resolvePersistedAgentMcpSelection: vi.fn(async () => ({ enabledServerIds: [], disabledServerIds: [] })),
  resolveTrustedChannelUser: vi.fn(async () => ({ id: 77, name: "已注册用户", email: "user@example.com" })),
  updateClawAdoptionStatus: vi.fn(async () => undefined),
  upsertClawProfileSettings: vi.fn(async () => undefined),
  provision: vi.fn(async () => ({ ok: true })),
  reconcileSkills: vi.fn(async () => ({ ok: true })),
  reconcileMcp: vi.fn(async () => ({ ok: true })),
  writeRoleScope: vi.fn(),
  listSkillsWithRoleDefaults: vi.fn(async () => ({ ok: true, value: [] })),
  listHistory: vi.fn(async () => ({ sessions: [] })),
  readHistory: vi.fn(async () => null),
  logError: vi.fn(),
}));

vi.mock("../db", () => ({
  appendClawAdoptionEvent: mocks.appendClawAdoptionEvent,
  createClawAdoption: mocks.createClawAdoption,
  createUser: mocks.createUser,
  getClawByAdoptId: mocks.getClawByAdoptId,
  getUserByOpenId: mocks.getUserByOpenId,
  listClawsByUserId: mocks.listClawsByUserId,
  resolveEffectiveRoleAssets: mocks.resolveEffectiveRoleAssets,
  resolvePersistedAgentMcpSelection: mocks.resolvePersistedAgentMcpSelection,
  resolveTrustedChannelUser: mocks.resolveTrustedChannelUser,
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

vi.mock("./skills/skill-onboarding", () => ({
  onboardBuiltinSkillsForAdopt: vi.fn(async () => undefined),
}));

vi.mock("./skills/role-default-skills", () => ({
  listSkillsWithRoleDefaults: mocks.listSkillsWithRoleDefaults,
}));

vi.mock("./chat-history", () => ({
  listClawChatHistorySessionRecords: mocks.listHistory,
  readModernChatHistorySessionMessages: mocks.readHistory,
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
    mocks.listClawsByUserId.mockResolvedValue([]);
    mocks.listSkillsWithRoleDefaults.mockResolvedValue({ ok: true, value: [] });
    mocks.listHistory.mockResolvedValue({ sessions: [] });
    mocks.readHistory.mockResolvedValue(null);
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

  it("reuses the registered user's existing EA adoption", async () => {
    const registeredAdoption = {
      ...adoption,
      userId: 77,
      adoptId: "lgj-existing1234",
      agentId: "jiuwen_lgj-existing1234",
      permissionProfile: "plus",
      ttlDays: 0,
      expiresAt: null,
    };
    mocks.listClawsByUserId.mockResolvedValue([registeredAdoption]);

    const response = await post(
      `${baseUrl}/api/internal/miniprogram/experience/chat`,
      {
        subject: "b".repeat(64),
        identity: {
          name: "已注册用户",
          verifiedEmail: "user@example.com",
          verifiedPhone: null,
          onboardingComplete: true,
        },
        message: "继续上次的话题",
        conversationId: "mini-conversation-456",
      },
      process.env.MINIPROGRAM_EXPERIENCE_TOKEN
    );

    expect(response.status, response.body).toBe(200);
    expect(mocks.resolveTrustedChannelUser).toHaveBeenCalledWith(expect.objectContaining({
      provider: "linggan",
      verifiedEmail: "user@example.com",
    }));
    expect(mocks.createClawAdoption).not.toHaveBeenCalled();
    const upstreamRequest = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(upstreamRequest.body));
    expect(body).toMatchObject({
      adoptId: "lgj-existing1234",
      experienceMode: "mini_owner",
      model: "modelarts-maas/glm-5.2",
    });
    expect(body).not.toHaveProperty("selectedSkillIds");
  });

  it("passes registered mobile skill selections to the owned runtime", async () => {
    const registeredAdoption = {
      ...adoption,
      userId: 77,
      adoptId: "lgj-existing1234",
      agentId: "jiuwen_lgj-existing1234",
      permissionProfile: "plus",
      ttlDays: 0,
      expiresAt: null,
    };
    mocks.listClawsByUserId.mockResolvedValue([registeredAdoption]);

    const response = await post(
      `${baseUrl}/api/internal/miniprogram/experience/chat`,
      {
        subject: "d".repeat(64),
        identity: {
          name: "已注册用户",
          verifiedEmail: "user@example.com",
          onboardingComplete: true,
        },
        message: "使用财富技能生成方案",
        conversationId: "mini-conversation-789",
        selectedSkillIds: ["wealth-manager-assistant"],
      },
      process.env.MINIPROGRAM_EXPERIENCE_TOKEN
    );

    expect(response.status, response.body).toBe(200);
    const upstreamRequest = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(upstreamRequest.body))).toMatchObject({
      experienceMode: "mini_owner",
      selectedSkillIds: ["wealth-manager-assistant"],
    });
  });

  it("answers skill inventory questions from the governed capability catalog", async () => {
    const registeredAdoption = {
      ...adoption,
      userId: 77,
      adoptId: "lgj-existing1234",
      agentId: "jiuwen_lgj-existing1234",
      permissionProfile: "plus",
      ttlDays: 0,
      expiresAt: null,
    };
    mocks.listClawsByUserId.mockResolvedValue([registeredAdoption]);
    mocks.listSkillsWithRoleDefaults.mockResolvedValue({
      ok: true,
      value: [{
        id: "wealth-manager-assistant",
        source: { displayName: "财富经理助手", description: "财富管理技能" },
        enabled: true,
        state: "ready",
      }],
    });

    const response = await post(
      `${baseUrl}/api/internal/miniprogram/experience/chat`,
      {
        subject: "e".repeat(64),
        identity: {
          name: "已注册用户",
          verifiedEmail: "user@example.com",
          onboardingComplete: true,
        },
        message: "你有哪些技能？",
        conversationId: "mini-conversation-capabilities",
      },
      process.env.MINIPROGRAM_EXPERIENCE_TOKEN
    );

    expect(response.status, response.body).toBe(200);
    expect(response.body).toContain("财富经理助手");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns only the owned adoption history summary", async () => {
    const registeredAdoption = {
      ...adoption,
      userId: 77,
      adoptId: "lgj-existing1234",
      agentId: "jiuwen_lgj-existing1234",
      permissionProfile: "plus",
      ttlDays: 0,
      expiresAt: null,
    };
    mocks.listClawsByUserId.mockResolvedValue([registeredAdoption]);
    mocks.listHistory.mockResolvedValue({
      sessions: [{
        conversationId: "mini-conversation-old",
        sessionKey: "sess_lgj-existing1234_web_old_e0",
        title: "历史问题",
        preview: "历史回答",
        messageCount: 2,
        updatedAt: 100,
      }],
    });

    const response = await post(
      `${baseUrl}/api/internal/miniprogram/experience/history`,
      {
        subject: "f".repeat(64),
        identity: {
          name: "已注册用户",
          verifiedEmail: "user@example.com",
          onboardingComplete: true,
        },
        limit: 20,
      },
      process.env.MINIPROGRAM_EXPERIENCE_TOKEN
    );

    expect(response.status, response.body).toBe(200);
    expect(JSON.parse(response.body).sessions).toEqual([
      expect.objectContaining({ conversationId: "mini-conversation-old", title: "历史问题" }),
    ]);
  });

  it("provisions one deterministic adoption for a registered user without one", async () => {
    const registeredAdoption = {
      ...adoption,
      userId: 77,
      adoptId: "lgj-deterministic-channel",
      agentId: "jiuwen_lgj-deterministic-channel",
      permissionProfile: "plus",
      ttlDays: 0,
      expiresAt: null,
    };
    mocks.getClawByAdoptId.mockReset();
    mocks.getClawByAdoptId.mockResolvedValueOnce(null).mockResolvedValue(registeredAdoption);
    mocks.listClawsByUserId.mockResolvedValue([]);

    const response = await post(
      `${baseUrl}/api/internal/miniprogram/account/agents`,
      {
        subject: "c".repeat(64),
        identity: {
          name: "新注册用户",
          verifiedEmail: "new@example.com",
          onboardingComplete: true,
        },
        ensure: true,
      },
      process.env.MINIPROGRAM_EXPERIENCE_TOKEN
    );

    expect(response.status, response.body).toBe(200);
    expect(mocks.createClawAdoption).toHaveBeenCalledOnce();
    expect(mocks.createClawAdoption).toHaveBeenCalledWith(expect.objectContaining({
      userId: 77,
      adoptId: expect.stringMatching(/^lgj-[a-f0-9]{24}$/u),
      permissionProfile: "plus",
    }));
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
      model: "modelarts-maas/glm-5.2",
      selectedSkillIds: [],
      knowledgeBaseIds: [],
    });
  });
});
