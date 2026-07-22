import type { Express, Request, Response } from "express";
import {
  createCustomMcpConnection,
  deleteCustomMcpConnection,
  getClawByAdoptId,
  getClawByAgentId,
  getCustomMcpConnection,
  listCustomMcpConnections,
  revealCustomMcpOAuthData,
  resolveEffectiveRoleAssets,
  revealCustomMcpCredential,
  toPublicCustomMcpConnection,
  updateCustomMcpConnection,
  type CustomMcpAuthType,
  type CustomMcpToolSnapshot,
} from "../db";
import {
  callCustomMcpTool,
  customMcpGatewayToolName,
  discoverCustomMcpTools,
  MAX_CUSTOM_MCP_CONNECTIONS,
  MAX_CUSTOM_MCP_SELECTED_TOOLS,
  parseCustomMcpEndpoint,
  validateCustomMcpAuth,
  type CustomMcpEndpointConfig,
} from "./custom-mcp-client";
import {
  bumpSessionEpoch,
  isAuthorizedInternalRequest,
  isJiuwenClawAdoptId,
  requireClawOwner,
  resolveRequesterUserId,
  resolveRuntimeAgentId,
} from "./helpers";
import { auditRequest, recordAuditBestEffort } from "./audit-events";
import { strictLimiter } from "./security";
import { getRoleRuntimeAdapter } from "../routers/role-runtime-adapters";
import { resolveAgentRoleTemplate } from "./role-templates";
import { finishCustomMcpOAuth, startCustomMcpOAuth } from "./custom-mcp-oauth";
import { resolvePublicBaseUrl } from "./public-base-url";

const SERVICE_NAME = "custom-mcp-gateway";
const SERVICE_VERSION = "1.0.0";
const CUSTOM_SERVER_ID_RE = /^custom_user_(\d+)$/;
const activeCalls = new Map<string, number>();

function ok(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function err(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function hasRequestId(id: unknown): boolean {
  return id !== undefined && id !== null;
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error || "连接失败")).slice(0, 1_000);
}

function displayName(raw: unknown): string {
  const value = String(raw || "").trim();
  if (value.length < 2 || value.length > 128) throw new Error("连接名称应为 2 至 128 个字符");
  return value;
}

function authType(raw: unknown): CustomMcpAuthType {
  const value = String(raw || "none").trim();
  if (value === "none" || value === "bearer" || value === "api_key" || value === "oauth") return value;
  throw new Error("不支持的认证方式");
}

function selectedTools(raw: unknown, tools: CustomMcpToolSnapshot[]): string[] {
  const available = new Set(tools.map((tool) => tool.name));
  const requested = Array.isArray(raw)
    ? raw.map((value) => String(value || "").trim()).filter(Boolean)
    : tools.slice(0, MAX_CUSTOM_MCP_SELECTED_TOOLS).map((tool) => tool.name);
  const selected = Array.from(new Set(requested));
  if (selected.length === 0) throw new Error("请至少选择一个工具");
  if (selected.length > MAX_CUSTOM_MCP_SELECTED_TOOLS) {
    throw new Error(`每个连接最多启用 ${MAX_CUSTOM_MCP_SELECTED_TOOLS} 个工具`);
  }
  if (selected.some((name) => !available.has(name))) throw new Error("选择的工具不在远程 MCP 列表中");
  return selected;
}

function configFromRow(row: Awaited<ReturnType<typeof getCustomMcpConnection>> & {}): CustomMcpEndpointConfig {
  const oauthData = row.authType === "oauth" ? revealCustomMcpOAuthData(row) : null;
  return {
    endpointUrl: row.endpointUrl,
    authType: row.authType,
    authHeaderName: row.authHeaderName,
    credential: revealCustomMcpCredential(row),
    oauthData,
    onOAuthDataChanged: row.authType === "oauth"
      ? async (next) => { await updateCustomMcpConnection({ id: row.id, adoptId: row.adoptId, userId: row.userId }, { oauthData: next }); }
      : undefined,
  };
}

