import { listEnabledBusinessAgents, updateAgentHealth } from "../db/agents";
import { resolveTrustedLocalProfileA2ATarget } from "./local-profile-a2a-proxy";
import { safeAgentRequest } from "./safe-agent-http";

export type AgentHealthStatus = "healthy" | "degraded" | "offline" | "unknown";

type AgentHealthSubject = {
  id?: unknown;
  name?: unknown;
  apiUrl?: unknown;
  adapterProtocol?: unknown;
  enabled?: unknown;
  healthStatus?: unknown;
  lastHealthCheck?: unknown;
};

export type AgentProbeResult = {
  status: AgentHealthStatus;
  available: boolean;
  httpStatus?: number;
  reason?: string;
};

type HealthSnapshot = AgentProbeResult & {
  checkedAt: number;
  apiUrl: string;
};

type HealthGuardDependencies = {
  now?: () => number;
  probe?: (agent: AgentHealthSubject) => Promise<AgentProbeResult>;
  persist?: (agentId: string, status: AgentHealthStatus) => Promise<void>;
};

export const AGENT_HEALTH_FRESH_MS = 60_000;
export const AGENT_HEALTH_MONITOR_INTERVAL_MS = 300_000;
export const AGENT_HEALTH_PROBE_TIMEOUT_MS = 3_000;

const healthSnapshots = new Map<string, HealthSnapshot>();
let monitorStarted = false;

export class AgentUnavailableError extends Error {
  readonly code = "AGENT_UNAVAILABLE";
  readonly httpStatus: number;

