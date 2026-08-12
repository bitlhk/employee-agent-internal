import { createHash, randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  appendClawAdoptionEvent,
  createClawAdoption,
  createUser,
  getClawByAdoptId,
  getUserByOpenId,
  listClawsByUserId,
  resolvePersistedAgentMcpSelection,
  resolveEffectiveRoleAssets,
  resolveTrustedChannelUser,
  updateClawAdoptionStatus,
  upsertClawProfileSettings,
} from "../db";
import { getRoleRuntimeAdapter, isJiuwenSwarmProvisionEnabled } from "../routers/role-runtime-adapters";
import type { EffectiveRoleAssets } from "./role-asset-grants";
import { isAuthorizedInternalRequest, resolveRuntimeWorkspaceByIds } from "./helpers";
import {
  listClawChatHistorySessionRecords,
  readModernChatHistorySessionMessages,
} from "./chat-history";
import { writeJiuwenSwarmRoleScopeManifest } from "./jiuwenswarm-role-scope";
import { logError, logInfo, logWarn } from "./observability/logger";
import { resolvePublicBaseUrl } from "./public-base-url";
import { resolveAgentRoleTemplate } from "./role-templates";
import { onboardBuiltinSkillsForAdopt } from "./skills/skill-onboarding";
import { listSkillsWithRoleDefaults } from "./skills/role-default-skills";

const MINI_EXPERIENCE_TTL_DAYS = 30;
const MINI_EXPERIENCE_TIMEOUT_MS = 120_000;
const EMPTY_ROLE_ASSETS: EffectiveRoleAssets = {
  skills: { default: [], optional: [] },
  mcpServers: { default: [], optional: [] },
};

const MiniExperienceInput = z.object({
  subject: z.string().regex(/^[a-f0-9]{64}$/u, "subject 无效"),
  identity: z.object({
    name: z.string().trim().min(1).max(100),
    verifiedEmail: z.string().email().nullable().optional(),
    verifiedPhone: z.string().trim().min(6).max(24).nullable().optional(),
    onboardingComplete: z.literal(true),
  }).optional(),
  adoptionId: z.string().regex(/^lgj-[A-Za-z0-9_-]{4,60}$/u).optional(),
  message: z.string().trim().min(1, "请输入问题").max(2000, "问题不能超过 2000 字"),
  conversationId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u, "conversationId 无效"),
  selectedSkillIds: z.array(
    z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/u),
  ).max(8).default([]),
});

type MiniExperienceAdoption = NonNullable<Awaited<ReturnType<typeof getClawByAdoptId>>>;

type MobileExperienceCapabilities = {
  skillSelection: boolean;
  mcpSelection: false;
  skills: Array<{
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    ready: boolean;
  }>;
  mcpServers: Array<{
    id: string;
    name: string;
    enabled: true;
  }>;
};

const MiniExperienceAccountInput = MiniExperienceInput.pick({
  subject: true,
  identity: true,
  adoptionId: true,
});

const provisioning = new Map<string, Promise<MiniExperienceAdoption>>();
const registeredProvisioning = new Map<number, Promise<MiniExperienceAdoption>>();

export function miniExperienceIdentity(subject: string) {
  const digest = createHash("sha256").update(`wechat-mini-experience:${subject}`).digest("hex");
  const adoptId = `lgj-mini-${digest.slice(0, 24)}`;
  return {
    openId: `mini-exp-${digest.slice(0, 40)}`,
    adoptId,
    agentId: `jiuwen_${adoptId}`,
  };
}

function experienceToken(): string {
  return String(process.env.MINIPROGRAM_EXPERIENCE_TOKEN || "").trim();
}

function miniExperienceModelId(): string {
  return String(process.env.MINIPROGRAM_EXPERIENCE_MODEL_ID || "__auto").trim();
}

function isExperienceRequestAuthorized(req: Request): boolean {
  const token = experienceToken();
  return token.length >= 32 && isAuthorizedInternalRequest(req, token);
}