async function owner(req: Request, res: Response, adoptIdRaw: unknown) {
  const adoptId = String(adoptIdRaw || "").trim();
  if (!adoptId) {
    res.status(400).json({ error: "adoptId required" });
    return null;
  }
  const claw = await requireClawOwner(req, res, adoptId);
  if (!claw) return null;
  if (!isJiuwenClawAdoptId(adoptId)) {
    res.status(409).json({ error: "自定义 MCP 仅支持 JiuwenSwarm 运行时" });
    return null;
  }
  return { adoptId, claw, userId: Number((claw as any).userId || 0) };
}

async function ensureCustomMcpGateway(context: NonNullable<Awaited<ReturnType<typeof owner>>>): Promise<void> {
  const role = resolveAgentRoleTemplate(String((context.claw as any).roleTemplate || "general-assistant"));
  const effectiveAssets = await resolveEffectiveRoleAssets(role.id);
  const runtimeAgentId = resolveRuntimeAgentId(context.adoptId, String((context.claw as any).agentId || ""));
  const result = await getRoleRuntimeAdapter("jiuwenswarm").reconcileMcp({
    adoptId: context.adoptId,
    agentId: runtimeAgentId,
    role,
    effectiveAssets,
  });
  if (!result.ok) throw new Error(result.reason || "自定义 MCP 网关配置失败");
}

function mergeEndpointConfig(body: any, existing?: NonNullable<Awaited<ReturnType<typeof getCustomMcpConnection>>>): CustomMcpEndpointConfig {
  const nextAuthType = authType(body?.authType ?? existing?.authType ?? "none");
  if (nextAuthType === "oauth") throw new Error("OAuth 连接请从连接器市场发起授权");
  const suppliedCredential = typeof body?.credential === "string" ? body.credential.trim() : undefined;
  const credential = nextAuthType === "none"
    ? ""
    : suppliedCredential !== undefined && suppliedCredential !== ""
      ? suppliedCredential
      : existing && existing.authType === nextAuthType
        ? revealCustomMcpCredential(existing)
        : "";
  const config = {
    endpointUrl: parseCustomMcpEndpoint(body?.endpointUrl ?? existing?.endpointUrl).toString(),
    authType: nextAuthType,
    authHeaderName: nextAuthType === "api_key"
      ? String(body?.authHeaderName ?? existing?.authHeaderName ?? "X-API-Key").trim()
      : null,
    credential,
  } satisfies CustomMcpEndpointConfig;
  validateCustomMcpAuth(config);
  return config;
}

async function trustedAdoptId(req: Request): Promise<string> {
  const directHeaders = ["x-jiuwen-channel-id", "x-agent-adopt-id", "x-workforce-agent-adopt-id"];
  for (const name of directHeaders) {
    const value = String(req.headers[name] || "").trim();
    if (/^lgj-[A-Za-z0-9_-]{3,60}$/.test(value)) return value;
  }
  const runtimeAgentId = String(req.headers["x-linggan-agent-id"] || "").trim();
  if (runtimeAgentId) {
    const claw = await getClawByAgentId(runtimeAgentId).catch(() => null);
    if (claw?.adoptId) return String(claw.adoptId);
  }
  return "";
}

function toolsForRow(row: NonNullable<Awaited<ReturnType<typeof getCustomMcpConnection>>>): CustomMcpToolSnapshot[] {
  const tools = Array.isArray(row.toolsJson) ? row.toolsJson as CustomMcpToolSnapshot[] : [];
  const selected = new Set(Array.isArray(row.selectedToolNames) ? row.selectedToolNames : []);
  return tools.filter((tool) => selected.has(tool.name)).slice(0, MAX_CUSTOM_MCP_SELECTED_TOOLS);
}

export function customMcpServerId(connectionId: number): string {
  return `custom_user_${connectionId}`;
}

export function parseCustomMcpServerId(serverId: string): number | null {
  const match = String(serverId || "").match(CUSTOM_SERVER_ID_RE);
  return match ? Number(match[1]) || null : null;
}

