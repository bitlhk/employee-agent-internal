import { createHash } from "node:crypto";
import type { Express, Request } from "express";
import type { CustomMcpToolSnapshot } from "../db/custom-mcp-connections";
import {
  getClawByAdoptId,
  getClawByAgentId,
  resolveEffectiveRoleAssets,
  resolvePersistedAgentMcpSelection,
} from "../db";
import { auditRequest, recordAuditBestEffort } from "./audit-events";
import { readOpenclawJson } from "./helpers";
import { authorizeAndBindInternalRuntimeRequest } from "./internal-runtime-request";
import { internalMcpAudience } from "./internal-runtime-token";
import { beginMcpCall } from "./observability/metrics";
import { guardToolEgress } from "./tool-egress-policy";
import { resolveCustomMcpToolGovernance } from "./governance/custom-mcp-policy";
import {
  callTrustedRuntimeMcpTool,
  discoverTrustedRuntimeMcpTools,
  type TrustedRuntimeMcpConfig,
} from "./trusted-runtime-mcp-client";

const SERVICE_NAME = "role-mcp-gateway";
const SERVICE_VERSION = "1.0.0";
const TOOL_CACHE_TTL_MS = 60_000;
const MAX_TOOLS = 128;
const MANAGED_SERVER_IDS = new Set([
  "platform_tools",
  "custom_mcp_gateway",
  "enterprise_mcp_gateway",
  "role_mcp_gateway",
]);
const SAFE_COMPUTE_NAME_RE = /(?:^|[_:.-])(?:parse|validate|schema|analy[sz]e|calculate|classif(?:y|ication)|convert|extract(?:or)?|generate|generator|locate|summari[sz]e)(?:$|[_:.-])/i;

type JsonRpcMessage = {
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown; arguments?: unknown };
};

type RuntimeContext = {
  adoptId: string;
  agentId: string;
  roleKey: string;
  userId: number;
  enabledServerIds: Set<string>;
};

type RoleMcpTool = {
  serverId: string;
  exposedName: string;
  tool: CustomMcpToolSnapshot;
  config: TrustedRuntimeMcpConfig;
};

type CachedTools = { expiresAt: number; tools: CustomMcpToolSnapshot[] };
const toolCache = new Map<string, CachedTools>();

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
  return (error instanceof Error ? error.message : String(error || "岗位 MCP 调用失败")).slice(0, 500);
}

function trustedAdoptIdFromHeaders(req: Request): string {
  for (const name of ["x-jiuwen-channel-id", "x-agent-adopt-id", "x-workforce-agent-adopt-id"]) {
    const value = String(req.headers[name] || "").trim();
    if (/^lgj-[A-Za-z0-9_-]{3,60}$/.test(value)) return value;
  }
  return "";
}

async function trustedAdoptId(req: Request): Promise<string> {
  const direct = trustedAdoptIdFromHeaders(req);
  if (direct) return direct;
  const runtimeAgentId = String(req.headers["x-linggan-agent-id"] || "").trim();
  if (!runtimeAgentId) return "";
  return String((await getClawByAgentId(runtimeAgentId).catch(() => null))?.adoptId || "");
}

async function runtimeContext(req: Request): Promise<RuntimeContext> {
  const adoptId = await trustedAdoptId(req);
  if (!adoptId) throw new Error("trusted Agent identity is missing");
  const adoption = await getClawByAdoptId(adoptId);
  if (!adoption || !["active", "expiring"].includes(String(adoption.status || ""))) {
    throw new Error("Agent is not active");
  }
  const roleKey = String(adoption.roleTemplate || "general-assistant").trim();
  const assets = await resolveEffectiveRoleAssets(roleKey);
  const selection = await resolvePersistedAgentMcpSelection(adoptId, assets);
  return {
    adoptId,
    agentId: String(adoption.agentId || adoptId),
    roleKey,
    userId: Number(adoption.userId || 0),
    enabledServerIds: new Set(selection.enabledServerIds),
  };
}