function expiresAt(): Date {
  return new Date(Date.now() + MINI_EXPERIENCE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

function readableCapabilityName(value: string): string {
  return value
    .split(/[-_.]+/u)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || value;
}

async function resolveMobileExperienceCapabilities(
  adoption: MiniExperienceAdoption,
): Promise<MobileExperienceCapabilities> {
  const roleTemplate = String(adoption.roleTemplate || "general-assistant");
  const agentId = String(adoption.agentId || `jiuwen_${adoption.adoptId}`);
  const [listedSkills, effectiveAssets] = await Promise.all([
    listSkillsWithRoleDefaults({
      adoptId: String(adoption.adoptId),
      agentId,
      roleTemplate,
    }),
    resolveEffectiveRoleAssets(roleTemplate),
  ]);
  const mcpSelection = await resolvePersistedAgentMcpSelection(
    String(adoption.adoptId),
    effectiveAssets,
  ).catch(error => {
    logWarn("miniprogram_account.mcp_selection_unavailable", {
      adoptId: String(adoption.adoptId),
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      enabledServerIds: effectiveAssets.mcpServers.default,
      disabledServerIds: effectiveAssets.mcpServers.optional,
    };
  });

  return {
    skillSelection: true,
    mcpSelection: false,
    skills: listedSkills.ok
      ? listedSkills.value.map(skill => ({
          id: skill.id,
          name: String(skill.source.displayName || skill.id),
          description: String(skill.source.description || "智能体技能").slice(0, 300),
          enabled: Boolean(skill.enabled),
          ready: Boolean(skill.enabled && skill.state === "ready"),
        }))
      : [],
    mcpServers: mcpSelection.enabledServerIds.map(id => ({
      id,
      name: readableCapabilityName(id),
      enabled: true as const,
    })),
  };
}

function capabilityInventoryIntent(message: string): "skills" | "mcp" | "all" | null {
  const normalized = String(message || "").trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > 80) return null;
  const skill = /(?:哪些|什么|列出|查看|介绍|可用).{0,16}(?:技能|skills?)|(?:技能|skills?).{0,12}(?:哪些|什么|列表|可用)/iu.test(normalized);
  const mcp = /(?:哪些|什么|列出|查看|介绍|可用).{0,16}(?:mcp|连接工具|连接器)|(?:mcp|连接工具|连接器).{0,12}(?:哪些|什么|列表|可用)/iu.test(normalized);
  if (skill && mcp) return "all";
  if (skill) return "skills";
  if (mcp) return "mcp";
  return null;
}

function capabilityInventoryAnswer(
  capabilities: MobileExperienceCapabilities,
  intent: "skills" | "mcp" | "all",
): string {
  const sections: string[] = [];
  if (intent === "skills" || intent === "all") {
    const skills = capabilities.skills.filter(skill => skill.ready);
    sections.push(skills.length
      ? `当前岗位可用技能（${skills.length} 个）：\n${skills.map((skill, index) => `${index + 1}. ${skill.name}`).join("\n")}`
      : "当前岗位暂无可运行技能。");
  }
  if (intent === "mcp" || intent === "all") {
    sections.push(capabilities.mcpServers.length
      ? `当前岗位已授权连接（${capabilities.mcpServers.length} 个）：\n${capabilities.mcpServers.map((server, index) => `${index + 1}. ${server.name}`).join("\n")}`
      : "当前岗位暂无已授权连接。");
  }
  return `${sections.join("\n\n")}\n\n手机 App 可在输入框上方查看；未手动选择技能时，Agent 会按任务自动匹配。`;
}

function sendMiniExperienceSseAnswer(res: Response, answer: string): void {
  res.status(200);
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.write(`data: ${JSON.stringify({ __final_text: answer })}\n\n`);
  res.write(`data: ${JSON.stringify({ __stream_end: true })}\n\n`);
  res.end("data: [DONE]\n\n");
}

async function ensureMiniExperienceUser(openId: string): Promise<number> {
  const existing = await getUserByOpenId(openId);
  if (existing) return Number(existing.id);

  try {
    return await createUser({
      openId,
      name: "微信轻体验用户",
      loginMethod: "miniprogram_experience",
      accessLevel: "public_only",
      role: "user",
      lastSignedIn: new Date(),
    });
  } catch (error) {
    const raced = await getUserByOpenId(openId);
    if (raced) return Number(raced.id);
    throw error;
  }
}

async function provisionMiniExperienceAdoption(subject: string): Promise<MiniExperienceAdoption> {
  if (!isJiuwenSwarmProvisionEnabled()) {
    throw new Error("JiuwenSwarm 试用运行时尚未启用");
  }

  const identity = miniExperienceIdentity(subject);
  const existing = await getClawByAdoptId(identity.adoptId);
  if (existing?.status === "active") {
    const role = resolveAgentRoleTemplate("general-assistant");
    writeJiuwenSwarmRoleScopeManifest({
      workspaceDir: resolveRuntimeWorkspaceByIds(identity.adoptId, identity.agentId),
      role,
      effectiveAssets: EMPTY_ROLE_ASSETS,
      activeSkillIds: [],
      disabledDefaultSkillIds: [],
      activeMcpServerIds: [],
      includePlatformMcp: false,
    });
    await updateClawAdoptionStatus(Number(existing.id), "active", {
      ttlDays: MINI_EXPERIENCE_TTL_DAYS,
      expiresAt: expiresAt(),
      lastError: null,
    });
    await upsertClawProfileSettings(Number(existing.id), {
      memoryEnabled: "no",
      memoryMode: "off",
      crossSessionContext: "no",
    });
    return (await getClawByAdoptId(identity.adoptId)) || existing;
  }

  const userId = existing?.userId
    ? Number(existing.userId)
    : await ensureMiniExperienceUser(identity.openId);
  const role = resolveAgentRoleTemplate("general-assistant");
  const runtimeAdapter = getRoleRuntimeAdapter("jiuwenswarm");
  let adoptionId = existing ? Number(existing.id) : 0;

  if (!existing) {
    try {
      adoptionId = await createClawAdoption({
        userId,
        adoptId: identity.adoptId,
        agentId: identity.agentId,
        status: "creating",
        permissionProfile: "starter",
        roleTemplate: role.id,
        industry: role.industry,
        runtime: "jiuwenswarm",
        ttlDays: MINI_EXPERIENCE_TTL_DAYS,
        entryUrl: `${resolvePublicBaseUrl()}/claw/${encodeURIComponent(identity.adoptId)}`,
        expiresAt: expiresAt(),
      });
    } catch (error) {
      const raced = await getClawByAdoptId(identity.adoptId);
      if (!raced) throw error;
      adoptionId = Number(raced.id);
    }
  } else {
    await updateClawAdoptionStatus(adoptionId, "creating", {
      ttlDays: MINI_EXPERIENCE_TTL_DAYS,
      expiresAt: expiresAt(),
      lastError: null,
    });
  }

  await appendClawAdoptionEvent({
    adoptionId,
    eventType: "create_requested",
    operatorType: "system",
    operatorId: null,
    detail: JSON.stringify({ source: "miniprogram_experience", roleTemplate: role.id }),
  });

  try {
    await runtimeAdapter.provision({
      adoptId: identity.adoptId,
      agentId: identity.agentId,
      userId,
      permissionProfile: "starter",
      ttlDays: MINI_EXPERIENCE_TTL_DAYS,
      role,
      effectiveAssets: EMPTY_ROLE_ASSETS,
    });
    await runtimeAdapter.reconcileSkills({
      adoptId: identity.adoptId,
      agentId: identity.agentId,
      role,
      effectiveAssets: EMPTY_ROLE_ASSETS,
      activeSkillIds: [],
      disabledDefaultSkillIds: [],
    });
    await runtimeAdapter.reconcileMcp({
      adoptId: identity.adoptId,
      agentId: identity.agentId,
      role,
      effectiveAssets: EMPTY_ROLE_ASSETS,
    });
    writeJiuwenSwarmRoleScopeManifest({
      workspaceDir: resolveRuntimeWorkspaceByIds(identity.adoptId, identity.agentId),
      role,
      effectiveAssets: EMPTY_ROLE_ASSETS,
      activeSkillIds: [],
      disabledDefaultSkillIds: [],
      activeMcpServerIds: [],
      includePlatformMcp: false,
    });
    await upsertClawProfileSettings(adoptionId, {
      displayName: "岗位智能体轻体验",
      memoryEnabled: "no",
      memoryMode: "off",
      crossSessionContext: "no",
    });
    await updateClawAdoptionStatus(adoptionId, "active", {
      ttlDays: MINI_EXPERIENCE_TTL_DAYS,
      expiresAt: expiresAt(),
      lastError: null,
    });
    await appendClawAdoptionEvent({
      adoptionId,
      eventType: "create_succeeded",
      operatorType: "system",
      operatorId: null,
      detail: JSON.stringify({ source: "miniprogram_experience" }),
    });
  } catch (error) {
    await updateClawAdoptionStatus(adoptionId, "failed", {
      lastError: error instanceof Error ? error.message.slice(0, 1000) : "provision failed",
    }).catch(() => undefined);
    throw error;
  }

  const adoption = await getClawByAdoptId(identity.adoptId);
  if (!adoption) throw new Error("轻体验智能体创建失败");
  logInfo("miniprogram_experience.provisioned", {
    adoptId: identity.adoptId,
    userId,
  });
  return adoption;
}

export async function ensureMiniExperienceAdoption(subject: string): Promise<MiniExperienceAdoption> {
  const existing = provisioning.get(subject);
  if (existing) return existing;
  const pending = provisionMiniExperienceAdoption(subject).finally(() => provisioning.delete(subject));
  provisioning.set(subject, pending);
  return pending;
}

function selectRegisteredAdoption(
  adoptions: MiniExperienceAdoption[],
  requestedAdoptionId?: string,
): MiniExperienceAdoption | null {
  const jiuwen = adoptions.filter(adoption =>
    adoption.adoptId.startsWith("lgj-") && !adoption.adoptId.startsWith("lgj-mini-")
  );
  if (requestedAdoptionId) {
    return jiuwen.find(adoption => adoption.adoptId === requestedAdoptionId) || null;
  }
  return jiuwen.find(adoption => adoption.status === "active") ||
    jiuwen.find(adoption => adoption.status === "creating") ||
    null;
}

function registeredAdoptionId(subject: string): string {
  const digest = createHash("sha256").update(`linggan-registered:${subject}`).digest("hex");
  return `lgj-${digest.slice(0, 24)}`;
}

async function waitForRegisteredAdoption(adoptId: string, userId: number): Promise<MiniExperienceAdoption> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const adoption = await getClawByAdoptId(adoptId);
    if (adoption && Number(adoption.userId) !== userId) throw new Error("岗位智能体归属校验失败");
    if (adoption?.status === "active") return adoption;
    if (adoption?.status === "failed") throw new Error("岗位智能体初始化失败");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("岗位智能体初始化超时");
}

async function provisionRegisteredAdoption(userId: number, subject: string): Promise<MiniExperienceAdoption> {
  if (!isJiuwenSwarmProvisionEnabled()) throw new Error("JiuwenSwarm 运行时尚未启用");
  const existing = selectRegisteredAdoption(await listClawsByUserId(userId));
  if (existing?.status === "active") return existing;
  if (existing?.status === "creating") return waitForRegisteredAdoption(existing.adoptId, userId);
  const inFlight = registeredProvisioning.get(userId);
  if (inFlight) return inFlight;

  const pending = (async () => {
    const raced = selectRegisteredAdoption(await listClawsByUserId(userId));
    if (raced?.status === "active") return raced;
    if (raced?.status === "creating") return waitForRegisteredAdoption(raced.adoptId, userId);
    const role = resolveAgentRoleTemplate("general-assistant");
    const effectiveAssets = await resolveEffectiveRoleAssets(role.id);
    const adoptId = registeredAdoptionId(subject);
    const agentId = `jiuwen_${adoptId}`;
    const previous = await getClawByAdoptId(adoptId);
    let adoptionId: number;
    if (previous) {
      if (Number(previous.userId) !== userId) throw new Error("岗位智能体归属校验失败");
      if (previous.status === "active") return previous;
      if (previous.status === "creating") return waitForRegisteredAdoption(adoptId, userId);
      adoptionId = Number(previous.id);
      await updateClawAdoptionStatus(adoptionId, "creating", { lastError: null });
    } else {
      try {
        adoptionId = await createClawAdoption({
          userId,
          adoptId,
          agentId,
          status: "creating",
          permissionProfile: "plus",
          roleTemplate: role.id,
          industry: role.industry,
          runtime: "jiuwenswarm",
          ttlDays: 0,
          entryUrl: `${resolvePublicBaseUrl()}/claw/${encodeURIComponent(adoptId)}`,
          expiresAt: null,
        });
      } catch (error) {
        const collision = await getClawByAdoptId(adoptId);
        if (collision && Number(collision.userId) === userId) {
          return waitForRegisteredAdoption(adoptId, userId);
        }
        throw error;
      }
    }
    await appendClawAdoptionEvent({
      adoptionId,
      eventType: "create_requested",
      operatorType: "user",
      operatorId: userId,
      detail: JSON.stringify({ source: "linggan_miniprogram", roleTemplate: role.id }),
    });
    try {
      const adapter = getRoleRuntimeAdapter("jiuwenswarm");
      await adapter.provision({
        adoptId,
        agentId,
        userId,
        permissionProfile: "plus",
        ttlDays: 0,
        role,
        effectiveAssets,
      });
      await adapter.reconcileSkills({ adoptId, agentId, role, effectiveAssets });
      await adapter.reconcileMcp({ adoptId, agentId, role, effectiveAssets });
      await updateClawAdoptionStatus(adoptionId, "active", { lastError: null });
      await appendClawAdoptionEvent({
        adoptionId,
        eventType: "create_succeeded",
        operatorType: "system",
        operatorId: null,
        detail: JSON.stringify({ source: "linggan_miniprogram" }),
      });
      void onboardBuiltinSkillsForAdopt(adoptId, agentId).catch(error => {
        logWarn("miniprogram_account.skill_onboarding_failed", {
          adoptId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      const created = await getClawByAdoptId(adoptId);
      if (!created) throw new Error("岗位智能体创建后未找到实例");
      return created;
    } catch (error) {
      await updateClawAdoptionStatus(adoptionId, "failed", {
        lastError: error instanceof Error ? error.message.slice(0, 1000) : "provision failed",
      }).catch(() => undefined);
      throw error;
    }
  })().finally(() => registeredProvisioning.delete(userId));
  registeredProvisioning.set(userId, pending);
  return pending;
}

async function resolveRegisteredAdoption(
  input: z.infer<typeof MiniExperienceInput>,
  ensure = true,
) {
  if (!input.identity) throw new Error("灵感账号资料不完整");
  const user = await resolveTrustedChannelUser({
    provider: "linggan",
    subject: input.subject,
    name: input.identity.name,
    verifiedEmail: input.identity.verifiedEmail,
    verifiedPhone: input.identity.verifiedPhone,
  });
  let adoptions = (await listClawsByUserId(user.id)).filter(adoption =>
    adoption.adoptId.startsWith("lgj-") && !adoption.adoptId.startsWith("lgj-mini-")
  );
  let adoption = selectRegisteredAdoption(adoptions, input.adoptionId);
  if (input.adoptionId && !adoption) throw new Error("所选岗位智能体不属于当前账号");
  if (!adoption && ensure) {
    adoption = await provisionRegisteredAdoption(user.id, input.subject);
    adoptions = (await listClawsByUserId(user.id)).filter(item =>
      item.adoptId.startsWith("lgj-") && !item.adoptId.startsWith("lgj-mini-")
    );
  }
  return { userId: user.id, adoption, adoptions };
}

async function proxyRestrictedChat(
  req: Request,
  res: Response,
  adoption: MiniExperienceAdoption,
  input: z.infer<typeof MiniExperienceInput>,
  registered: boolean,
): Promise<void> {
  const internalKey = String(process.env.INTERNAL_API_KEY || "").trim();
  if (internalKey.length < 16) throw new Error("INTERNAL_API_KEY 未配置");

  if (registered) {
    const inventoryIntent = capabilityInventoryIntent(input.message);
    if (inventoryIntent) {
      const capabilities = await resolveMobileExperienceCapabilities(adoption);
      sendMiniExperienceSseAnswer(
        res,
        capabilityInventoryAnswer(capabilities, inventoryIntent),
      );
      return;
    }
  }

  const port = Number.parseInt(String(process.env.PORT || "5174"), 10) || 5174;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MINI_EXPERIENCE_TIMEOUT_MS);
  timeout.unref?.();
  const abort = () => controller.abort();
  req.once("aborted", abort);
  res.once("close", abort);

  try {
    const upstream = await fetch(`http://127.0.0.1:${port}/api/claw/chat-stream`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        adoptId: adoption.adoptId,
        message: input.message,
        conversationId: input.conversationId,
        clientRunId: randomUUID(),
        channel: "miniprogram",
        runtimeMode: "fast",
        model: miniExperienceModelId(),
        experienceMode: registered ? "mini_owner" : "mini_trial",
        ...(registered
          ? (input.selectedSkillIds.length ? { selectedSkillIds: input.selectedSkillIds } : {})
          : { selectedSkillIds: [], knowledgeBaseIds: [] }),
      }),
      signal: controller.signal,
    });

    res.status(upstream.status);
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-type", upstream.headers.get("content-type") || "application/json; charset=utf-8");
    if (!upstream.body) {
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    while (!res.writableEnded) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    if (!res.writableEnded) res.end();
  } finally {
    clearTimeout(timeout);
    req.off("aborted", abort);
    res.off("close", abort);
  }
}

export function registerMiniExperienceRoutes(app: Express): void {
  app.post("/api/internal/miniprogram/account/agents", async (req, res) => {
    if (!isExperienceRequestAuthorized(req)) {
      res.status(experienceToken() ? 401 : 503).json({ error: "渠道账号服务未配置" });
      return;
    }
    try {
      const accountInput = MiniExperienceAccountInput.extend({
        ensure: z.boolean().default(true),
      }).parse(req.body);
      const resolved = await resolveRegisteredAdoption({
        subject: accountInput.subject,
        identity: accountInput.identity,
        message: "status",
        conversationId: "channel-account-status",
        selectedSkillIds: [],
      }, accountInput.ensure);
      res.setHeader("cache-control", "no-store");
      const capabilities = resolved.adoption
        ? await resolveMobileExperienceCapabilities(resolved.adoption).catch(error => {
            logWarn("miniprogram_account.capabilities_unavailable", {
              adoptId: resolved.adoption?.adoptId || "",
              error: error instanceof Error ? error.message : String(error),
            });
            return null;
          })
        : null;
      res.json({
        selectedAdoptionId: resolved.adoption?.adoptId || null,
        capabilities,
        agents: resolved.adoptions.map(adoption => ({
          adoptionId: adoption.adoptId,
          roleTemplate: adoption.roleTemplate,
          status: adoption.status,
        })),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message || "请求参数无效" });
        return;
      }
      logError("miniprogram_account.failed", error);
      res.status(503).json({ error: "岗位智能体账号暂时不可用" });
    }
  });

  app.post("/api/internal/miniprogram/experience/history", async (req, res) => {
    if (!isExperienceRequestAuthorized(req)) {
      res.status(experienceToken() ? 401 : 503).json({ error: "渠道账号服务未配置" });
      return;
    }
    try {
      const input = MiniExperienceAccountInput.extend({
        limit: z.number().int().min(1).max(30).default(20),
      }).parse(req.body);
      const resolved = await resolveRegisteredAdoption({
        ...input,
        message: "history",
        conversationId: "channel-history-list",
        selectedSkillIds: [],
      }, false);
      if (!resolved.adoption) {
        res.json({ sessions: [] });
        return;
      }
      const payload = await listClawChatHistorySessionRecords({
        adoptId: String(resolved.adoption.adoptId),
        claw: resolved.adoption,
        limit: input.limit,
      });
      const sessions = (Array.isArray(payload.sessions) ? payload.sessions : [])
        .map(session => ({
          conversationId: String(session?.conversationId || ""),
          sessionKey: String(session?.sessionKey || ""),
          title: String(session?.title || "新对话").slice(0, 80),
          preview: String(session?.preview || "").slice(0, 160),
          messageCount: Math.max(0, Number(session?.messageCount || 0)),
          updatedAt: Math.max(0, Number(session?.updatedAt || 0)),
        }))
        .filter(session => session.conversationId && session.sessionKey && session.messageCount > 0);
      res.setHeader("cache-control", "no-store");
      res.json({ sessions });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message || "请求参数无效" });
        return;
      }
      logError("miniprogram_experience.history_failed", error);
      res.status(503).json({ error: "历史会话暂时不可用" });
    }
  });

  app.post("/api/internal/miniprogram/experience/history/messages", async (req, res) => {
    if (!isExperienceRequestAuthorized(req)) {
      res.status(experienceToken() ? 401 : 503).json({ error: "渠道账号服务未配置" });
      return;
    }
    try {
      const input = MiniExperienceAccountInput.extend({
        sessionKey: z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9:_-]+$/u),
      }).parse(req.body);
      const resolved = await resolveRegisteredAdoption({
        ...input,
        message: "history",
        conversationId: "channel-history-messages",
        selectedSkillIds: [],
      }, false);
      if (!resolved.adoption) {
        res.status(404).json({ error: "历史会话不存在" });
        return;
      }
      const adoption = resolved.adoption;
      const history = await readModernChatHistorySessionMessages({
        adoptId: String(adoption.adoptId),
        dbAgentId: String(adoption.agentId || ""),
        sessionKey: input.sessionKey,
        workspaceDir: resolveRuntimeWorkspaceByIds(String(adoption.adoptId), String(adoption.agentId || "")),
        maxMessages: 100,
      });
      if (!history) {
        res.status(404).json({ error: "历史会话不存在" });
        return;
      }
      res.setHeader("cache-control", "no-store");
      res.json({
        conversationId: history.conversationId,
        messages: history.messages.map(message => ({
          id: String(message.id || randomUUID()),
          role: message.role,
          text: String(message.text || "").slice(0, 12_000),
          timestamp: Math.max(0, Number(message.timestamp || 0)),
        })).filter(message => message.text),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message || "请求参数无效" });
        return;
      }
      logError("miniprogram_experience.history_messages_failed", error);
      res.status(503).json({ error: "历史消息暂时不可用" });
    }
  });

  app.post("/api/internal/miniprogram/experience/chat", async (req, res) => {
    if (!isExperienceRequestAuthorized(req)) {
      res.status(experienceToken() ? 401 : 503).json({ error: "轻体验服务未配置" });
      return;
    }

    try {
      const input = MiniExperienceInput.parse(req.body);
      const registered = Boolean(input.identity);
      const adoption = registered
        ? (await resolveRegisteredAdoption(input)).adoption
        : await ensureMiniExperienceAdoption(input.subject);
      if (!adoption) throw new Error("岗位智能体尚未创建");
      await proxyRestrictedChat(req, res, adoption, input, registered);
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        logWarn("miniprogram_experience.stream_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message || "请求参数无效" });
        return;
      }
      logError("miniprogram_experience.failed", error);
      res.status(503).json({ error: "岗位智能体轻体验暂时不可用" });
    }
  });
}