export async function buildCustomMcpStatusGroup(adoptId: string, userId: number): Promise<any | null> {
  const rows = await listCustomMcpConnections({ adoptId, userId });
  if (rows.length === 0) return null;
  const children = rows.map((row) => {
    const tools = toolsForRow(row);
    const ready = row.healthStatus === "ready";
    return {
      id: customMcpServerId(row.id),
      name: row.displayName,
      description: new URL(row.endpointUrl).hostname,
      serverId: customMcpServerId(row.id),
      configured: true,
      enabled: row.enabled,
      status: ready ? "available" : "disabled",
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description || "自定义 MCP 工具", source: "live" })),
      toolSource: "live",
      liveStatus: ready ? "live" : "unavailable",
      liveCheckedAt: row.lastTestedAt?.toISOString() || null,
      liveError: row.lastError || null,
      enabledForAgent: row.enabled,
      grantMode: "optional",
      catalogId: row.catalogId || null,
    };
  });
  const availableCount = children.filter((child) => child.enabledForAgent && child.status === "available").length;
  return {
    id: "custom-user-mcp",
    name: "自定义 MCP",
    category: "个人连接",
    description: "当前岗位智能体自行添加的业务连接",
    status: availableCount > 0 ? "available" : "disabled",
    availableCount,
    configuredCount: children.length,
    serverCount: children.length,
    activeCount: children.filter((child) => child.enabledForAgent).length,
    children,
    liveStatus: children.every((child) => child.liveStatus === "live") ? "live" : "unavailable",
  };
}

export async function toggleCustomMcpConnection(input: {
  id: number;
  adoptId: string;
  userId: number;
  enabled: boolean;
}): Promise<{ changed: boolean; sessionEpoch: number }> {
  const row = await getCustomMcpConnection(input);
  if (!row) {
    const error = new Error("自定义连接不存在");
    (error as any).statusCode = 404;
    throw error;
  }
  if (row.enabled === input.enabled) return { changed: false, sessionEpoch: 0 };
  if (input.enabled && (row.healthStatus !== "ready" || toolsForRow(row).length === 0)) {
    const error = new Error("连接尚未通过测试，不能启用");
    (error as any).statusCode = 409;
    throw error;
  }
  await updateCustomMcpConnection(input, { enabled: input.enabled });
  return { changed: true, sessionEpoch: bumpSessionEpoch(input.adoptId) };
}

async function gatewayTools(adoptId: string) {
  const rows = await listCustomMcpConnections({ adoptId, enabledOnly: true });
  return rows.filter((row) => row.healthStatus === "ready").flatMap((row) => toolsForRow(row).map((tool) => ({
    name: customMcpGatewayToolName(row.id, tool.name),
    description: `[${row.displayName}] ${tool.description || tool.name}`.slice(0, 2_000),
    inputSchema: tool.inputSchema || { type: "object", properties: {} },
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  })));
}

async function gatewayCall(adoptId: string, exposedName: string, args: Record<string, unknown>, req: Request) {
  if (Buffer.byteLength(JSON.stringify(args)) > 512 * 1024) {
    return textResult("工具参数超过 512KB，请缩小输入范围。", true);
  }
  const current = activeCalls.get(adoptId) || 0;
  if (current >= 4) return textResult("当前自定义连接调用较多，请稍后重试。", true);
  activeCalls.set(adoptId, current + 1);
  const startedAt = Date.now();
  try {
    const rows = await listCustomMcpConnections({ adoptId, enabledOnly: true });
    for (const row of rows) {
      if (row.healthStatus !== "ready") continue;
      const tool = toolsForRow(row).find((item) => customMcpGatewayToolName(row.id, item.name) === exposedName);
      if (!tool) continue;
      try {
        const result = await callCustomMcpTool(configFromRow(row), tool.name, args);
        await recordAuditBestEffort({
          action: "agent.custom_mcp.called",
          result: "success",
          severity: "info",
          actorType: "agent",
          targetType: "mcp_server",
          targetId: String(row.id),
          targetName: row.displayName,
          agentInstanceId: adoptId,
          toolName: tool.name,
          source: "custom_mcp_gateway",
          ...auditRequest(req),
          metadata: { durationMs: Date.now() - startedAt },
        });
        return result;
      } catch (error) {
        await recordAuditBestEffort({
          action: "agent.custom_mcp.called",
          result: "failed",
          severity: "medium",
          actorType: "agent",
          targetType: "mcp_server",
          targetId: String(row.id),
          targetName: row.displayName,
          agentInstanceId: adoptId,
          toolName: tool.name,
          source: "custom_mcp_gateway",
          ...auditRequest(req),
          metadata: { error: cleanError(error), durationMs: Date.now() - startedAt },
        });
        return textResult(`连接调用失败：${cleanError(error)}`, true);
      }
    }
    return textResult("该工具已停用或不属于当前岗位智能体。", true);
  } finally {
    const next = (activeCalls.get(adoptId) || 1) - 1;
    if (next <= 0) activeCalls.delete(adoptId);
    else activeCalls.set(adoptId, next);
  }
}

