import express from "express";
import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { isAuthorizedInternalRequest, requireClawOwner } from "./helpers";
import { readSafeAgentResponseText, safeAgentRequest } from "./safe-agent-http";
import {
  createAgentTask,
  getBusinessAgent,
  listAgentTasks,
  listEnabledBusinessAgents,
  updateAgentTask,
} from "../db/agents";

type AgentTaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

type AgentEndpointConfig = {
  path?: string;
  rpcPath?: string;
  stream?: boolean;
  method?: string;
  timeoutMs?: number;
  taskPrefix?: string;
  taskSuffix?: string;
  [key: string]: any;
};

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
    adapterProtocol === "agent-a2a-v1" ||
    adapterProtocol === "a2a-task-v1" ||
    capabilities.includes("agent") ||
    capabilities.includes("async-agent")
  );
}

function routeReason(agent: any) {
  if (!agent?.apiUrl) return "缺少 Agent endpoint";
  const adapterProtocol = String(agent?.adapterProtocol || "").trim();
  if (!["agent-a2a-v1", "a2a-task-v1"].includes(adapterProtocol)) {
    return `暂不支持 ${adapterProtocol || "未配置"} adapter`;
  }
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

function endpoint(baseUrl: string, pathValue?: string) {
  if (!pathValue) return baseUrl;
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const path = String(pathValue || "").replace(/^\//, "");
  return new URL(path, base).toString();
}

function authHeaders(token?: string | null) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function extractA2AText(value: any): string {
  const texts: string[] = [];
  const artifactTexts: string[] = [];
  const compactText = (text: string) => text.replace(/\s+/g, "");
  const collectPartsText = (parts: any[]) => parts
    .map((part) => ((part?.kind === "text" || part?.type === "text") && typeof part?.text === "string") ? part.text : "")
    .filter(Boolean);
  const visit = (node: any) => {
    if (!node) return;
    if (typeof node === "string") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object") return;
    if (Array.isArray(node.parts)) {
      const partTexts = collectPartsText(node.parts);
      if (partTexts.length > 0 && (node.artifactId || node.artifact_id || node.kind === "artifact")) {
        const last = partTexts[partTexts.length - 1] || "";
        const previousJoined = partTexts.slice(0, -1).join("");
        artifactTexts.push(last && previousJoined && compactText(last) === compactText(previousJoined) ? last : partTexts.join(""));
        return;
      }
    }
    if ((node.kind === "text" || node.type === "text") && typeof node.text === "string") {
      texts.push(node.text);
      return;
    }
    if (Array.isArray(node.parts)) visit(node.parts);
    if (Array.isArray(node.artifacts)) visit(node.artifacts);
    if (node.artifact) visit(node.artifact);
    if (node.message) visit(node.message);
    if (node.status?.message) visit(node.status.message);
    if (node.result) visit(node.result);
  };
  visit(value);
  if (artifactTexts.length > 0) {
    return artifactTexts[artifactTexts.length - 1].trim();
  }
  return texts.join("\n").trim();
}

function extractA2AResult(events: any[]): { text: string; remoteTaskId?: string } {
  const responseArtifacts = new Map<string, string>();
  let remoteTaskId = "";

  for (const event of events) {
    const result = event?.result ?? event;
    if (!result || typeof result !== "object") continue;
    remoteTaskId = String(result.taskId || result.id || result.contextId || remoteTaskId || "").trim();

    const artifact = result.artifact || result.result?.artifact;
    if (!artifact || typeof artifact !== "object") continue;
    const artifactId = String(artifact.artifactId || artifact.artifact_id || artifact.name || "response");
    const artifactName = String(artifact.name || artifactId).toLowerCase();
    const partText = extractA2AText(artifact);
    if (!partText) continue;

    // JiuwenSwarm A2A sends response artifact snapshots. Keeping the latest
    // response artifact avoids concatenating every intermediate chunk/tool trace.
    if (artifactName === "response" || artifactId.includes("_response")) {
      responseArtifacts.set(artifactId, partText);
    }
  }

  const responseText = Array.from(responseArtifacts.values()).at(-1)?.trim();
  if (responseText) return { text: responseText, remoteTaskId: remoteTaskId || undefined };

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const result = events[i]?.result ?? events[i];
    const text = extractA2AText(result);
    if (text) return { text, remoteTaskId: remoteTaskId || undefined };
  }

  const last = events[events.length - 1]?.result ?? events[events.length - 1] ?? {};
  return { text: JSON.stringify(last || {}, null, 2), remoteTaskId: remoteTaskId || undefined };
}

function summarizeA2AEvents(events: any[]) {
  const compact = events.slice(-20).map((event) => {
    const result = event?.result ?? event;
    if (!result || typeof result !== "object") return event;
    const artifact = result.artifact;
    return {
      id: event?.id,
      kind: result.kind,
      taskId: result.taskId || result.id,
      contextId: result.contextId,
      final: result.final,
      state: result.status?.state,
      artifact: artifact ? {
        artifactId: artifact.artifactId || artifact.artifact_id,
        name: artifact.name,
        textBytes: Buffer.byteLength(extractA2AText(artifact), "utf8"),
      } : undefined,
    };
  });
  return truncateUtf8(JSON.stringify(compact), AGENT_TASK_RAW_EVENTS_LIMIT_BYTES);
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

function parseA2AEvents(raw: string): any[] {
  const events: any[] = [];
  const blocks = raw.includes("\n\n") ? raw.split(/\n\n+/) : [raw];
  for (const block of blocks) {
    const data = block
      .split(/\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== "[DONE]")
      .join("\n");
    if (!data) continue;
    try {
      events.push(JSON.parse(data));
    } catch {}
  }
  if (events.length === 0) {
    try {
      events.push(JSON.parse(raw || "{}"));
    } catch {}
  }
  return events;
}

function parseA2ADataBlock(block: string): any[] {
  const events: any[] = [];
  const data = block
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .join("\n");
  if (!data) return events;
  try {
    events.push(JSON.parse(data));
  } catch {}
  return events;
}

function isA2ACompleteEvent(event: any): boolean {
  const result = event?.result ?? event;
  if (!result || typeof result !== "object") return false;
  const state = String(result.status?.state || result.state || "").toLowerCase();
  if (["completed", "succeeded", "failed", "canceled", "cancelled"].includes(state)) return true;
  if (result.final === true || result.done === true || result.completed === true) return true;
  const kind = String(result.kind || result.type || "").toLowerCase();
  return kind.includes("complete") || kind.includes("completed");
}

async function runA2ATask(agent: any, input: string): Promise<{ text: string; remoteTaskId?: string; rawEvents: any[] }> {
  const endpointConfig = parseJsonRecord(agent.endpointConfigJson) as AgentEndpointConfig;
  const rpcUrl = endpoint(String(agent.apiUrl || ""), endpointConfig.rpcPath ?? endpointConfig.path ?? "");
  const method = String(endpointConfig.method || (endpointConfig.stream === true ? "message/stream" : "message/send"));
  const taskText = [
    String(endpointConfig.taskPrefix || "").trim(),
    input,
    String(endpointConfig.taskSuffix || "").trim(),
  ].filter(Boolean).join("\n\n");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(5000, Math.min(30 * 60_000, Number(endpointConfig.timeoutMs || 10 * 60_000))));
  try {
    const body = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params: {
        message: {
          role: "user",
          messageId: randomUUID(),
          parts: [{ kind: "text", text: taskText }],
        },
      },
    };
    const response = await safeAgentRequest(rpcUrl, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...authHeaders(agent.apiToken),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      timeoutMs: Math.max(5000, Math.min(30 * 60_000, Number(endpointConfig.timeoutMs || 10 * 60_000))),
    });
    if (response.status < 200 || response.status >= 300) {
      const raw = await readSafeAgentResponseText(response).catch(() => "");
      throw new Error(`A2A HTTP ${response.status}: ${raw.slice(0, 300)}`);
    }
    const contentType = String(response.headers["content-type"] || "").toLowerCase();
    if (!contentType.includes("text/event-stream")) {
      const raw = await readSafeAgentResponseText(response);
      const events = parseA2AEvents(raw);
      const result = extractA2AResult(events);
      return { text: result.text, remoteTaskId: result.remoteTaskId, rawEvents: events.slice(-20) };
    }

    const decoder = new TextDecoder();
    const events: any[] = [];
    let buffer = "";
    let lastText = "";
    let lastRemoteTaskId = "";
    let responseBytes = 0;
    for await (const chunk of response.body) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      responseBytes += value.length;
      if (responseBytes > 16 * 1024 * 1024) {
        response.body.destroy(new Error("Agent endpoint response is too large"));
        throw new Error("Agent endpoint response is too large");
      }
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        const parsedEvents = parseA2ADataBlock(block);
        for (const event of parsedEvents) {
          events.push(event);
          const partial = extractA2AResult(events);
          if (partial.text) lastText = partial.text;
          if (partial.remoteTaskId) lastRemoteTaskId = partial.remoteTaskId;
          if (isA2ACompleteEvent(event) && lastText) {
            response.body.destroy();
            return { text: lastText, remoteTaskId: lastRemoteTaskId || partial.remoteTaskId, rawEvents: events.slice(-20) };
          }
        }
      }
    }
    if (buffer.trim()) {
      for (const event of parseA2ADataBlock(buffer)) events.push(event);
    }
    const result = extractA2AResult(events);
    return { text: result.text, remoteTaskId: result.remoteTaskId, rawEvents: events.slice(-20) };
  } finally {
    clearTimeout(timeout);
  }
}

