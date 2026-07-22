import { createHash } from "crypto";
import type { Express, Request, Response } from "express";
import { nanoid } from "nanoid";

import type { BusinessAgent } from "../../drizzle/schema";
import {
  createPersonalBusinessAgent,
  deletePersonalBusinessAgent,
  getPersonalBusinessAgent,
  listPersonalBusinessAgents,
  updatePersonalBusinessAgent,
  type BusinessAgentOwnerContext,
} from "../db/agents";
import { runA2AExpertTask, type A2AEndpointConfig } from "./a2a-expert-client";
import { auditRequest, recordAuditBestEffort } from "./audit-events";
import { requireClawOwner } from "./helpers";
import { strictLimiter } from "./security";
import { invalidateAgentHealthSnapshot } from "./agent-health";

export const MAX_PERSONAL_EXPERTS = 3;
const TEST_TICKET_TTL_MS = 5 * 60_000;
const PERSONAL_EXPERT_ID_RE = /^personal-[A-Za-z0-9_-]{12,32}$/;
const successfulTests = new Map<string, number>();

export type PersonalExpertAuthType = "none" | "bearer";
export type PersonalExpertInteractionMode = "single" | "session";

type OwnerContext = BusinessAgentOwnerContext & { claw: any };

type PersonalExpertConfig = {
  name: string;
  description: string;
  endpointUrl: string;
  endpointDigest: string;
  authType: PersonalExpertAuthType;
  interactionMode: PersonalExpertInteractionMode;
  credential: string;
  endpointConfig: A2AEndpointConfig & {
    authType: PersonalExpertAuthType;
    interactionMode: PersonalExpertInteractionMode;
  };
};

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error || "专家连接失败")).slice(0, 1_000);
}

function parseJsonRecord(raw: unknown): Record<string, any> {
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeName(raw: unknown): string {
  const value = String(raw || "").trim();
  if (value.length < 2 || value.length > 128) throw new Error("专家名称应为 2 至 128 个字符");
  return value;
}

function normalizeDescription(raw: unknown): string {
  const value = String(raw || "").trim();
  if (value.length > 1_000) throw new Error("专家说明不能超过 1000 个字符");
  return value;
}

function normalizeAuthType(raw: unknown): PersonalExpertAuthType {
  const value = String(raw || "none").trim();
  if (value === "none" || value === "bearer") return value;
  throw new Error("不支持的认证方式");
}

function normalizeInteractionMode(raw: unknown): PersonalExpertInteractionMode {
  return String(raw || "single").trim() === "session" ? "session" : "single";
}

export function parsePersonalExpertEndpoint(raw: unknown): URL {
  const value = String(raw || "").trim();
  if (!value || value.length > 512) throw new Error("A2A 地址无效");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("A2A 地址无效");
  }
  if (url.protocol !== "https:") throw new Error("个人专家必须使用公网 HTTPS 地址");
  if (url.username || url.password) throw new Error("请在认证配置中填写凭据");
  if (!url.hostname) throw new Error("A2A 地址缺少主机名");
  for (const key of url.searchParams.keys()) {
    if (/token|secret|password|api[-_]?key|access[-_]?key/i.test(key)) {
      throw new Error("A2A 地址不能包含明文凭据，请使用认证配置");
    }
  }
  url.hash = "";
  return url;
}

function endpointDigest(endpointUrl: string): string {
  return createHash("sha256").update(endpointUrl).digest("hex");
}

export function buildPersonalExpertRuntimeConfig(
  authType: PersonalExpertAuthType,
  interactionMode: PersonalExpertInteractionMode = "single",
): PersonalExpertConfig["endpointConfig"] {
  return {
    stream: false,
    method: "message/send",
    timeoutMs: 5 * 60_000,
    executionMode: "async",
    maxConcurrent: 1,
    authType,
    interactionMode,
  };
}

function existingAuthType(existing?: BusinessAgent): PersonalExpertAuthType {
  if (!existing) return "none";
  const configured = parseJsonRecord(existing.endpointConfigJson).authType;
  return configured === "bearer" || existing.apiToken ? "bearer" : "none";
}

