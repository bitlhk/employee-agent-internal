import express from "express";
import { createHash, randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import {
  EA_INTERACTION_SCHEMA,
  agentInteractionAgentInput,
  agentInteractionResponseText,
  parseAgentInteraction,
  parseAgentInteractionResponse,
} from "@shared/agent-interaction";
import {
  canRetryAgentTask,
  normalizeAgentTaskLifecycle,
} from "@shared/agent-task-lifecycle";
import { isAuthorizedInternalRequest, requireClawOwner, resolveRuntimeWorkspaceByIds } from "./helpers";
import { materializeA2AArtifacts } from "./agent-artifacts";
import {
  cancelA2AExpertTask,
  runA2AExpertTask,
  summarizeA2AEvents,
  type A2AEndpointConfig,
} from "./a2a-expert-client";
import {
  AgentUnavailableError,
  agentHealthRouteReason,
  ensureAgentAvailable,
  friendlyAgentTaskError,
  markAgentTaskFailed,
  markAgentTaskSucceeded,
} from "./agent-health";
import {
  answerAgentTaskInteractionAndCreate,
  getBusinessAgentForContext,
  getAgentTask,
  getAgentTaskBySourceMessage,
  failInterruptedAgentTasks,
  insertCallLog,
  listAgentTasks,
  listAgentTasksByIds,
  listAgentTaskCounts,
  listEnabledBusinessAgentsForContext,
  reserveAgentTask,
  updateActiveAgentTask,
} from "../db/agents";
import {
  beginOperationalActivity,
  observeAgentTaskRetry,
  observeCapabilityPreflight,
  observeOperationalActivity,
  type OperationalOutcome,
} from "./observability/metrics";
import { guardToolEgress } from "./tool-egress-policy";

type AgentTaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

const AGENT_TASK_TEXT_LIMIT_BYTES = 60_000;
const AGENT_TASK_ERROR_LIMIT_BYTES = 8_000;
const AGENT_TASK_RAW_EVENTS_LIMIT_BYTES = 40_000;
const activeAgentTaskControllers = new Map<string, AbortController>();
const activeAgentTaskPromises = new Map<string, Promise<void>>();

function agentTaskRetryEnabled(): boolean {
  return !/^(0|false|no|off)$/i.test(String(process.env.EA_AGENT_TASK_RETRY_ENABLED || "true"));
}

export function isCancelledAgentTaskStatus(status: unknown): boolean {
  return ["cancelled", "canceled"].includes(String(status || "").trim().toLowerCase());
}

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

function publicAgentTask(task: unknown): Record<string, unknown> {
  const publicFields: Record<string, unknown> = task && typeof task === "object" ? { ...task } : {};
  delete publicFields.requestContextJson;
  delete publicFields.request_context_json;
  return {
    ...publicFields,
    lifecycleState: normalizeAgentTaskLifecycle({
      status: publicFields.status,
      interactionStatus: publicFields.interactionStatus ?? publicFields.interaction_status,
    }),
  };
}

function storedAgentTaskRuntime(task: Record<string, unknown>): {
  input: string;
  contextId?: string;
  dataPart?: Record<string, unknown>;
  dataPartMetadata?: Record<string, unknown>;
} {
  const stored = parseJsonRecord(task.requestContextJson ?? task.request_context_json);
  return {
    input: String(stored.input || task.input || ""),
    ...(stored.contextId ? { contextId: String(stored.contextId) } : {}),
    ...(stored.dataPart && typeof stored.dataPart === "object" ? { dataPart: stored.dataPart } : {}),
    ...(stored.dataPartMetadata && typeof stored.dataPartMetadata === "object"
      ? { dataPartMetadata: stored.dataPartMetadata }
      : {}),
  };
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

export function agentDailyRequestLimit(agent: { visibility?: unknown; maxDailyRequests?: unknown }): number {
  if (String(agent.visibility || "platform") === "personal") return 0;
  return Math.max(0, Number(agent.maxDailyRequests || 0));
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
  const healthReason = agentHealthRouteReason(agent);
  if (healthReason) return healthReason;
  const adapterProtocol = String(agent?.adapterProtocol || "").trim();
  if (!["a2a-v1", "agent-a2a-v1", "a2a-task-v1"].includes(adapterProtocol)) {
    return `暂不支持 ${adapterProtocol || "未配置"} adapter`;
  }
  const endpointConfig = parseJsonRecord(agent?.endpointConfigJson);
  if (endpointConfig.authRequired === true && !agent?.apiToken) return "缺少 Agent 凭据";
  return "";
}

function publicAgent(agent: any, usageCount = 0) {
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
    usageCount: Math.max(0, Number(usageCount || 0)),
    source: String(agent.visibility || "platform") === "personal" ? "personal" : "platform",
    executionMode: endpointConfig.executionMode || "async",
    interactionMode: endpointConfig.interactionMode === "session" ? "session" : "single",
    routeReady: !reason,
    readiness: reason ? "blocked" : "ready",
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

function stripArtifactInventory(text: string): string {
  const lines = text.split(/\r?\n/);
  const output: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\s*(?:#{1,4}\s*)?(?:已创建文件|生成文件|本轮产物|created files|artifacts)\s*[：:]?\s*$/i.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (!line.trim()) continue;
      if (/^\s*[-*]\s+(?:\[[^\]]+\]\([^)]+\)|`?[^`\s]+\.[A-Za-z0-9]{1,8}`?|(?:projects|artifacts|outputs?)\/\S+)/i.test(line)) {
        continue;
      }
      skipping = false;
    }
    if (/^\s*下载链接[^。\n]*[。.]?\s*$/.test(line)) continue;
    output.push(line);
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function cleanA2AText(text: string, options: { hasStructuredArtifacts?: boolean } = {}): string {
  const trimmed = String(text || "").trim();
  if (!trimmed) return trimmed;
  const finish = (value: string) => options.hasStructuredArtifacts ? stripArtifactInventory(value) : value;

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
  if (best) return finish(best);

  const lastToolResult = Math.max(trimmed.lastIndexOf("[tool_result"), trimmed.lastIndexOf("[tool_call]"));
  if (lastToolResult > 0) {
    const tail = trimmed.slice(lastToolResult);
    const firstHeading = tail.search(/(^|\n)#{1,3}\s+/);
    if (firstHeading >= 0) return finish(tail.slice(firstHeading).trim());
  }
  return finish(trimmed);
}

export function a2aConversationContextId(
  adoptId: unknown,
  agentId: unknown,
  conversationKey: unknown,
): string | undefined {
  const conversation = String(conversationKey || "").trim();
  if (!conversation) return undefined;
  const digest = createHash("sha256")
    .update(`${String(adoptId || "").trim()}\0${String(agentId || "").trim()}\0${conversation}`)
    .digest("hex")
    .slice(0, 32);
  return `ea-${digest}`;
}

export function a2aRuntimeContextId(
  endpointConfig: Record<string, unknown>,
  adoptId: unknown,
  agentId: unknown,
  conversationKey: unknown,
): string | undefined {
  if (endpointConfig.reuseConversationContext === false) return undefined;
  return a2aConversationContextId(adoptId, agentId, conversationKey);
}

async function runAgentTaskInBackground(
  taskId: string,
  agent: any,
  input: string,
  runtime: {
    contextId?: string;
    dataPart?: Record<string, unknown>;
    dataPartMetadata?: Record<string, unknown>;
  } = {},
) {
  const startedAt = Date.now();
  const finishMetric = beginOperationalActivity("expert_task");
  let metricOutcome: OperationalOutcome = "error";
  const controller = new AbortController();
  let progressWrites = Promise.resolve();
  activeAgentTaskControllers.set(taskId, controller);
  try {
    await updateActiveAgentTask(taskId, { status: "running" as AgentTaskStatus, startedAt: sql`CURRENT_TIMESTAMP`, errorMessage: null });
    const startingTask = await getAgentTask(taskId);
    if (String(startingTask?.status || "") !== "running") {
      metricOutcome = isCancelledAgentTaskStatus(startingTask?.status) ? "cancelled" : "error";
      return;
    }
    const adapterProtocol = String(agent.adapterProtocol || "").trim();
    if (!agent.apiUrl) throw new Error("Agent endpoint is not configured");
    if (!["a2a-v1", "agent-a2a-v1", "a2a-task-v1"].includes(adapterProtocol)) {
      throw new Error(`${adapterProtocol || "missing adapter"} is not supported by agent task runner`);
    }
    const endpointConfig = parseJsonRecord(agent.endpointConfigJson) as A2AEndpointConfig;
    const connection = {
      apiUrl: String(agent.apiUrl || ""),
      apiToken: agent.apiToken,
      endpointConfig,
    };
    const egress = await guardToolEgress({
      channel: "a2a",
      payload: { input, dataPart: runtime.dataPart },
      adoptId: String((agent as { __taskAdoptId?: unknown }).__taskAdoptId || "") || null,
      toolName: String(agent.id || "a2a_expert"),
      destinationUrl: connection.apiUrl,
      destinationTrust: String(agent.visibility || "platform") === "personal" ? "user" : "platform",
    });
    if (!egress.ok) throw new Error(egress.error || "专家任务未通过数据外发护栏");
    const result = await runA2AExpertTask(connection, input, {
      ...runtime,
      taskId: endpointConfig.supportsCancellation === true ? taskId : undefined,
      signal: controller.signal,
      onEvents: (events) => {
        const rawEventsJson = summarizeA2AEvents(events, endpointConfig, AGENT_TASK_RAW_EVENTS_LIMIT_BYTES);
        progressWrites = progressWrites
          .then(() => updateActiveAgentTask(taskId, { rawEventsJson }))
          .catch((error) => {
            console.warn("[AGENT-TASK] progress update failed", {
              taskId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      },
    });
    await progressWrites;
    if (["failed", "canceled", "cancelled"].includes(String(result.state || "").toLowerCase())) {
      throw new Error(String(result.text || "").trim() || `${String(agent.name || "专家")}任务执行失败`);
    }
    if (!String(result.text || "").trim() && !result.interaction) {
      throw new Error("A2A Agent did not return the configured result artifact");
    }
    const cleanedText = cleanA2AText(result.text, { hasStructuredArtifacts: Boolean(result.artifacts?.length) });
    const runtimeAgentId = String((agent as any).__runtimeAgentId || "").trim();
    const artifacts = runtimeAgentId && result.artifacts?.length
      ? await materializeA2AArtifacts({
          taskId,
          workspaceDir: resolveRuntimeWorkspaceByIds(String((agent as any).__taskAdoptId || ""), runtimeAgentId),
          connection,
          artifacts: result.artifacts,
        })
      : [];
    await updateActiveAgentTask(taskId, {
      status: "succeeded" as AgentTaskStatus,
      resultMarkdown: cleanedText ? truncateUtf8(cleanedText, AGENT_TASK_TEXT_LIMIT_BYTES) : null,
      remoteTaskId: result.remoteTaskId || null,
      rawEventsJson: summarizeA2AEvents(result.rawEvents || [], endpointConfig, AGENT_TASK_RAW_EVENTS_LIMIT_BYTES),
      artifactsJson: artifacts.length > 0 ? JSON.stringify(artifacts) : null,
      interactionJson: result.interaction ? JSON.stringify(result.interaction) : null,
      interactionStatus: result.interaction ? "pending" : null,
      completedAt: sql`CURRENT_TIMESTAMP`,
      errorMessage: null,
    });
    const completedTask = await getAgentTask(taskId);
    if (String(completedTask?.status || "") !== "succeeded") return;
    await markAgentTaskSucceeded(agent).catch(() => undefined);
    await insertCallLog({
      agentId: String(agent.id),
      userId: Number((agent as any).__taskUserId || 0) || undefined,
      adoptId: String((agent as any).__taskAdoptId || "") || undefined,
      status: "success",
      durationMs: Date.now() - startedAt,
    }).catch(() => undefined);
    metricOutcome = "success";
  } catch (error: any) {
    const timedOut = error?.name === "AbortError" || /abort|timeout/i.test(String(error?.message || ""));
    const cancelled = /cancelled|canceled/i.test(String(error?.message || ""));
    metricOutcome = cancelled ? "cancelled" : timedOut ? "timeout" : "error";
    const currentTask = await getAgentTask(taskId).catch(() => null);
    if (isCancelledAgentTaskStatus(currentTask?.status)) {
      metricOutcome = "cancelled";
      return;
    }
    const displayError = friendlyAgentTaskError(error, String(agent.name || "专家"));
    await updateActiveAgentTask(taskId, {
      status: "failed" as AgentTaskStatus,
      errorMessage: truncateUtf8(displayError, AGENT_TASK_ERROR_LIMIT_BYTES),
      completedAt: sql`CURRENT_TIMESTAMP`,
    });
    await markAgentTaskFailed(agent, error).catch(() => undefined);
    await insertCallLog({
      agentId: String(agent.id),
      userId: Number((agent as any).__taskUserId || 0) || undefined,
      adoptId: String((agent as any).__taskAdoptId || "") || undefined,
      status: timedOut ? "timeout" : "error",
      durationMs: Date.now() - startedAt,
      errorMessage: truncateUtf8(displayError, 2_000),
    }).catch(() => undefined);
  } finally {
    if (activeAgentTaskControllers.get(taskId) === controller) {
      activeAgentTaskControllers.delete(taskId);
    }
    finishMetric();
    observeOperationalActivity({
      activity: "expert_task",
      outcome: metricOutcome,
      durationMs: Date.now() - startedAt,
    });
  }
}

function startAgentTaskInBackground(
  taskId: string,
  agent: any,
  input: string,
  runtime: {
    contextId?: string;
    dataPart?: Record<string, unknown>;
    dataPartMetadata?: Record<string, unknown>;
  } = {},
): void {
  if (activeAgentTaskPromises.has(taskId)) return;
  const running = runAgentTaskInBackground(taskId, agent, input, runtime)
    .catch((error) => {
      console.error("[AGENT-TASK] background runner failed", {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      if (activeAgentTaskPromises.get(taskId) === running) {
        activeAgentTaskPromises.delete(taskId);
      }
    });
  activeAgentTaskPromises.set(taskId, running);
}

export async function startAgentTaskRuntime(): Promise<() => Promise<void>> {
  const recovered = await failInterruptedAgentTasks("服务重启前任务未完成，请重新提交");
  if (recovered > 0) {
    console.warn("[AGENT-TASK] recovered interrupted tasks", { count: recovered });
  }
  return async () => {
    for (const controller of activeAgentTaskControllers.values()) {
      controller.abort(new Error("server shutdown"));
    }
    const tasks = Array.from(activeAgentTaskPromises.values());
    if (tasks.length > 0) {
      await Promise.race([
        Promise.allSettled(tasks).then(() => undefined),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3_500);
          timer.unref();
        }),
      ]);
    }
    await failInterruptedAgentTasks("服务正在重启，任务已安全中止，请重新提交");
  };
}

export function registerAgentTaskRoutes(app: express.Express) {
  app.get("/api/claw/agents/available", async (req, res) => {
    const adoptId = String(req.query.adoptId || "").trim();
    if (!adoptId) return res.status(400).json({ error: "adoptId required" });
    const claw = await resolveClaw(req, res, adoptId);
    if (!claw) return;
    try {
      const clawRecord = claw as { userId?: unknown; roleTemplate?: unknown; agentId?: unknown };
      const userId = Number(clawRecord.userId || 0);
      const profileKeys = await requesterProfiles(userId);
      const visibleAgents = (await listEnabledBusinessAgentsForContext({ userId, adoptId }))
        .filter((agent) => isAgentIntegration(agent))
        .filter((agent) => profileAllowed(agent, profileKeys))
        .filter((agent) => roleAllowed(agent, clawRecord.roleTemplate));
      const usageCounts = await listAgentTaskCounts(adoptId, visibleAgents.map((agent) => String(agent.id)));
      const agents = visibleAgents.map((agent) => publicAgent(agent, usageCounts[String(agent.id)] || 0));
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
      res.json({ tasks: tasks.map(publicAgentTask) });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "TASKS_UNAVAILABLE" });
    }
  });

  app.post("/api/claw/agent-tasks/:taskId/cancel", async (req, res) => {
    const adoptId = String(req.body?.adoptId || "").trim();
    const taskId = String(req.params.taskId || "").trim();
    if (!adoptId) return res.status(400).json({ error: "adoptId required" });
    if (!/^agt_[A-Za-z0-9]{8,64}$/.test(taskId)) return res.status(400).json({ error: "taskId invalid" });
    const claw = await resolveClaw(req, res, adoptId);
    if (!claw) return;

    try {
      const clawRecord = claw as { userId?: unknown; roleTemplate?: unknown; agentId?: unknown };
      const userId = Number(clawRecord.userId || 0);
      const task = await getAgentTask(taskId);
      if (!task || String(task.adoptId || "") !== adoptId || Number(task.userId || 0) !== userId) {
        return res.status(404).json({ error: "专家任务不存在" });
      }
      if (!["pending", "running"].includes(String(task.status || ""))) {
        return res.status(409).json({ error: "该任务已结束，无法取消" });
      }
      const agent = await getBusinessAgentForContext(String(task.agentId || ""), { userId, adoptId });
      if (!agent || !isAgentIntegration(agent)) {
        return res.status(404).json({ error: "专家配置不存在" });
      }
      const endpointConfig = parseJsonRecord(agent.endpointConfigJson) as A2AEndpointConfig;
      const contextId = a2aRuntimeContextId(
        endpointConfig,
        adoptId,
        task.agentId,
        task.sourceConversationId || task.sourceSessionId,
      );

      await updateActiveAgentTask(taskId, {
        status: "cancelled" as AgentTaskStatus,
        errorMessage: null,
        completedAt: sql`CURRENT_TIMESTAMP`,
      });
      const controller = activeAgentTaskControllers.get(taskId);
      const remoteCancellation = endpointConfig.supportsCancellation === true && agent.apiUrl
        ? cancelA2AExpertTask({
            apiUrl: String(agent.apiUrl),
            apiToken: agent.apiToken,
            endpointConfig,
          }, { contextId, taskId }).catch((error) => {
            console.warn("[AGENT-TASK] remote cancellation failed", {
              taskId,
              agentId: agent.id,
              error: error instanceof Error ? error.message : String(error),
            });
            return false;
          })
        : Promise.resolve(false);
      controller?.abort(new Error("agent task cancelled"));
      const remoteCancelled = await remoteCancellation;
      res.json({ ok: true, taskId, status: "cancelled", remoteCancelled });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "TASK_CANCEL_FAILED" });
    }
  });

  app.post("/api/claw/agent-tasks/:taskId/retry", async (req, res) => {
    const adoptId = String(req.body?.adoptId || "").trim();
    const taskId = String(req.params.taskId || "").trim();
    if (!agentTaskRetryEnabled()) return res.status(404).json({ error: "专家任务重试未启用" });
    if (!adoptId) return res.status(400).json({ error: "adoptId required" });
    if (!/^agt_[A-Za-z0-9]{8,64}$/.test(taskId)) return res.status(400).json({ error: "taskId invalid" });
    const claw = await resolveClaw(req, res, adoptId);
    if (!claw) return;

    try {
      const clawRecord = claw as { userId?: unknown; roleTemplate?: unknown; agentId?: unknown };
      const userId = Number(clawRecord.userId || 0);
      const task = await getAgentTask(taskId);
      if (!task || String(task.adoptId || "") !== adoptId || Number(task.userId || 0) !== userId) {
        observeAgentTaskRetry("blocked");
        return res.status(404).json({ error: "专家任务不存在" });
      }
      if (!canRetryAgentTask({ status: task.status, interactionStatus: task.interactionStatus })) {
        observeAgentTaskRetry("blocked");
        return res.status(409).json({ error: "该任务当前不能重试" });
      }
      const profileKeys = await requesterProfiles(userId);
      const agent = await getBusinessAgentForContext(String(task.agentId || ""), { userId, adoptId });
      if (!agent || !isAgentIntegration(agent) || !profileAllowed(agent, profileKeys) || !roleAllowed(agent, clawRecord.roleTemplate)) {
        observeAgentTaskRetry("blocked");
        return res.status(403).json({ error: "AGENT_NOT_ALLOWED" });
      }
      const reason = routeReason(agent);
      if (reason) {
        observeCapabilityPreflight({ kind: "expert", outcome: "blocked" });
        observeAgentTaskRetry("blocked");
        return res.status(409).json({ error: reason });
      }
      await ensureAgentAvailable(agent);
      observeCapabilityPreflight({ kind: "expert", outcome: "ready" });

      const endpointConfig = parseJsonRecord(agent.endpointConfigJson);
      const maxConcurrent = Math.max(0, Math.min(100, Number(endpointConfig.maxConcurrent || 0)));
      const runtime = storedAgentTaskRuntime(task);
      if (!runtime.input.trim()) {
        observeAgentTaskRetry("blocked");
        return res.status(409).json({ error: "原任务缺少可重试的输入" });
      }
      const retryId = `agt_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const retryRecord = {
        id: retryId,
        parentTaskId: task.id,
        adoptId,
        userId,
        agentId: task.agentId,
        sourceConversationId: task.sourceConversationId || null,
        sourceSessionId: task.sourceSessionId || null,
        sourceMessageId: `retry:${task.id}`.slice(0, 128),
        status: "pending" as AgentTaskStatus,
        input: task.input,
        requestContextJson: JSON.stringify(runtime),
        adapterProtocol: String(agent.adapterProtocol || task.adapterProtocol || ""),
      };
      const reservation = await reserveAgentTask(retryRecord as Parameters<typeof reserveAgentTask>[0], {
        maxConcurrent,
        maxDailyRequests: 0,
        dayStartedAt: new Date(0),
      });
      if (reservation.kind === "existing") {
        observeAgentTaskRetry("created");
        return res.json({
          taskId: reservation.task.id,
          reused: true,
          task: publicAgentTask({ ...reservation.task, agentName: agent.name, agent: publicAgent(agent) }),
        });
      }
      if (reservation.kind === "concurrency_exceeded") {
        observeAgentTaskRetry("blocked");
        return res.status(429).json({ error: "专家当前任务较多，请稍后重试" });
      }
      if (reservation.kind !== "created") {
        observeAgentTaskRetry("blocked");
        return res.status(429).json({ error: "专家当前无法重试" });
      }

      const publicTask = publicAgentTask({
        ...retryRecord,
        agentName: agent.name,
        createdAt: new Date().toISOString(),
        agent: publicAgent(agent),
      });
      res.json({ taskId: retryId, reused: false, task: publicTask });
      observeAgentTaskRetry("created");
      startAgentTaskInBackground(retryId, {
        ...agent,
        __taskUserId: userId,
        __taskAdoptId: adoptId,
        __runtimeAgentId: String(clawRecord.agentId || ""),
      }, runtime.input, runtime);
    } catch (error: unknown) {
      observeAgentTaskRetry("error");
      if (error instanceof AgentUnavailableError) {
        observeCapabilityPreflight({ kind: "expert", outcome: "blocked" });
        return res.status(error.httpStatus).json({ error: error.message, code: error.code });
      }
      res.status(500).json({ error: error instanceof Error ? error.message : "TASK_RETRY_FAILED" });
    }
  });

  app.post("/api/claw/agent-tasks/submit", async (req, res) => {
    const adoptId = String(req.body?.adoptId || "").trim();
    const agentId = String(req.body?.agentId || "").trim();
    const input = String(req.body?.task || req.body?.input || "").trim();
    const scenarioId = String(req.body?.scenarioId || "").trim();
    if (!adoptId) return res.status(400).json({ error: "adoptId required" });
    if (!agentId) return res.status(400).json({ error: "agentId required" });
    if (!input) return res.status(400).json({ error: "task required" });
    if (scenarioId && !["comprehensive", "comparison", "earnings_review"].includes(scenarioId)) {
      return res.status(400).json({ error: "scenarioId invalid" });
    }
    const claw = await resolveClaw(req, res, adoptId);
    if (!claw) return;

    try {
      const userId = Number((claw as any).userId || 0);
      const profileKeys = await requesterProfiles(userId);
      const agent = await getBusinessAgentForContext(agentId, { userId, adoptId });
      if (!agent || !isAgentIntegration(agent) || !profileAllowed(agent, profileKeys) || !roleAllowed(agent, (claw as any).roleTemplate)) {
        return res.status(403).json({ error: "AGENT_NOT_ALLOWED" });
      }
      const reason = routeReason(agent);
      if (reason) {
        observeCapabilityPreflight({ kind: "expert", outcome: "blocked" });
        return res.status(409).json({ error: reason });
      }

      const sourceMessageId = req.body?.sourceMessageId ? String(req.body.sourceMessageId).slice(0, 128) : "";
      const endpointConfig = parseJsonRecord(agent.endpointConfigJson);
      const maxConcurrent = Math.max(0, Math.min(100, Number(endpointConfig.maxConcurrent || 0)));
      const maxDailyRequests = agentDailyRequestLimit(agent);
      await ensureAgentAvailable(agent);
      observeCapabilityPreflight({ kind: "expert", outcome: "ready" });

      const taskId = `agt_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const taskUserId = Number((claw as any).userId || 0);
      const sourceConversationId = req.body?.conversationId
        ? String(req.body.conversationId).slice(0, 128)
        : null;
      const sourceSessionId = req.body?.sessionId
        ? String(req.body.sessionId).slice(0, 160)
        : null;
      const runtime = {
        contextId: a2aRuntimeContextId(
          endpointConfig,
          adoptId,
          agentId,
          sourceConversationId || sourceSessionId,
        ),
        ...(scenarioId && agentId === "a-share-research-committee" ? {
          dataPart: {
            schema: "ea.investment-team.request.v1",
            scenarioId,
          },
          dataPartMetadata: { "ea.investment-team": true, version: "1.0.0" },
        } : {}),
      };
      const taskRecord = {
        id: taskId,
        adoptId,
        userId: taskUserId,
        agentId,
        sourceConversationId,
        sourceSessionId,
        sourceMessageId: sourceMessageId || null,
        status: "pending",
        input,
        requestContextJson: JSON.stringify({ input, ...runtime }),
        adapterProtocol: String(agent.adapterProtocol || ""),
      } as any;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const reservation = await reserveAgentTask(taskRecord, {
        maxConcurrent,
        maxDailyRequests,
        dayStartedAt: today,
      });
      if (reservation.kind === "existing") {
        return res.json({
          taskId: reservation.task.id,
          reused: true,
          task: publicAgentTask({ ...reservation.task, agent: publicAgent(agent), agentName: agent.name }),
        });
      }
      if (reservation.kind === "concurrency_exceeded") {
        return res.status(429).json({ error: "专家当前任务较多，请稍后重试" });
      }
      if (reservation.kind === "daily_exceeded") {
        return res.status(429).json({ error: "专家今日调用额度已用完" });
      }

      const publicPayload = publicAgent(agent);
      res.json({
        taskId,
        reused: false,
        task: publicAgentTask({
          id: taskId,
          adoptId,
          agentId,
          agentName: agent.name,
          status: "pending",
          input,
          adapterProtocol: String(agent.adapterProtocol || ""),
          createdAt: new Date().toISOString(),
          agent: publicPayload,
        }),
      });
      startAgentTaskInBackground(taskId, {
        ...agent,
        __taskUserId: taskUserId,
        __taskAdoptId: adoptId,
        __runtimeAgentId: String((claw as any).agentId || ""),
      }, input, runtime);
    } catch (error: any) {
      if (error instanceof AgentUnavailableError) {
        observeCapabilityPreflight({ kind: "expert", outcome: "blocked" });
        return res.status(error.httpStatus).json({ error: error.message, code: error.code });
      }
      res.status(500).json({ error: error?.message || "TASK_SUBMIT_FAILED" });
    }
  });

  app.post("/api/claw/agent-tasks/:taskId/respond", async (req, res) => {
    const adoptId = String(req.body?.adoptId || "").trim();
    const taskId = String(req.params.taskId || "").trim();
    if (!adoptId) return res.status(400).json({ error: "adoptId required" });
    if (!/^agt_[A-Za-z0-9]{8,64}$/.test(taskId)) return res.status(400).json({ error: "taskId invalid" });
    const claw = await resolveClaw(req, res, adoptId);
    if (!claw) return;

    try {
      const userId = Number((claw as any).userId || 0);
      const sourceMessageId = String(req.body?.sourceMessageId || "").trim().slice(0, 128);
      const sourceTask = await getAgentTask(taskId);
      if (!sourceTask || sourceTask.adoptId !== adoptId || Number(sourceTask.userId) !== userId) {
        return res.status(404).json({ error: "待确认任务不存在" });
      }
      if (sourceMessageId) {
        const existing = await getAgentTaskBySourceMessage(adoptId, String(sourceTask.agentId || ""), sourceMessageId);
        if (existing && String(existing.parentTaskId || "") === taskId && Number(existing.userId) === userId) {
          const existingAgent = await getBusinessAgentForContext(String(existing.agentId || ""), { userId, adoptId });
          return res.json({
            taskId: existing.id,
            reused: true,
            task: publicAgentTask({ ...existing, agentName: existingAgent?.name || existing.agentId }),
          });
        }
      }
      const interaction = parseAgentInteraction(parseJsonRecord(sourceTask.interactionJson));
      if (!interaction || sourceTask.interactionStatus !== "pending") {
        return res.status(409).json({ error: "该确认已处理或不再有效" });
      }
      const responseValue = parseAgentInteractionResponse(req.body?.response, interaction);
      if (!responseValue) return res.status(400).json({ error: "请选择有效选项或填写自定义回答" });

      const profileKeys = await requesterProfiles(userId);
      const agent = await getBusinessAgentForContext(String(sourceTask.agentId || ""), { userId, adoptId });
      if (!agent || !isAgentIntegration(agent) || !profileAllowed(agent, profileKeys) || !roleAllowed(agent, (claw as any).roleTemplate)) {
        return res.status(403).json({ error: "AGENT_NOT_ALLOWED" });
      }
      const reason = routeReason(agent);
      if (reason) return res.status(409).json({ error: reason });

      const endpointConfig = parseJsonRecord(agent.endpointConfigJson);
      const maxConcurrent = Math.max(0, Math.min(100, Number(endpointConfig.maxConcurrent || 0)));

      await ensureAgentAvailable(agent);

      const responseText = agentInteractionResponseText(interaction, responseValue);
      const remoteInput = agentInteractionAgentInput(interaction, responseValue);
      const continuationId = `agt_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const continuationRuntime = {
        contextId: a2aRuntimeContextId(
          endpointConfig,
          adoptId,
          sourceTask.agentId,
          sourceTask.sourceConversationId || sourceTask.sourceSessionId,
        ),
        dataPart: {
          schema: EA_INTERACTION_SCHEMA,
          kind: "response",
          response: responseValue,
        },
        dataPartMetadata: { "ea.interaction": true, version: "1.0.0" },
      };
      const continuation = {
        id: continuationId,
        parentTaskId: sourceTask.id,
        adoptId,
        userId,
        agentId: sourceTask.agentId,
        sourceConversationId: sourceTask.sourceConversationId || null,
        sourceSessionId: sourceTask.sourceSessionId || null,
        sourceMessageId: sourceMessageId || null,
        status: "pending" as AgentTaskStatus,
        input: responseText,
        requestContextJson: JSON.stringify({ input: remoteInput, ...continuationRuntime }),
        adapterProtocol: String(agent.adapterProtocol || ""),
      };
      const claimed = await answerAgentTaskInteractionAndCreate(
        taskId,
        { userId, adoptId },
        JSON.stringify(responseValue),
        continuation as any,
        { maxConcurrent },
      );
      if (claimed === "concurrency_exceeded") {
        return res.status(429).json({ error: "专家当前任务较多，请稍后重试" });
      }
      if (claimed !== "created") return res.status(409).json({ error: "该确认已被处理，请刷新会话" });

      const publicPayload = publicAgent(agent);
      res.json({
        taskId: continuationId,
        reused: false,
        displayText: responseText,
        task: publicAgentTask({
          ...continuation,
          agentName: agent.name,
          createdAt: new Date().toISOString(),
          agent: publicPayload,
        }),
      });
      startAgentTaskInBackground(continuationId, {
        ...agent,
        __taskUserId: userId,
        __taskAdoptId: adoptId,
        __runtimeAgentId: String((claw as any).agentId || ""),
      }, remoteInput, continuationRuntime);
    } catch (error: any) {
      if (error instanceof AgentUnavailableError) {
        return res.status(error.httpStatus).json({ error: error.message, code: error.code });
      }
      res.status(500).json({ error: error?.message || "TASK_RESPONSE_FAILED" });
    }
  });
}