async function runAgentTaskInBackground(taskId: string, agent: any, input: string) {
  await updateAgentTask(taskId, { status: "running" as AgentTaskStatus, startedAt: sql`CURRENT_TIMESTAMP`, errorMessage: null });
  try {
    const adapterProtocol = String(agent.adapterProtocol || "").trim();
    if (!agent.apiUrl) throw new Error("Agent endpoint is not configured");
    if (!["agent-a2a-v1", "a2a-task-v1"].includes(adapterProtocol)) {
      throw new Error(`${adapterProtocol || "missing adapter"} is not supported by agent task runner`);
    }
    const result = await runA2ATask(agent, input);
    const cleanedText = cleanA2AText(result.text);
    await updateAgentTask(taskId, {
      status: "succeeded" as AgentTaskStatus,
      resultMarkdown: truncateUtf8(cleanedText, AGENT_TASK_TEXT_LIMIT_BYTES),
      remoteTaskId: result.remoteTaskId || null,
      rawEventsJson: summarizeA2AEvents(result.rawEvents || []),
      completedAt: sql`CURRENT_TIMESTAMP`,
      errorMessage: null,
    });
  } catch (error: any) {
    await updateAgentTask(taskId, {
      status: "failed" as AgentTaskStatus,
      errorMessage: truncateUtf8(error?.message || String(error), AGENT_TASK_ERROR_LIMIT_BYTES),
      completedAt: sql`CURRENT_TIMESTAMP`,
    });
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
      const tasks = await listAgentTasks(adoptId, Number(req.query.limit || 30));
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

      const taskId = `agt_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      await createAgentTask({
        id: taskId,
        adoptId,
        userId: Number((claw as any).userId || 0),
        agentId,
        sourceConversationId: req.body?.conversationId ? String(req.body.conversationId).slice(0, 128) : null,
        sourceSessionId: req.body?.sessionId ? String(req.body.sessionId).slice(0, 160) : null,
        sourceMessageId: req.body?.sourceMessageId ? String(req.body.sourceMessageId).slice(0, 128) : null,
        status: "pending",
        input,
        adapterProtocol: String(agent.adapterProtocol || ""),
      } as any);

      const publicPayload = publicAgent(agent);
      res.json({ taskId, task: { id: taskId, status: "pending", agent: publicPayload } });
      void runAgentTaskInBackground(taskId, agent, input).catch((error) => {
        console.error("[AGENT-TASK] background runner failed", { taskId, error: error?.message || error });
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "TASK_SUBMIT_FAILED" });
    }
  });
}