  constructor(message: string, httpStatus = 503) {
    super(message);
    this.name = "AgentUnavailableError";
    this.httpStatus = httpStatus;
  }
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function timestamp(value: unknown): number {
  if (!value) return 0;
  const parsed = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function agentName(agent: AgentHealthSubject): string {
  return text(agent.name) || text(agent.id) || "专家";
}

function unavailableMessage(agent: AgentHealthSubject, result?: AgentProbeResult): string {
  if (result?.httpStatus === 429) return `${agentName(agent)}当前服务繁忙，请稍后重试`;
  return `${agentName(agent)}暂时不可用，请稍后重试`;
}

export function classifyAgentProbeStatus(status: number): AgentProbeResult {
  if (status === 429) {
    return { status: "degraded", available: false, httpStatus: status, reason: "rate_limited" };
  }
  if (status >= 500) {
    return {
      status: [502, 503, 504].includes(status) ? "offline" : "degraded",
      available: false,
      httpStatus: status,
      reason: `http_${status}`,
    };
  }
  // Authentication, method, and route errors still prove that the remote
  // gateway is reachable. The real authenticated A2A request remains the
  // authority for business-level validation.
  return { status: "healthy", available: true, httpStatus: status };
}

export function classifyAgentExecutionFailure(error: unknown): AgentProbeResult | null {
  const raw = text(error instanceof Error ? error.message : error);
  const status = Number(raw.match(/\bA2A HTTP\s+(\d{3})\b/i)?.[1] || 0);
  if (status === 429 || status >= 500) return classifyAgentProbeStatus(status);
  if ([401, 403, 404, 405].includes(status)) {
    return { status: "degraded", available: false, httpStatus: status, reason: `http_${status}` };
  }
  if (/timed?\s*out|timeout|aborted|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|socket hang up|connection closed/i.test(raw)) {
    return { status: "offline", available: false, reason: "network_error" };
  }
  return null;
}

export function friendlyAgentTaskError(error: unknown, name = "专家"): string {
  const raw = text(error instanceof Error ? error.message : error);
  const status = Number(raw.match(/\bA2A HTTP\s+(\d{3})\b/i)?.[1] || 0);
  if ([502, 503, 504].includes(status)) return `${name}服务暂时不可用（HTTP ${status}），请稍后重试`;
  if (status === 429) return `${name}当前服务繁忙，请稍后重试`;
  if (/timed?\s*out|timeout|aborted/i.test(raw)) return `${name}响应超时，请稍后重试`;
  const clean = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return (clean || `${name}任务执行失败`).slice(0, 1_000);
}

export function agentHealthRouteReason(agent: AgentHealthSubject, now = Date.now()): string {
  if (text(agent.healthStatus) !== "offline") return "";
  const checkedAt = timestamp(agent.lastHealthCheck);
  if (!checkedAt || now - checkedAt >= AGENT_HEALTH_FRESH_MS) return "";
  return unavailableMessage(agent);
}

export async function probeAgentEndpoint(agent: AgentHealthSubject): Promise<AgentProbeResult> {
  const rawUrl = text(agent.apiUrl);
  if (!rawUrl) return { status: "offline", available: false, reason: "missing_endpoint" };
  const target = resolveTrustedLocalProfileA2ATarget(rawUrl);
  try {
    const response = await safeAgentRequest(target.url, {
      method: "GET",
      timeoutMs: AGENT_HEALTH_PROBE_TIMEOUT_MS,
      allowPrivate: target.allowPrivate,
    });
    response.body.resume();
    return classifyAgentProbeStatus(response.status);
  } catch (error) {
    return {
      status: "offline",
      available: false,
      reason: text(error instanceof Error ? error.message : error).slice(0, 200) || "network_error",
    };
  }
}

async function persistHealth(agentId: string, status: AgentHealthStatus): Promise<void> {
  await updateAgentHealth(agentId, status);
}

async function recordSnapshot(
  agent: AgentHealthSubject,
  result: AgentProbeResult,
  dependencies: HealthGuardDependencies = {},
): Promise<void> {
  const id = text(agent.id);
  if (!id) return;
  const now = (dependencies.now || Date.now)();
  healthSnapshots.set(id, { ...result, checkedAt: now, apiUrl: text(agent.apiUrl) });
  await (dependencies.persist || persistHealth)(id, result.status);
}

export async function ensureAgentAvailable(
  agent: AgentHealthSubject,
  dependencies: HealthGuardDependencies = {},
): Promise<void> {
  const id = text(agent.id);
  const apiUrl = text(agent.apiUrl);
  if (!id || !apiUrl) throw new AgentUnavailableError(`${agentName(agent)}缺少可用的服务地址`, 409);
  const now = (dependencies.now || Date.now)();
  const cached = healthSnapshots.get(id);
  if (cached && cached.apiUrl === apiUrl && now - cached.checkedAt < AGENT_HEALTH_FRESH_MS) {
    if (!cached.available) throw new AgentUnavailableError(unavailableMessage(agent, cached));
    return;
  }

  const result = await (dependencies.probe || probeAgentEndpoint)(agent);
  await recordSnapshot(agent, result, dependencies);
  if (!result.available) throw new AgentUnavailableError(unavailableMessage(agent, result));
}

export async function markAgentTaskSucceeded(agent: AgentHealthSubject): Promise<void> {
  await recordSnapshot(agent, { status: "healthy", available: true });
}

export async function markAgentTaskFailed(agent: AgentHealthSubject, error: unknown): Promise<void> {
  const result = classifyAgentExecutionFailure(error);
  if (!result) return;
  await recordSnapshot(agent, result);
}

async function runHealthMonitor(): Promise<void> {
  try {
    const agents = (await listEnabledBusinessAgents()).filter((agent) => {
      const protocol = text(agent.adapterProtocol).toLowerCase();
      return Boolean(agent.apiUrl) && ["a2a-v1", "agent-a2a-v1", "a2a-task-v1"].includes(protocol);
    });
    const workers = Math.min(4, agents.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: workers }, async () => {
      while (cursor < agents.length) {
        const agent = agents[cursor++];
        const result = await probeAgentEndpoint(agent);
        await recordSnapshot(agent, result).catch(() => undefined);
      }
    }));
  } catch (error) {
    console.warn("[AGENT-HEALTH] monitor failed", friendlyAgentTaskError(error, "专家健康巡检"));
  }
}

export function startAgentHealthMonitor(): void {
  if (monitorStarted || process.env.NODE_ENV === "test") return;
  monitorStarted = true;
  const first = setTimeout(() => void runHealthMonitor(), 10_000);
  const interval = setInterval(() => void runHealthMonitor(), AGENT_HEALTH_MONITOR_INTERVAL_MS);
  first.unref?.();
  interval.unref?.();
}

export function resetAgentHealthStateForTests(): void {
  healthSnapshots.clear();
}

export function invalidateAgentHealthSnapshot(agentId: unknown): void {
  healthSnapshots.delete(text(agentId));
}