function runtimeMcpServers(): Record<string, Record<string, unknown>> {
  const config = readOpenclawJson();
  const servers = config?.mcp?.servers;
  return servers && typeof servers === "object" && !Array.isArray(servers)
    ? servers as Record<string, Record<string, unknown>>
    : {};
}

function expanded(value: unknown): string {
  return String(value ?? "").replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => process.env[name] || "");
}

export function normalizeTrustedRuntimeMcpConfig(raw: Record<string, unknown>): TrustedRuntimeMcpConfig | null {
  if (raw.disabled) return null;
  const transport = String(raw.transport || raw.type || "").trim().toLowerCase();
  const endpointUrl = String(raw.url || raw.endpoint || "").trim();
  if (!endpointUrl || (transport && !["url", "streamable-http", "streamablehttp", "http"].includes(transport))) return null;
  const sourceHeaders = raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)
    ? raw.headers as Record<string, unknown>
    : raw.http_headers && typeof raw.http_headers === "object" && !Array.isArray(raw.http_headers)
      ? raw.http_headers as Record<string, unknown>
      : {};
  const headers = Object.fromEntries(Object.entries(sourceHeaders)
    .map(([name, value]) => [name, expanded(value)])
    .filter(([name, value]) => Boolean(name && value)));
  return { endpointUrl, headers, timeoutMs: Number(raw.timeoutMs || raw.timeout_ms || 60_000) };
}

export function roleMcpGatewayToolName(serverId: string, remoteName: string): string {
  const serverHash = createHash("sha256").update(serverId).digest("hex").slice(0, 8);
  const toolHash = createHash("sha256").update(remoteName).digest("hex").slice(0, 8);
  const safe = remoteName.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
  const prefix = `role_${serverHash}_`;
  return `${prefix}${safe.slice(0, Math.max(1, 119 - prefix.length))}_${toolHash}`.slice(0, 128);
}

export function roleMcpToolIsSafe(tool: CustomMcpToolSnapshot): boolean {
  const profile = resolveCustomMcpToolGovernance(tool);
  if (["read", "compute"].includes(profile.sideEffect)) return true;
  // Platform-managed legacy MCPs often omit annotations. Permit only unknown
  // names that are unambiguously local computation; explicit write verbs keep
  // their inferred write profile even when a remote server claims read-only.
  return profile.source === "default" && SAFE_COMPUTE_NAME_RE.test(tool.name);
}

async function toolsForServer(serverId: string, config: TrustedRuntimeMcpConfig): Promise<CustomMcpToolSnapshot[]> {
  const key = createHash("sha256").update(JSON.stringify({ serverId, config })).digest("hex");
  const cached = toolCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.tools;
  const tools = (await discoverTrustedRuntimeMcpTools(config)).filter(roleMcpToolIsSafe);
  toolCache.set(key, { expiresAt: Date.now() + TOOL_CACHE_TTL_MS, tools });
  if (toolCache.size > 100) {
    const oldest = toolCache.keys().next().value as string | undefined;
    if (oldest) toolCache.delete(oldest);
  }
  return tools;
}

export type RoleMcpReadinessProbe = {
  configured: boolean;
  availableTools: string[];
  probeError?: string;
};

/**
 * Resolve the logical MCP server behind the shared role gateway. Readiness
 * checks use remote tool names because role-pack requirements are authored
 * against the enterprise asset, not the gateway's hashed exposed name.
 */
export async function probeRoleMcpServerForReadiness(serverId: string): Promise<RoleMcpReadinessProbe> {
  const normalized = String(serverId || "").trim();
  if (!normalized || MANAGED_SERVER_IDS.has(normalized)) {
    return { configured: false, availableTools: [] };
  }
  const raw = runtimeMcpServers()[normalized];
  const config = raw ? normalizeTrustedRuntimeMcpConfig(raw) : null;
  if (!config) return { configured: false, availableTools: [] };
  try {
    const tools = await toolsForServer(normalized, config);
    return {
      configured: true,
      availableTools: tools.map((tool) => tool.name).filter(Boolean).sort(),
    };
  } catch (error) {
    return {
      configured: true,
      availableTools: [],
      probeError: cleanError(error),
    };
  }
}

