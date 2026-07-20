import { WebSocket, type RawData } from "ws";
import { resolveEffectiveRoleAssets } from "../db/role-assets";
import { getSkillMcpRequirement, type SkillMcpRequirement } from "./role-templates";

const DEFAULT_AGENTSERVER_WS_URL = "ws://127.0.0.1:18092";
const SERVER_CACHE_TTL_MS = 30_000;
const TOOL_CACHE_TTL_MS = 45_000;

type RuntimeMcpServer = {
  name: string;
  enabled: boolean;
};

export type SkillMcpServerReadiness = {
  serverId: string;
  requiredTools: string[];
  authorized: boolean;
  configured: boolean;
  enabled: boolean;
  availableTools: string[];
  missingTools: string[];
  probeError?: string;
};

export type SkillMcpReadiness = {
  skillId: string;
  status: "not_required" | "ready" | "blocked" | "unchecked";
  canProceed: boolean;
  message: string;
  checkedAt: string;
  servers: SkillMcpServerReadiness[];
};

type EvaluateSkillMcpReadinessInput = {
  skillId: string;
  requirement: SkillMcpRequirement;
  authorizedServerIds: Set<string>;
  configuredServers: RuntimeMcpServer[] | null;
  toolsByServer?: Record<string, string[] | undefined>;
  probeErrors?: Record<string, string | undefined>;
  catalogError?: string;
  checkedAt?: string;
};

let serverCache: { expiresAt: number; value: RuntimeMcpServer[] } | null = null;
const toolCache = new Map<string, { expiresAt: number; value: string[] }>();

function sanitizeProbeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error || "MCP 探测失败")
    .replace(/((?:api[_-]?key|token|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, 240);
}

function parseFrame(raw: RawData): any | null {
  try {
    if (Array.isArray(raw)) return JSON.parse(Buffer.concat(raw).toString("utf8"));
    if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString("utf8"));
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function agentServerOrigin(wsUrl: string): string {
  const parsed = new URL(wsUrl);
  return `${parsed.protocol === "wss:" ? "https:" : "http:"}//${parsed.host}`;
}

async function callJiuwenAgentServerCommand<T>(
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 8_000,
): Promise<T> {
  const wsUrl = String(process.env.JIUWENCLAW_AGENTSERVER_WS_URL || DEFAULT_AGENTSERVER_WS_URL).trim();
  if (!/^wss?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(wsUrl)) {
    throw new Error("JiuwenSwarm MCP probe must use a loopback WebSocket URL");
  }
  const requestId = `ea-mcp-probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

  return await new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Origin: agentServerOrigin(wsUrl) } });
    let settled = false;
    const finish = (error?: Error, payload?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(1000, "complete"); } catch {}
      if (error) reject(error);
      else resolve(payload as T);
    };
    const timer = setTimeout(
      () => finish(new Error(`JiuwenSwarm ${method} timed out`)),
      Math.max(1_000, timeoutMs),
    );
    ws.on("open", () => {
      ws.send(JSON.stringify({
        protocol_version: "1.0",
        request_id: requestId,
        timestamp: new Date().toISOString(),
        identity_origin: "system",
        channel: "web",
        method,
        is_stream: false,
        service_id: String(process.env.JIUWENCLAW_SERVICE_ID || "linggan"),
        agent_id: "ea_mcp_probe",
        session_id: "ea_mcp_probe",
        params,
      }));
    });
    ws.on("message", (raw) => {
      const frame = parseFrame(raw);
      if (!frame || (frame.response_id !== requestId && frame.request_id !== requestId)) return;
      const result = frame?.body?.result ?? frame?.body ?? {};
      if (frame.status === "failed" || frame.ok === false) {
        finish(new Error(String(result?.error || frame?.error || `${method} failed`)));
        return;
      }
      if (frame.is_final === false) return;
      finish(undefined, result as T);
    });
    ws.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    ws.on("close", () => {
      if (!settled) finish(new Error(`JiuwenSwarm ${method} connection closed before response`));
    });
  });
}

async function listRuntimeMcpServers(force = false): Promise<RuntimeMcpServer[]> {
  const now = Date.now();
  if (!force && serverCache && serverCache.expiresAt > now) return serverCache.value;
  const payload = await callJiuwenAgentServerCommand<{ items?: Array<Record<string, unknown>> }>(
    "command.mcp",
    { action: "list" },
  );
  const value = (Array.isArray(payload.items) ? payload.items : [])
    .map((item) => ({
      name: String(item?.name || "").trim(),
      enabled: item?.enabled !== false,
    }))
    .filter((item) => item.name);
  serverCache = { expiresAt: now + SERVER_CACHE_TTL_MS, value };
  return value;
}

async function listRuntimeMcpTools(serverId: string, force = false): Promise<string[]> {
  const now = Date.now();
  const cached = toolCache.get(serverId);
  if (!force && cached && cached.expiresAt > now) return cached.value;
  const payload = await callJiuwenAgentServerCommand<{ tools?: Array<Record<string, unknown>> }>(
    "command.mcp",
    { action: "list_tools", name: serverId },
    12_000,
  );
  const value = Array.from(new Set(
    (Array.isArray(payload.tools) ? payload.tools : [])
      .map((tool) => String(tool?.name || "").trim())
      .filter(Boolean),
  )).sort();
  toolCache.set(serverId, { expiresAt: now + TOOL_CACHE_TTL_MS, value });
  return value;
}

export function evaluateSkillMcpReadiness(input: EvaluateSkillMcpReadinessInput): SkillMcpReadiness {
  const checkedAt = input.checkedAt || new Date().toISOString();
  const requiredEntries = Object.entries(input.requirement.servers);
  if (requiredEntries.length === 0) {
    return {
      skillId: input.skillId,
      status: "not_required",
      canProceed: true,
      message: "该技能没有声明 MCP 前置依赖",
      checkedAt,
      servers: [],
    };
  }

  if (!input.configuredServers) {
    return {
      skillId: input.skillId,
      status: "unchecked",
      canProceed: true,
      message: `暂时无法验证 MCP 状态：${input.catalogError || "JiuwenSwarm 不可用"}`,
      checkedAt,
      servers: requiredEntries.map(([serverId, requiredTools]) => ({
        serverId,
        requiredTools,
        authorized: input.authorizedServerIds.has(serverId),
        configured: false,
        enabled: false,
        availableTools: [],
        missingTools: [],
        probeError: input.catalogError,
      })),
    };
  }

  const configuredByName = new Map(input.configuredServers.map((server) => [server.name, server]));
  const blockingReasons: string[] = [];
  const warningReasons: string[] = [];
  const servers = requiredEntries.map(([serverId, requiredTools]) => {
    const authorized = input.authorizedServerIds.has(serverId);
    const configured = configuredByName.has(serverId);
    const enabled = configuredByName.get(serverId)?.enabled === true;
    const availableTools = input.toolsByServer?.[serverId] || [];
    const probeError = input.probeErrors?.[serverId];
    const missingTools = requiredTools.filter((tool) => !availableTools.includes(tool));

    if (!authorized) blockingReasons.push(`岗位未授权 ${serverId}`);
    else if (!configured) blockingReasons.push(`JiuwenSwarm 未配置 ${serverId}`);
    else if (!enabled) blockingReasons.push(`MCP ${serverId} 已停用`);
    else if (probeError) warningReasons.push(`${serverId} 暂时无法探测`);
    else if (requiredTools.length > 0 && missingTools.length > 0) {
      blockingReasons.push(`${serverId} 缺少工具 ${missingTools.join(", ")}`);
    }

    return {
      serverId,
      requiredTools,
      authorized,
      configured,
      enabled,
      availableTools,
      missingTools: probeError ? [] : missingTools,
      ...(probeError ? { probeError } : {}),
    };
  });

  if (blockingReasons.length > 0) {
    return {
      skillId: input.skillId,
      status: "blocked",
      canProceed: false,
      message: `技能暂不可用：${blockingReasons.join("；")}`,
      checkedAt,
      servers,
    };
  }
  if (warningReasons.length > 0) {
    return {
      skillId: input.skillId,
      status: "unchecked",
      canProceed: true,
      message: `MCP 状态未完全确认：${warningReasons.join("；")}`,
      checkedAt,
      servers,
    };
  }
  return {
    skillId: input.skillId,
    status: "ready",
    canProceed: true,
    message: "技能所需 MCP 已就绪",
    checkedAt,
    servers,
  };
}

export async function probeJiuwenSkillMcpReadiness(args: {
  skillId: string;
  roleTemplate: string;
  force?: boolean;
}): Promise<SkillMcpReadiness> {
  const requirement = getSkillMcpRequirement(args.skillId);
  const requiredServerIds = Object.keys(requirement.servers);
  const assets = await resolveEffectiveRoleAssets(args.roleTemplate);
  const authorizedServerIds = new Set([
    ...assets.mcpServers.default,
    ...assets.mcpServers.optional,
  ]);
  if (requiredServerIds.length === 0) {
    return evaluateSkillMcpReadiness({
      skillId: args.skillId,
      requirement,
      authorizedServerIds,
      configuredServers: [],
    });
  }

  let configuredServers: RuntimeMcpServer[];
  try {
    configuredServers = await listRuntimeMcpServers(Boolean(args.force));
  } catch (error) {
    return evaluateSkillMcpReadiness({
      skillId: args.skillId,
      requirement,
      authorizedServerIds,
      configuredServers: null,
      catalogError: sanitizeProbeError(error),
    });
  }

  const configuredByName = new Map(configuredServers.map((server) => [server.name, server]));
  const toolsByServer: Record<string, string[] | undefined> = {};
  const probeErrors: Record<string, string | undefined> = {};
  await Promise.all(requiredServerIds.map(async (serverId) => {
    const requiredTools = requirement.servers[serverId] || [];
    const server = configuredByName.get(serverId);
    if (!authorizedServerIds.has(serverId) || !server?.enabled || requiredTools.length === 0) return;
    try {
      toolsByServer[serverId] = await listRuntimeMcpTools(serverId, Boolean(args.force));
    } catch (error) {
      probeErrors[serverId] = sanitizeProbeError(error);
    }
  }));

  return evaluateSkillMcpReadiness({
    skillId: args.skillId,
    requirement,
    authorizedServerIds,
    configuredServers,
    toolsByServer,
    probeErrors,
  });
}

export function resetSkillMcpReadinessCacheForTests(): void {
  serverCache = null;
  toolCache.clear();
}