async function handleGatewayMessage(req: Request, message: any) {
  if (!message || typeof message !== "object") return null;
  const id = message.id;
  if (message.method === "notifications/initialized") return null;
  if (message.method === "initialize") {
    return hasRequestId(id) ? ok(id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVICE_NAME, version: SERVICE_VERSION },
      instructions: "User-managed MCP tools scoped to the current EA employee agent.",
    }) : null;
  }
  if (message.method === "ping") return hasRequestId(id) ? ok(id, {}) : null;
  if (message.method === "resources/list") return hasRequestId(id) ? ok(id, { resources: [] }) : null;
  if (message.method === "prompts/list") return hasRequestId(id) ? ok(id, { prompts: [] }) : null;

  const adoptId = await trustedAdoptId(req);
  if (!adoptId) return hasRequestId(id) ? err(id, -32001, "trusted Agent identity is missing") : null;
  const claw = await getClawByAdoptId(adoptId).catch(() => null);
  if (!claw || !["active", "expiring"].includes(String(claw.status || ""))) {
    return hasRequestId(id) ? err(id, -32003, "Agent is not active") : null;
  }
  if (message.method === "tools/list") return hasRequestId(id) ? ok(id, { tools: await gatewayTools(adoptId) }) : null;
  if (message.method === "tools/call") {
    if (!hasRequestId(id)) return null;
    const result = await gatewayCall(
      adoptId,
      String(message.params?.name || ""),
      message.params?.arguments && typeof message.params.arguments === "object" ? message.params.arguments : {},
      req,
    );
    return ok(id, result);
  }
  return hasRequestId(id) ? err(id, -32601, `Method not found: ${message.method}`) : null;
}