async function exposedTools(context: RuntimeContext): Promise<RoleMcpTool[]> {
  const configured = runtimeMcpServers();
  const rows = await Promise.all(Array.from(context.enabledServerIds)
    .filter((serverId) => !MANAGED_SERVER_IDS.has(serverId))
    .map(async (serverId): Promise<RoleMcpTool[]> => {
      const config = configured[serverId] ? normalizeTrustedRuntimeMcpConfig(configured[serverId]) : null;
      if (!config) return [];
      const tools = await toolsForServer(serverId, config).catch(() => []);
      return tools.map((tool) => ({
        serverId,
        exposedName: roleMcpGatewayToolName(serverId, tool.name),
        tool,
        config,
      }));
    }));
  return rows.flat().slice(0, MAX_TOOLS);
}

async function callTool(context: RuntimeContext, exposedName: string, args: Record<string, unknown>, req: Request) {
  const finishMetric = beginMcpCall("enterprise");
  let outcome: "success" | "empty" | "error" = "empty";
  try {
    const entry = (await exposedTools(context)).find((item) => item.exposedName === exposedName);
    if (!entry) return textResult("该岗位工具未授权、不可用或不属于当前岗位。", true);
    if (!roleMcpToolIsSafe(entry.tool)) return textResult("旧版岗位 MCP 仅允许只读或计算操作；写操作请迁入企业 MCP 治理注册表。", true);
    const egress = await guardToolEgress({
      channel: "enterprise_mcp",
      payload: args,
      adoptId: context.adoptId,
      toolName: entry.tool.name,
      destinationUrl: entry.config.endpointUrl,
      destinationTrust: "platform",
    });
    if (!egress.ok) {
      outcome = "error";
      return textResult(egress.error || "当前数据不允许发送到该岗位工具。", true);
    }
    await recordAuditBestEffort({
      action: "mcp.role_tool.requested",
      result: "success",
      severity: "info",
      actorType: "agent",
      actorUserId: context.userId,
      ...auditRequest(req),
      targetType: "mcp_tool",
      targetId: `${entry.serverId}:${entry.tool.name}`.slice(0, 128),
      targetName: entry.tool.name,
      agentInstanceId: context.adoptId,
      runtimeAgentId: context.agentId,
      toolName: entry.tool.name,
      policyCode: "EA_ROLE_MCP_READ_ONLY_V1",
      source: SERVICE_NAME,
      metadata: { roleKey: context.roleKey, serverId: entry.serverId, sideEffect: "read_or_compute" },
    });
    const result = await callTrustedRuntimeMcpTool(entry.config, entry.tool.name, args);
    const failed = Boolean(result.isError);
    outcome = failed ? "error" : "success";
    await recordAuditBestEffort({
      action: "mcp.role_tool.completed",
      result: failed ? "failed" : "success",
      severity: failed ? "high" : "info",
      actorType: "agent",
      actorUserId: context.userId,
      ...auditRequest(req),
      targetType: "mcp_tool",
      targetId: `${entry.serverId}:${entry.tool.name}`.slice(0, 128),
      targetName: entry.tool.name,
      agentInstanceId: context.adoptId,
      runtimeAgentId: context.agentId,
      toolName: entry.tool.name,
      policyCode: "EA_ROLE_MCP_READ_ONLY_V1",
      source: SERVICE_NAME,
      metadata: { roleKey: context.roleKey, serverId: entry.serverId },
    });
    return result;
  } catch (error) {
    outcome = "error";
    return textResult(`岗位工具调用失败：${cleanError(error)}`, true);
  } finally {
    finishMetric(outcome);
  }
}