function normalizeConfig(body: any, existing?: BusinessAgent): PersonalExpertConfig {
  const name = normalizeName(body?.name ?? existing?.name);
  const description = normalizeDescription(body?.description ?? existing?.description);
  const endpoint = parsePersonalExpertEndpoint(body?.endpointUrl ?? existing?.apiUrl);
  const endpointUrl = endpoint.toString();
  const authType = normalizeAuthType(body?.authType ?? existingAuthType(existing));
  const existingInteractionMode = parseJsonRecord(existing?.endpointConfigJson).interactionMode;
  const interactionMode = normalizeInteractionMode(body?.interactionMode ?? existingInteractionMode);
  const suppliedCredential = typeof body?.credential === "string" ? body.credential.trim() : "";
  const credential = authType === "none" ? "" : suppliedCredential || String(existing?.apiToken || "").trim();
  if (authType === "bearer" && !credential) throw new Error("请填写 Bearer Token");
  return {
    name,
    description,
    endpointUrl,
    endpointDigest: endpointDigest(endpointUrl),
    authType,
    interactionMode,
    credential,
    endpointConfig: buildPersonalExpertRuntimeConfig(authType, interactionMode),
  };
}

export function personalExpertConnectionFingerprint(
  context: BusinessAgentOwnerContext,
  config: Pick<PersonalExpertConfig, "endpointUrl" | "authType" | "credential">,
): string {
  return createHash("sha256")
    .update(`${context.userId}\0${context.adoptId}\0${config.endpointUrl}\0${config.authType}\0${config.credential}`)
    .digest("hex");
}

export function isStandardA2AResponseEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const result = (event as any).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  if (result.kind === "message") {
    return typeof result.messageId === "string"
      && (result.role === "agent" || result.role === "assistant")
      && Array.isArray(result.parts);
  }
  if (result.kind === "task") {
    return typeof result.id === "string"
      && result.status
      && typeof result.status === "object";
  }
  return false;
}

function rememberSuccessfulTest(context: BusinessAgentOwnerContext, config: PersonalExpertConfig): void {
  const now = Date.now();
  for (const [key, expiresAt] of successfulTests) {
    if (expiresAt <= now) successfulTests.delete(key);
  }
  successfulTests.set(personalExpertConnectionFingerprint(context, config), now + TEST_TICKET_TTL_MS);
}

function hasSuccessfulTest(context: BusinessAgentOwnerContext, config: PersonalExpertConfig): boolean {
  const key = personalExpertConnectionFingerprint(context, config);
  const expiresAt = successfulTests.get(key) || 0;
  if (expiresAt <= Date.now()) {
    successfulTests.delete(key);
    return false;
  }
  return true;
}

function connectionChanged(existing: BusinessAgent, config: PersonalExpertConfig): boolean {
  return personalExpertConnectionFingerprint(
    { userId: Number(existing.ownerUserId || 0), adoptId: String(existing.ownerAdoptId || "") },
    {
      endpointUrl: String(existing.apiUrl || ""),
      authType: existingAuthType(existing),
      credential: String(existing.apiToken || ""),
    },
  ) !== personalExpertConnectionFingerprint(
    { userId: Number(existing.ownerUserId || 0), adoptId: String(existing.ownerAdoptId || "") },
    config,
  );
}

async function owner(req: Request, res: Response, rawAdoptId: unknown): Promise<OwnerContext | null> {
  const adoptId = String(rawAdoptId || "").trim();
  if (!adoptId) {
    res.status(400).json({ error: "adoptId required" });
    return null;
  }
  const claw = await requireClawOwner(req, res, adoptId);
  if (!claw) return null;
  return { userId: Number((claw as any).userId || 0), adoptId, claw };
}

function personalExpertId(raw: unknown): string {
  const value = String(raw || "").trim();
  if (!PERSONAL_EXPERT_ID_RE.test(value)) throw new Error("专家 ID 无效");
  return value;
}

function publicPersonalExpert(agent: BusinessAgent) {
  const endpointConfig = parseJsonRecord(agent.endpointConfigJson);
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description || "",
    endpointUrl: agent.apiUrl || "",
    authType: existingAuthType(agent),
    credentialConfigured: Boolean(agent.apiToken),
    enabled: Number(agent.enabled) === 1,
    healthStatus: agent.healthStatus || "unknown",
    lastError: null,
    lastHealthCheck: agent.lastHealthCheck || null,
    executionMode: endpointConfig.executionMode || "async",
    interactionMode: normalizeInteractionMode(endpointConfig.interactionMode),
  };
}

async function probeConnection(config: PersonalExpertConfig): Promise<number> {
  const startedAt = Date.now();
  const result = await runA2AExpertTask({
    apiUrl: config.endpointUrl,
    apiToken: config.credential || null,
    endpointConfig: { ...config.endpointConfig, timeoutMs: 45_000 },
  }, "连接测试：请仅回复“连接成功”，不要执行其他操作。");
  if (!result.rawEvents.some(isStandardA2AResponseEvent)) {
    throw new Error("目标地址没有返回标准 A2A 响应");
  }
  if (!String(result.text || "").trim()) throw new Error("A2A 专家未返回可识别结果");
  return Date.now() - startedAt;
}