export function registerCustomMcpRoutes(app: Express): void {
  app.post("/api/claw/custom-mcp/oauth/start", strictLimiter, async (req, res) => {
    try {
      const context = await owner(req, res, req.body?.adoptId);
      if (!context) return;
      const existing = await listCustomMcpConnections(context);
      const catalogId = String(req.body?.catalogId || "").trim();
      const existingCatalogConnection = existing.find((row) => row.catalogId === catalogId);
      const alreadyConnected = Boolean(existingCatalogConnection);
      if (!alreadyConnected && existing.length >= MAX_CUSTOM_MCP_CONNECTIONS) {
        return res.status(409).json({ error: `每个岗位智能体最多添加 ${MAX_CUSTOM_MCP_CONNECTIONS} 个自定义连接` });
      }
      const configuredBase = resolvePublicBaseUrl();
      const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
      const requestBase = `${forwardedProto === "https" ? "https" : req.protocol}://${req.get("host")}`;
      const externalBase = configuredBase.startsWith("https://") ? configuredBase : requestBase;
      const redirectUrl = new URL("/api/claw/custom-mcp/oauth/callback", externalBase).toString();
      const result = await startCustomMcpOAuth({
        userId: context.userId,
        adoptId: context.adoptId,
        catalogId,
        redirectUrl,
        oauthData: existingCatalogConnection ? revealCustomMcpOAuthData(existingCatalogConnection) : null,
      });
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: cleanError(error) });
    }
  });

  app.get("/api/claw/custom-mcp/oauth/callback", async (req, res) => {
    const configuredBase = resolvePublicBaseUrl();
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const requestBase = `${forwardedProto === "https" ? "https" : req.protocol}://${req.get("host")}`;
    const completeUrl = new URL("/mcp-oauth-callback.html", configuredBase.startsWith("https://") ? configuredBase : requestBase);
    const fail = (message: string, status = 400) => {
      completeUrl.searchParams.set("status", "error");
      completeUrl.searchParams.set("message", message);
      return res.redirect(status === 401 ? 302 : 303, completeUrl.toString());
    };
    try {
      const state = String(req.query.state || "").trim();
      const code = String(req.query.code || "").trim();
      if (req.query.error) return fail("授权已取消或被拒绝");
      if (!state || !code) return fail("授权回调缺少必要参数");
      const userId = await resolveRequesterUserId(req, res);
      if (!userId) return fail("登录状态已失效，请重新登录后连接", 401);
      const result = await finishCustomMcpOAuth({ state, code, userId });
      const claw = await getClawByAdoptId(result.adoptId);
      if (!claw || Number((claw as any).userId || 0) !== userId) return fail("无权为该岗位智能体授权");
      const context = { adoptId: result.adoptId, userId, claw };
      const rows = await listCustomMcpConnections(context);
      const existing = rows.find((row) => row.catalogId === result.catalog.id || row.endpointUrl === result.catalog.endpointUrl);
      const previousSelected = new Set(Array.isArray(existing?.selectedToolNames) ? existing.selectedToolNames : []);
      const retained = result.tools.filter((tool) => previousSelected.has(tool.name)).map((tool) => tool.name);
      const selectedToolNames = (retained.length > 0 ? retained : result.tools.map((tool) => tool.name)).slice(0, MAX_CUSTOM_MCP_SELECTED_TOOLS);
      await ensureCustomMcpGateway(context);
      const row = existing
        ? await updateCustomMcpConnection({ id: existing.id, adoptId: context.adoptId, userId }, {
          displayName: result.catalog.displayName,
          endpointUrl: result.catalog.endpointUrl,
          authType: "oauth",
          authHeaderName: null,
          credential: null,
          catalogId: result.catalog.id,
          oauthData: result.oauthData,
          enabled: true,
          healthStatus: "ready",
          lastError: null,
          toolsJson: result.tools,
          selectedToolNames,
          lastTestedAt: new Date(),
        })
        : await createCustomMcpConnection({
          userId,
          adoptId: context.adoptId,
          displayName: result.catalog.displayName,
          endpointUrl: result.catalog.endpointUrl,
          authType: "oauth",
          authHeaderName: null,
          catalogId: result.catalog.id,
          oauthData: result.oauthData,
          enabled: true,
          healthStatus: "ready",
          lastError: null,
          toolsJson: result.tools,
          selectedToolNames,
          lastTestedAt: new Date(),
        });
      if (!row) return fail("连接器保存失败");
      bumpSessionEpoch(context.adoptId);
      await recordAuditBestEffort({
        action: existing ? "agent.custom_mcp.oauth_refreshed" : "agent.custom_mcp.oauth_connected",
        actorType: "user",
        actorUserId: userId,
        result: "success",
        severity: "info",
        targetType: "mcp_server",
        targetId: String(row.id),
        targetName: row.displayName,
        agentInstanceId: context.adoptId,
        ...auditRequest(req),
        metadata: { catalogId: result.catalog.id, toolCount: selectedToolNames.length },
      });
      completeUrl.searchParams.set("status", "success");
      completeUrl.searchParams.set("message", `${result.catalog.displayName}已连接`);
      res.redirect(303, completeUrl.toString());
    } catch (error) {
      console.error("[CustomMCP OAuth] callback failed", error);
      return fail("授权失败，请返回后重试");
    }
  });

  app.get("/api/claw/custom-mcp/connections", async (req, res) => {
    try {
      const context = await owner(req, res, req.query.adoptId);
      if (!context) return;
      const rows = await listCustomMcpConnections(context);
      res.json({ items: rows.map(toPublicCustomMcpConnection), limits: { connections: MAX_CUSTOM_MCP_CONNECTIONS, toolsPerConnection: MAX_CUSTOM_MCP_SELECTED_TOOLS } });
    } catch (error) {
      res.status(500).json({ error: cleanError(error) });
    }
  });

  app.post("/api/claw/custom-mcp/test", strictLimiter, async (req, res) => {
    try {
      const context = await owner(req, res, req.body?.adoptId);
      if (!context) return;
      const connectionId = Number(req.body?.connectionId || 0);
      const existing = connectionId
        ? await getCustomMcpConnection({ id: connectionId, ...context })
        : undefined;
      if (connectionId && !existing) return res.status(404).json({ error: "连接不存在" });
      const config = mergeEndpointConfig(req.body, existing || undefined);
      const tools = await discoverCustomMcpTools(config);
      res.json({ ok: true, endpointUrl: config.endpointUrl, tools });
    } catch (error) {
      res.status(400).json({ error: cleanError(error) });
    }
  });

  app.post("/api/claw/custom-mcp/connections", strictLimiter, async (req, res) => {
    try {
      const context = await owner(req, res, req.body?.adoptId);
      if (!context) return;
      const existing = await listCustomMcpConnections(context);
      if (existing.length >= MAX_CUSTOM_MCP_CONNECTIONS) {
        return res.status(409).json({ error: `每个岗位智能体最多添加 ${MAX_CUSTOM_MCP_CONNECTIONS} 个自定义连接` });
      }
      const config = mergeEndpointConfig(req.body);
      const tools = await discoverCustomMcpTools(config);
      const selectedToolNames = selectedTools(req.body?.selectedToolNames, tools);
      await ensureCustomMcpGateway(context);
      const row = await createCustomMcpConnection({
        userId: context.userId,
        adoptId: context.adoptId,
        displayName: displayName(req.body?.displayName),
        endpointUrl: config.endpointUrl,
        authType: config.authType,
        authHeaderName: config.authHeaderName || null,
        credential: config.credential,
        enabled: true,
        healthStatus: "ready",
        lastError: null,
        toolsJson: tools,
        selectedToolNames,
        lastTestedAt: new Date(),
      });
      const sessionEpoch = bumpSessionEpoch(context.adoptId);
      await recordAuditBestEffort({
        action: "agent.custom_mcp.created",
        actorType: "user",
        actorUserId: context.userId,
        result: "success",
        severity: "info",
        targetType: "mcp_server",
        targetId: String(row.id),
        targetName: row.displayName,
        agentInstanceId: context.adoptId,
        ...auditRequest(req),
        metadata: { toolCount: selectedToolNames.length },
      });
      res.status(201).json({ item: toPublicCustomMcpConnection(row), sessionEpoch });
    } catch (error: any) {
      const duplicate = error?.code === "ER_DUP_ENTRY";
      res.status(duplicate ? 409 : 400).json({ error: duplicate ? "该 MCP 地址已添加" : cleanError(error) });
    }
  });

  app.post("/api/claw/custom-mcp/connections/:id", strictLimiter, async (req, res) => {
    try {
      const context = await owner(req, res, req.body?.adoptId);
      if (!context) return;
      const id = Number(req.params.id || 0);
      const existing = await getCustomMcpConnection({ id, ...context });
      if (!existing) return res.status(404).json({ error: "连接不存在" });
      const config = mergeEndpointConfig(req.body, existing);
      const tools = await discoverCustomMcpTools(config);
      const selectedToolNames = selectedTools(req.body?.selectedToolNames, tools);
      await ensureCustomMcpGateway(context);
      const row = await updateCustomMcpConnection({ id, ...context }, {
        displayName: displayName(req.body?.displayName ?? existing.displayName),
        endpointUrl: config.endpointUrl,
        authType: config.authType,
        authHeaderName: config.authHeaderName || null,
        ...(typeof req.body?.credential === "string" || config.authType === "none" ? { credential: config.credential } : {}),
        enabled: existing.enabled,
        healthStatus: "ready",
        lastError: null,
        toolsJson: tools,
        selectedToolNames,
        lastTestedAt: new Date(),
      });
      if (!row) return res.status(404).json({ error: "连接不存在" });
      const sessionEpoch = bumpSessionEpoch(context.adoptId);
      await recordAuditBestEffort({
        action: "agent.custom_mcp.updated",
        actorType: "user",
        actorUserId: context.userId,
        result: "success",
        severity: "info",
        targetType: "mcp_server",
        targetId: String(row.id),
        targetName: row.displayName,
        agentInstanceId: context.adoptId,
        ...auditRequest(req),
        metadata: { toolCount: selectedToolNames.length },
      });
      res.json({ item: toPublicCustomMcpConnection(row), sessionEpoch });
    } catch (error: any) {
      const duplicate = error?.code === "ER_DUP_ENTRY";
      res.status(duplicate ? 409 : 400).json({ error: duplicate ? "该 MCP 地址已添加" : cleanError(error) });
    }
  });

  app.post("/api/claw/custom-mcp/connections/:id/retest", strictLimiter, async (req, res) => {
    const context = await owner(req, res, req.body?.adoptId);
    if (!context) return;
    const id = Number(req.params.id || 0);
    const existing = await getCustomMcpConnection({ id, ...context });
    if (!existing) return res.status(404).json({ error: "连接不存在" });
    try {
      const tools = await discoverCustomMcpTools(configFromRow(existing));
      if (tools.length === 0) throw new Error("远程 MCP 未发现可用工具");
      const previous = new Set(Array.isArray(existing.selectedToolNames) ? existing.selectedToolNames : []);
      const retained = tools.filter((tool) => previous.has(tool.name)).map((tool) => tool.name);
      const selectedToolNames = retained.length > 0 ? retained.slice(0, MAX_CUSTOM_MCP_SELECTED_TOOLS) : tools.slice(0, MAX_CUSTOM_MCP_SELECTED_TOOLS).map((tool) => tool.name);
      const row = await updateCustomMcpConnection({ id, ...context }, {
        healthStatus: "ready",
        lastError: null,
        toolsJson: tools,
        selectedToolNames,
        lastTestedAt: new Date(),
      });
      bumpSessionEpoch(context.adoptId);
      await recordAuditBestEffort({
        action: "agent.custom_mcp.tested",
        actorType: "user",
        actorUserId: context.userId,
        result: "success",
        severity: "info",
        targetType: "mcp_server",
        targetId: String(id),
        targetName: existing.displayName,
        agentInstanceId: context.adoptId,
        ...auditRequest(req),
        metadata: { toolCount: selectedToolNames.length },
      });
      res.json({ item: row ? toPublicCustomMcpConnection(row) : null });
    } catch (error) {
      const message = cleanError(error);
      await updateCustomMcpConnection({ id, ...context }, {
        enabled: false,
        healthStatus: "error",
        lastError: message,
        lastTestedAt: new Date(),
      });
      bumpSessionEpoch(context.adoptId);
      res.status(400).json({ error: message });
    }
  });

  app.delete("/api/claw/custom-mcp/connections/:id", strictLimiter, async (req, res) => {
    try {
      const context = await owner(req, res, req.query.adoptId);
      if (!context) return;
      const id = Number(req.params.id || 0);
      const existing = await getCustomMcpConnection({ id, ...context });
      if (!existing) return res.status(404).json({ error: "连接不存在" });
      await deleteCustomMcpConnection({ id, ...context });
      const sessionEpoch = bumpSessionEpoch(context.adoptId);
      await recordAuditBestEffort({
        action: "agent.custom_mcp.deleted",
        actorType: "user",
        actorUserId: context.userId,
        result: "success",
        severity: "info",
        targetType: "mcp_server",
        targetId: String(id),
        targetName: existing.displayName,
        agentInstanceId: context.adoptId,
        ...auditRequest(req),
      });
      res.json({ ok: true, sessionEpoch });
    } catch (error) {
      res.status(500).json({ error: cleanError(error) });
    }
  });

  app.get("/api/internal/custom-mcp/mcp", async (req, res) => {
    if (!isAuthorizedInternalRequest(req)) return res.status(401).json(err(null, -32001, "unauthorized"));
    const adoptId = await trustedAdoptId(req);
    if (!adoptId) return res.status(400).json(err(null, -32001, "trusted Agent identity is missing"));
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Mcp-Session-Id", `custom-mcp-${adoptId}`);
    res.flushHeaders?.();
    res.write(": custom MCP stream ready\n\n");
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25_000);
    req.on("close", () => clearInterval(heartbeat));
  });

  app.delete("/api/internal/custom-mcp/mcp", (req, res) => {
    if (!isAuthorizedInternalRequest(req)) return res.status(401).json(err(null, -32001, "unauthorized"));
    res.status(204).end();
  });

  app.post("/api/internal/custom-mcp/mcp", async (req, res) => {
    if (!isAuthorizedInternalRequest(req)) return res.status(401).json(err(null, -32001, "unauthorized"));
    try {
      const body = req.body || {};
      const response = Array.isArray(body)
        ? (await Promise.all(body.map((item) => handleGatewayMessage(req, item)))).filter(Boolean)
        : await handleGatewayMessage(req, body);
      if (!response || (Array.isArray(response) && response.length === 0)) return res.status(202).json({});
      const adoptId = await trustedAdoptId(req);
      if (adoptId) res.setHeader("Mcp-Session-Id", `custom-mcp-${adoptId}`);
      res.json(response);
    } catch (error) {
      res.status(200).json(err(req.body?.id, -32000, cleanError(error)));
    }
  });
}
