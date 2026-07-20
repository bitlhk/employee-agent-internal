import express from "express";
import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { isAuthorizedInternalRequest, requireClawOwner } from "./helpers";
import {
  runA2AExpertTask,
  summarizeA2AEvents,
  type A2AEndpointConfig,
} from "./a2a-expert-client";
import {
  countActiveAgentTasks,
  countAgentCallsSince,
  createAgentTask,
  getBusinessAgent,
  getAgentTaskBySourceMessage,
  insertCallLog,
  listAgentTasks,
  listAgentTasksByIds,
  listEnabledBusinessAgents,
  updateAgentTask,
} from "../db/agents";

type AgentTaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

const AGENT_TASK_TEXT_LIMIT_BYTES = 60_000;
const AGENT_TASK_ERROR_LIMIT_BYTES = 8_000;
const AGENT_TASK_RAW_EVENTS_LIMIT_BYTES = 40_000;

function truncateUtf8(value: unknown, maxBytes: number): string {
  const text = String(value ?? "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffix = "\n\n[内容过长，已截断]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const buf = Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes - suffixBytes));
  return `${buf.toString("utf8").replace(/\uFFFD+$/g, "")}${suffix}`;
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

function parseJsonArray(raw: unknown): any[] {
  if (!raw || typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function resolveClaw(req: express.Request, res: express.Response, adoptId: string) {
  if (isAuthorizedInternalRequest(req)) {
    const { getClawByAdoptId } = await import("../db");
    const claw = await getClawByAdoptId(adoptId);
    if (!claw) {
      res.status(404).json({ error: "NOT_FOUND" });
      return undefined;
    }
    return claw;
  }
  return requireClawOwner(req, res, adoptId);
}

async function requesterProfiles(userId: number): Promise<string[]> {
  try {
    const { getUserById } = await import("../db/users");
    const user = await getUserById(userId);
    const roleProfile = user?.role === "admin" ? "internal" : "plus";
    const accessLevel = String((user as any)?.accessLevel || "").trim();
    return Array.from(new Set([roleProfile, accessLevel].filter(Boolean)));
  } catch {
    return ["plus"];
  }
}

function profileAllowed(agent: any, profileKeys: string[]) {
  if (!agent || Number(agent.enabled) !== 1) return false;
  if (agent.expiresAt && new Date(agent.expiresAt).getTime() < Date.now()) return false;
  const allowed = String(agent.allowedProfiles || "plus,internal")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (allowed.length === 0) return true;
  return profileKeys.some((profile) => allowed.includes(profile));
}

function roleAllowed(agent: any, roleTemplate: unknown) {
  const endpointConfig = parseJsonRecord(agent?.endpointConfigJson);
  const allowedRoles = Array.isArray(endpointConfig.roleTemplates)
    ? endpointConfig.roleTemplates.map((item: unknown) => String(item || "").trim()).filter(Boolean)
    : [];
  if (allowedRoles.length === 0) return true;
  const role = String(roleTemplate || "").trim();
  return allowedRoles.includes(role);
}

function isAgentIntegration(agent: any) {
  const providerType = String(agent?.providerType || "").trim().toLowerCase();
  const adapterProtocol = String(agent?.adapterProtocol || "").trim().toLowerCase();
  const capabilities = parseJsonArray(agent?.capabilitiesJson).map((item) => String(item || "").toLowerCase());
  return (
    providerType === "a2a" ||
    providerType === "agent" ||
    adapterProtocol === "a2a-v1" ||
    adapterProtocol === "agent-a2a-v1" ||
    adapterProtocol === "a2a-task-v1" ||
    capabilities.includes("agent") ||
    capabilities.includes("async-agent")
  );
}

function routeReason(agent: any) {
  if (!agent?.apiUrl) return "缺少 Agent endpoint";
  const adapterProtocol = String(agent?.adapterProtocol || "").trim();
  if (!["a2a-v1", "agent-a2a-v1", "a2a-task-v1"].includes(adapterProtocol)) {
    return `暂不支持 ${adapterProtocol || "未配置"} adapter`;
  }
  const endpointConfig = parseJsonRecord(agent?.endpointConfigJson);
  if (endpointConfig.authRequired === true && !agent?.apiToken) return "缺少 Agent 凭据";
  return "";
}

function publicAgent(agent: any) {
  const capabilities = parseJsonArray(agent.capabilitiesJson).map((item) => String(item || "")).filter(Boolean);
  const endpointConfig = parseJsonRecord(agent.endpointConfigJson);
  const reason = routeReason(agent);
  return {
    id: String(agent.id),
    name: String(agent.name || agent.id),
    description: String(agent.description || ""),
    icon: String(agent.icon || "🤖"),
    tags: String(agent.tags || ""),
    providerType: String(agent.providerType || "agent"),
    adapterProtocol: String(agent.adapterProtocol || ""),
    capabilities,
    executionMode: endpointConfig.executionMode || "async",
    routeReady: !reason,
    reason,
    healthStatus: String(agent.healthStatus || "unknown"),
    lastHealthCheck: agent.lastHealthCheck || null,
  };
}

function decodePythonSingleQuoted(raw: string): string {
  const normalized = raw.replace(/\\'/g, "'");
  try {
    return JSON.parse(`"${normalized.replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`);
  } catch {
    return normalized.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
  }
}

function formatStructuredToolContent(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

export function cleanA2AText(text: string): string {
  const trimmed = String(text || "").trim();
  if (!trimmed) return trimmed;

  // JiuwenSwarm A2A may include tool traces inside the final response artifact.
  // Prefer the last structured tool result without interpreting business fields.
  const contentRegex = /data=\{'content': '([\s\S]*?)'\}\s+error=None/g;
  let match: RegExpExecArray | null;
  let best: string | null = null;
  while ((match = contentRegex.exec(trimmed))) {
    const decoded = decodePythonSingleQuoted(match[1] || "").trim();
    if (!decoded.startsWith("{") && !decoded.startsWith("[")) continue;
    try {
      const parsed = JSON.parse(decoded);
      best = formatStructuredToolContent(parsed);
    } catch {}
  }
  if (best) return best;

  const lastToolResult = Math.max(trimmed.lastIndexOf("[tool_result"), trimmed.lastIndexOf("[tool_call]"));
  if (lastToolResult > 0) {
    const tail = trimmed.slice(lastToolResult);
    const firstHeading = tail.search(/(^|\n)#{1,3}\s+/);
    if (firstHeading >= 0) return tail.slice(firstHeading).trim();
  }
  return trimmed;
}

async function runAgentTaskInBackground(taskId: string, agent: any, input: string) {
  const startedAt = Date.now();
  await updateAgentTask(taskId, { status: "running" as AgentTaskStatus, startedAt: sql`CURRENT_TIMESTAMP`, errorMessage: null });
  try {
    const adapterProtocol = String(agent.adapterProtocol || "").trim();
    if (!agent.apiUrl) throw new Error("Agent endpoint is not configured");
    if (!["a2a-v1", "agent-a2a-v1", "a2a-task-v1"].includes(adapterProtocol)) {
      throw new Error(`${adapterProtocol || "missing adapter"} is not supported by agent task runner`);
    }
    const endpointConfig = parseJsonRecord(agent.endpointConfigJson) as A2AEndpointConfig;
    const result = await runA2AExpertTask({
      apiUrl: String(agent.apiUrl || ""),
      apiToken: agent.apiToken,
      endpointConfig,
    }, input);
    if (!String(result.text || "").trim()) {
      throw new Error("A2A Agent did not return the configured result artifact");
    }
    const cleanedText = cleanA2AText(result.text);
    await updateAgentTask(taskId, {
      status: "succeeded" as AgentTaskStatus,
      resultMarkdown: truncateUtf8(cleanedText, AGENT_TASK_TEXT_LIMIT_BYTES),
      remoteTaskId: result.remoteTaskId || null,
      rawEventsJson: summarizeA2AEvents(result.rawEvents || [], endpointConfig, AGENT_TASK_RAW_EVENTS_LIMIT_BYTES),
      completedAt: sql`CURRENT_TIMESTAMP`,
      errorMessage: null,
    });
    await insertCallLog({
      agentId: String(agent.id),
      userId: Number((agent as any).__taskUserId || 0) || undefined,
      adoptId: String((agent as any).__taskAdoptId || "") || undefined,
      status: "success",
      durationMs: Date.now() - startedAt,
    }).catch(() => undefined);
  } catch (error: any) {
    const timedOut = error?.name === "AbortError" || /abort|timeout/i.test(String(error?.message || ""));
    await updateAgentTask(taskId, {
      status: "failed" as AgentTaskStatus,
      errorMessage: truncateUtf8(error?.message || String(error), AGENT_TASK_ERROR_LIMIT_BYTES),
      completedAt: sql`CURRENT_TIMESTAMP`,
    });
    await insertCallLog({
      agentId: String(agent.id),
      userId: Number((agent as any).__taskUserId || 0) || undefined,
      adoptId: String((agent as any).__taskAdoptId || "") || undefined,
      status: timedOut ? "timeout" : "error",
      durationMs: Date.now() - startedAt,
      errorMessage: truncateUtf8(error?.message || String(error), 2_000),
    }).catch(() => undefined);
  }
}

export function registerAgentTaskRoutes(app: express.Express) {
  app.get("/api/claw/agents/available", async (req, res) => {
    const adoptId = String(req.query.adoptId || "").trim();
    if (!adoptId) return res.status(400).json({ error: "adoptId required" });
    const claw = await resolveClaw(req, res, adoptId);
    if (!claw) return;
    try {
      const profileKeys = await requesterProfiles(Number((claw as any).userId || 0));
      const agents = (await listEnabledBusinessAgents())
        .filter((agent) => isAgentIntegration(agent))
        .filter((agent) => profileAllowed(agent, profileKeys))
        .filter((agent) => roleAllowed(agent, (claw as any).roleTemplate))
        .map(publicAgent);
      res.json({ agents });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "AGENTS_UNAVAILABLE" });
    }
  });

  app.get("/api/claw/agent-tasks", async (req, res) => {
    const adoptId = String(req.query.adoptId || "").trim();
    if (!adoptId) return res.status(400).json({ error: "adoptId required" });
    const claw = await resolveClaw(req, res, adoptId);
    if (!claw) return;
    try {
      const ids = String(req.query.ids || "")
        .split(",")
        .map((id) => id.trim())
        .filter((id) => /^agt_[A-Za-z0-9]{8,64}$/.test(id))
        .slice(0, 64);
      const tasks = ids.length > 0
        ? await listAgentTasksByIds(adoptId, ids)
        : await listAgentTasks(adoptId, Number(req.query.limit || 30));
      res.json({ tasks });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "TASKS_UNAVAILABLE" });
    }
  });

  app.post("/api/claw/agent-tasks/submit", async (req, res) => {
    const adoptId = String(req.body?.adoptId || "").trim();
    const agentId = String(req.body?.agentId || "").trim();
    const input = String(req.body?.task || req.body?.input || "").trim();
    if (!adoptId) return res.status(400).json({ error: "adoptId required" });
    if (!agentId) return res.status(400).json({ error: "agentId required" });
    if (!input) return res.status(400).json({ error: "task required" });
    const claw = await resolveClaw(req, res, adoptId);
    if (!claw) return;

    try {
      const profileKeys = await requesterProfiles(Number((claw as any).userId || 0));
      const agent = await getBusinessAgent(agentId);
      if (!agent || !isAgentIntegration(agent) || !profileAllowed(agent, profileKeys) || !roleAllowed(agent, (claw as any).roleTemplate)) {
        return res.status(403).json({ error: "AGENT_NOT_ALLOWED" });
      }
      const reason = routeReason(agent);
      if (reason) return res.status(409).json({ error: reason });

      const sourceMessageId = req.body?.sourceMessageId ? String(req.body.sourceMessageId).slice(0, 128) : "";
      if (sourceMessageId) {
        const existing = await getAgentTaskBySourceMessage(adoptId, sourceMessageId);
        if (existing) {
          return res.json({
            taskId: existing.id,
            reused: true,
            task: { ...existing, agent: publicAgent(agent), agentName: agent.name },
          });
        }
      }

      const endpointConfig = parseJsonRecord(agent.endpointConfigJson);
      const maxConcurrent = Math.max(0, Math.min(100, Number(endpointConfig.maxConcurrent || 0)));
      if (maxConcurrent > 0 && await countActiveAgentTasks(agentId) >= maxConcurrent) {
        return res.status(429).json({ error: "专家当前任务较多，请稍后重试" });
      }
      const maxDailyRequests = Math.max(0, Number(agent.maxDailyRequests || 0));
      if (maxDailyRequests > 0) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (await countAgentCallsSince(agentId, today) >= maxDailyRequests) {
          return res.status(429).json({ error: "专家今日调用额度已用完" });
        }
      }

      const taskId = `agt_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const taskUserId = Number((claw as any).userId || 0);
      await createAgentTask({
        id: taskId,
        adoptId,
        userId: taskUserId,
        agentId,
        sourceConversationId: req.body?.conversationId ? String(req.body.conversationId).slice(0, 128) : null,
        sourceSessionId: req.body?.sessionId ? String(req.body.sessionId).slice(0, 160) : null,
        sourceMessageId: sourceMessageId || null,
        status: "pending",
        input,
        adapterProtocol: String(agent.adapterProtocol || ""),
      } as any);

      const publicPayload = publicAgent(agent);
      res.json({
        taskId,
        reused: false,
        task: {
          id: taskId,
          adoptId,
          agentId,
          agentName: agent.name,
          status: "pending",
          input,
          adapterProtocol: String(agent.adapterProtocol || ""),
          createdAt: new Date().toISOString(),
          agent: publicPayload,
        },
      });
      void runAgentTaskInBackground(taskId, {
        ...agent,
        __taskUserId: taskUserId,
        __taskAdoptId: adoptId,
      }, input).catch((error) => {
        console.error("[AGENT-TASK] background runner failed", { taskId, error: error?.message || error });
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "TASK_SUBMIT_FAILED" });
    }
  });
}