async function recordPersonalExpertAudit(
  req: Request,
  context: OwnerContext,
  action: string,
  result: "success" | "failed",
  targetId: string,
  targetName: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await recordAuditBestEffort({
    action,
    actorType: "user",
    actorUserId: context.userId,
    result,
    severity: result === "success" ? "info" : "low",
    targetType: "expert_agent",
    targetId,
    targetName,
    agentInstanceId: context.adoptId,
    ...auditRequest(req),
    metadata,
  });
}

export function registerPersonalExpertRoutes(app: Express): void {
  app.get("/api/claw/personal-experts", async (req, res) => {
    try {
      const context = await owner(req, res, req.query.adoptId);
      if (!context) return;
      const rows = await listPersonalBusinessAgents(context);
      res.json({ items: rows.map(publicPersonalExpert), limits: { experts: MAX_PERSONAL_EXPERTS } });
    } catch (error) {
      res.status(500).json({ error: cleanError(error) });
    }
  });

  app.post("/api/claw/personal-experts/test", strictLimiter, async (req, res) => {
    const context = await owner(req, res, req.body?.adoptId);
    if (!context) return;
    const rawId = String(req.body?.expertId || "").trim();
    let existing: BusinessAgent | undefined;
    try {
      existing = rawId ? await getPersonalBusinessAgent(personalExpertId(rawId), context) : undefined;
      if (rawId && !existing) return res.status(404).json({ error: "专家不存在" });
      const config = normalizeConfig(req.body, existing);
      const testsSavedConnection = !existing || !connectionChanged(existing, config);
      const latencyMs = await probeConnection(config);
      rememberSuccessfulTest(context, config);
      if (existing && testsSavedConnection) {
        invalidateAgentHealthSnapshot(existing.id);
        await updatePersonalBusinessAgent(existing.id, context, {
          healthStatus: "healthy",
          lastHealthCheck: new Date(),
        });
      }
      await recordPersonalExpertAudit(req, context, "agent.personal_expert.tested", "success", existing?.id || "new", config.name, { latencyMs });
      res.json({ ok: true, latencyMs });
    } catch (error) {
      const message = cleanError(error);
      let testsSavedConnection = false;
      if (existing) {
        try {
          testsSavedConnection = !connectionChanged(existing, normalizeConfig(req.body, existing));
        } catch {}
      }
      if (existing && testsSavedConnection) {
        invalidateAgentHealthSnapshot(existing.id);
        await updatePersonalBusinessAgent(existing.id, context, {
          healthStatus: "offline",
          lastHealthCheck: new Date(),
        }).catch(() => undefined);
      }
      await recordPersonalExpertAudit(req, context, "agent.personal_expert.tested", "failed", existing?.id || "new", existing?.name || "个人专家", { error: message });
      res.status(400).json({ error: message });
    }
  });

  app.post("/api/claw/personal-experts", strictLimiter, async (req, res) => {
    const context = await owner(req, res, req.body?.adoptId);
    if (!context) return;
    try {
      const rows = await listPersonalBusinessAgents(context);
      if (rows.length >= MAX_PERSONAL_EXPERTS) {
        return res.status(409).json({ error: `每个岗位智能体最多添加 ${MAX_PERSONAL_EXPERTS} 个个人专家` });
      }
      const config = normalizeConfig(req.body);
      if (!hasSuccessfulTest(context, config)) return res.status(409).json({ error: "请先测试连接" });
      const id = `personal-${nanoid(20)}`;
      await createPersonalBusinessAgent({
        id,
        name: config.name,
        description: config.description,
        kind: "remote",
        visibility: "personal",
        ownerUserId: context.userId,
        ownerAdoptId: context.adoptId,
        apiUrl: config.endpointUrl,
        endpointDigest: config.endpointDigest,
        apiToken: config.credential || null,
        remoteAgentId: "main",
        icon: "E",
        enabled: 1,
        sortOrder: 1000,
        maxDailyRequests: 0,
        healthStatus: "healthy",
        lastHealthCheck: new Date(),
        allowedProfiles: "plus,internal",
        tags: "个人专家,A2A",
        uiConfig: JSON.stringify({ badge: "我的", displayMode: "agent-task", resultFormat: "markdown" }),
        providerType: "a2a",
        adapterProtocol: "a2a-v1",
        capabilitiesJson: JSON.stringify(["agent", "async-agent", "a2a"]),
        endpointConfigJson: JSON.stringify(config.endpointConfig),
      });
      const created = await getPersonalBusinessAgent(id, context);
      await recordPersonalExpertAudit(req, context, "agent.personal_expert.created", "success", id, config.name);
      res.status(201).json({ item: created ? publicPersonalExpert(created) : null });
    } catch (error: any) {
      const duplicate = error?.code === "ER_DUP_ENTRY";
      res.status(duplicate ? 409 : 400).json({ error: duplicate ? "该 A2A 地址已添加" : cleanError(error) });
    }
  });

  app.post("/api/claw/personal-experts/:id", strictLimiter, async (req, res) => {
    const context = await owner(req, res, req.body?.adoptId);
    if (!context) return;
    try {
      const id = personalExpertId(req.params.id);
      const existing = await getPersonalBusinessAgent(id, context);
      if (!existing) return res.status(404).json({ error: "专家不存在" });
      const config = normalizeConfig(req.body, existing);
      const changed = connectionChanged(existing, config);
      if (changed && !hasSuccessfulTest(context, config)) return res.status(409).json({ error: "连接信息已变化，请重新测试" });
      const suppliedCredential = typeof req.body?.credential === "string" && req.body.credential.trim();
      const updated = await updatePersonalBusinessAgent(id, context, {
        name: config.name,
        description: config.description,
        apiUrl: config.endpointUrl,
        endpointDigest: config.endpointDigest,
        ...(config.authType === "none" ? { apiToken: null } : suppliedCredential ? { apiToken: config.credential } : {}),
        endpointConfigJson: JSON.stringify(config.endpointConfig),
        ...(changed ? { healthStatus: "healthy", lastHealthCheck: new Date() } : {}),
      });
      await recordPersonalExpertAudit(req, context, "agent.personal_expert.updated", "success", id, config.name, { connectionChanged: changed });
      res.json({ item: updated ? publicPersonalExpert(updated) : null });
    } catch (error: any) {
      const duplicate = error?.code === "ER_DUP_ENTRY";
      res.status(duplicate ? 409 : 400).json({ error: duplicate ? "该 A2A 地址已添加" : cleanError(error) });
    }
  });

  app.post("/api/claw/personal-experts/:id/toggle", strictLimiter, async (req, res) => {
    const context = await owner(req, res, req.body?.adoptId);
    if (!context) return;
    try {
      const id = personalExpertId(req.params.id);
      const existing = await getPersonalBusinessAgent(id, context);
      if (!existing) return res.status(404).json({ error: "专家不存在" });
      const enabled = req.body?.enabled === true;
      const updated = await updatePersonalBusinessAgent(id, context, { enabled: enabled ? 1 : 0 });
      await recordPersonalExpertAudit(req, context, enabled ? "agent.personal_expert.enabled" : "agent.personal_expert.disabled", "success", id, existing.name);
      res.json({ item: updated ? publicPersonalExpert(updated) : null });
    } catch (error) {
      res.status(400).json({ error: cleanError(error) });
    }
  });

  app.post("/api/claw/personal-experts/:id/retest", strictLimiter, async (req, res) => {
    const context = await owner(req, res, req.body?.adoptId);
    if (!context) return;
    let existing: BusinessAgent | undefined;
    try {
      const id = personalExpertId(req.params.id);
      existing = await getPersonalBusinessAgent(id, context);
      if (!existing) return res.status(404).json({ error: "专家不存在" });
      const config = normalizeConfig({}, existing);
      const latencyMs = await probeConnection(config);
      rememberSuccessfulTest(context, config);
      invalidateAgentHealthSnapshot(existing.id);
      const updated = await updatePersonalBusinessAgent(id, context, {
        healthStatus: "healthy",
        lastHealthCheck: new Date(),
      });
      await recordPersonalExpertAudit(req, context, "agent.personal_expert.tested", "success", id, existing.name, { latencyMs });
      res.json({ item: updated ? publicPersonalExpert(updated) : null, latencyMs });
    } catch (error) {
      const message = cleanError(error);
      if (existing) {
        invalidateAgentHealthSnapshot(existing.id);
        await updatePersonalBusinessAgent(existing.id, context, {
          healthStatus: "offline",
          lastHealthCheck: new Date(),
        }).catch(() => undefined);
        await recordPersonalExpertAudit(req, context, "agent.personal_expert.tested", "failed", existing.id, existing.name, { error: message });
      }
      res.status(400).json({ error: message });
    }
  });

  app.delete("/api/claw/personal-experts/:id", strictLimiter, async (req, res) => {
    const context = await owner(req, res, req.query.adoptId);
    if (!context) return;
    try {
      const id = personalExpertId(req.params.id);
      const existing = await getPersonalBusinessAgent(id, context);
      if (!existing) return res.status(404).json({ error: "专家不存在" });
      await deletePersonalBusinessAgent(id, context);
      await recordPersonalExpertAudit(req, context, "agent.personal_expert.deleted", "success", id, existing.name);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: cleanError(error) });
    }
  });
}