async function handleMessage(req: Request, message: unknown) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const rpc = message as JsonRpcMessage;
  const id = rpc.id;
  if (rpc.method === "notifications/initialized") return null;
  if (rpc.method === "initialize") return hasRequestId(id) ? ok(id, {
    protocolVersion: "2025-11-25",
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVICE_NAME, version: SERVICE_VERSION },
    instructions: "Role-scoped read and compute tools proxied through the EA control plane.",
  }) : null;
  if (rpc.method === "ping") return hasRequestId(id) ? ok(id, {}) : null;
  if (rpc.method === "resources/list") return hasRequestId(id) ? ok(id, { resources: [] }) : null;
  if (rpc.method === "prompts/list") return hasRequestId(id) ? ok(id, { prompts: [] }) : null;
  if (rpc.method === "tools/list") {
    const tools = (await exposedTools(await runtimeContext(req))).map((entry) => ({
      name: entry.exposedName,
      description: `[${entry.serverId}] ${entry.tool.description || entry.tool.name}`.slice(0, 2_000),
      inputSchema: entry.tool.inputSchema || { type: "object", properties: {} },
      ...(entry.tool.outputSchema ? { outputSchema: entry.tool.outputSchema } : {}),
      annotations: { ...(entry.tool.annotations || {}), readOnlyHint: true, destructiveHint: false },
    }));
    return hasRequestId(id) ? ok(id, { tools }) : null;
  }
  if (rpc.method === "tools/call") {
    if (!hasRequestId(id)) return null;
    const rawArgs = rpc.params?.arguments;
    const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? rawArgs as Record<string, unknown>
      : {};
    return ok(id, await callTool(await runtimeContext(req), String(rpc.params?.name || ""), args, req));
  }
  return hasRequestId(id) ? err(id, -32601, `Method not found: ${String(rpc.method || "")}`) : null;
}

export function registerRoleMcpGatewayRoutes(app: Express): void {
  const audience = internalMcpAudience("/api/internal/role-mcp/mcp");
  const authorize = async (req: Request) => await authorizeAndBindInternalRuntimeRequest(req, audience);

  app.get("/api/internal/role-mcp/health", async (req, res) => {
    if (!await authorize(req)) return res.status(401).json({ error: "unauthorized" });
    res.json({ status: "ok", name: SERVICE_NAME, version: SERVICE_VERSION });
  });
  app.get("/api/internal/role-mcp/mcp", async (req, res) => {
    if (!await authorize(req)) return res.status(401).json(err(null, -32001, "unauthorized"));
    const adoptId = await trustedAdoptId(req);
    if (!adoptId) return res.status(400).json(err(null, -32001, "trusted Agent identity is missing"));
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Mcp-Session-Id", `role-mcp-${adoptId}`);
    res.flushHeaders?.();
    res.write(": role MCP stream ready\n\n");
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25_000);
    req.on("close", () => clearInterval(heartbeat));
  });
  app.delete("/api/internal/role-mcp/mcp", async (req, res) => {
    if (!await authorize(req)) return res.status(401).json(err(null, -32001, "unauthorized"));
    res.status(204).end();
  });
  app.post("/api/internal/role-mcp/mcp", async (req, res) => {
    if (!await authorize(req)) return res.status(401).json(err(null, -32001, "unauthorized"));
    try {
      const body = req.body || {};
      const response = Array.isArray(body)
        ? (await Promise.all(body.map((item) => handleMessage(req, item)))).filter(Boolean)
        : await handleMessage(req, body);
      if (!response || (Array.isArray(response) && response.length === 0)) return res.status(202).json({});
      const adoptId = await trustedAdoptId(req);
      if (adoptId) res.setHeader("Mcp-Session-Id", `role-mcp-${adoptId}`);
      res.json(response);
    } catch (error) {
      res.status(200).json(err(req.body?.id, -32000, cleanError(error)));
    }
  });
}
