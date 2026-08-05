import { createHash, randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  appendClawAdoptionEvent,
  createClawAdoption,
  createUser,
  getClawByAdoptId,
  getUserByOpenId,
  updateClawAdoptionStatus,
  upsertClawProfileSettings,
} from "../db";
import { getRoleRuntimeAdapter, isJiuwenSwarmProvisionEnabled } from "../routers/role-runtime-adapters";
import type { EffectiveRoleAssets } from "./role-asset-grants";
import { isAuthorizedInternalRequest, resolveRuntimeWorkspaceByIds } from "./helpers";
import { writeJiuwenSwarmRoleScopeManifest } from "./jiuwenswarm-role-scope";
import { logError, logInfo, logWarn } from "./observability/logger";
import { resolvePublicBaseUrl } from "./public-base-url";
import { resolveAgentRoleTemplate } from "./role-templates";

const MINI_EXPERIENCE_TTL_DAYS = 30;
const MINI_EXPERIENCE_TIMEOUT_MS = 120_000;
const EMPTY_ROLE_ASSETS: EffectiveRoleAssets = {
  skills: { default: [], optional: [] },
  mcpServers: { default: [], optional: [] },
};

const MiniExperienceInput = z.object({
  subject: z.string().regex(/^[a-f0-9]{64}$/u, "subject 无效"),
  message: z.string().trim().min(1, "请输入问题").max(2000, "问题不能超过 2000 字"),
  conversationId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u, "conversationId 无效"),
});

type MiniExperienceAdoption = NonNullable<Awaited<ReturnType<typeof getClawByAdoptId>>>;

const provisioning = new Map<string, Promise<MiniExperienceAdoption>>();

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

function isExperienceRequestAuthorized(req: Request): boolean {
  const token = experienceToken();
  return token.length >= 32 && isAuthorizedInternalRequest(req, token);
}

function expiresAt(): Date {
  return new Date(Date.now() + MINI_EXPERIENCE_TTL_DAYS * 24 * 60 * 60 * 1000);
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

async function proxyRestrictedChat(
  req: Request,
  res: Response,
  adoption: MiniExperienceAdoption,
  input: z.infer<typeof MiniExperienceInput>,
): Promise<void> {
  const internalKey = String(process.env.INTERNAL_API_KEY || "").trim();
  if (internalKey.length < 16) throw new Error("INTERNAL_API_KEY 未配置");

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
        experienceMode: "mini_trial",
        selectedSkillIds: [],
        knowledgeBaseIds: [],
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
  app.post("/api/internal/miniprogram/experience/chat", async (req, res) => {
    if (!isExperienceRequestAuthorized(req)) {
      res.status(experienceToken() ? 401 : 503).json({ error: "轻体验服务未配置" });
      return;
    }

    try {
      const input = MiniExperienceInput.parse(req.body);
      const adoption = await ensureMiniExperienceAdoption(input.subject);
      await proxyRestrictedChat(req, res, adoption, input);
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
