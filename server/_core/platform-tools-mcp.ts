import type { Express, Request, Response } from "express";
import { isAuthorizedInternalRequest } from "./helpers";

const SERVICE_NAME = "platform-tools";
const SERVICE_VERSION = "1.0.0";

const TOOLS = [
  {
    name: "create_scheduled_task",
    description: "Create a recurring scheduled task for reminders, periodic checks, or automated reports. Results should be tracked in the EA schedule task record unless the user explicitly asks for another delivery channel.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short task name" },
        message: { type: "string", description: "Instruction to execute on each run" },
        cron_expr: { type: "string", description: "Cron expression, for example '30 10 * * *' for daily 10:30" },
        delivery_channel: { type: "string", enum: ["conversation", "weixin", "wecom", "feishu", "webhook"], description: "Where to deliver results" },
      },
      required: ["name", "message", "cron_expr"],
    },
  },
  {
    name: "get_user_channels",
    description: "Check connected notification channels for the current EA employee agent before sending notifications or creating delivered scheduled tasks.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_available_agents",
    description: "List external business Agents available to the current EA employee agent. Use when the user asks which external Agents are available.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "submit_agent_task",
    description: [
      "Submit an asynchronous task to an external specialized Agent.",
      "Use this for long-running or complete specialist work, for example full enterprise risk assessment, batch due diligence, formal risk reports, or when the user explicitly asks to call 风控 Agent.",
      "For lightweight data lookup, field verification, single risk-factor checks, or short explanations, prefer local skills/MCP tools instead of this asynchronous Agent.",
      "The result is tracked by EA and written back asynchronously.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent id returned by list_available_agents" },
        task: { type: "string", description: "Detailed task instruction for the external Agent" },
        conversation_id: { type: "string", description: "Optional current EA conversation id" },
        session_id: { type: "string", description: "Optional current JiuwenSwarm session id" },
        source_message_id: { type: "string", description: "Optional source message id" },
      },
      required: ["agent_id", "task"],
    },
  },
];

function ok(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function err(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function hasRequestId(id: unknown): boolean {
  return id !== undefined && id !== null;
}

function textResult(text: string, extra: Record<string, unknown> = {}) {
  return { content: [{ type: "text", text }], ...extra };
}

function isAuthorized(req: Request): boolean {
  return isAuthorizedInternalRequest(req);
}

function pickHeader(req: Request, names: string[]): string {
  for (const name of names) {
    const value = req.headers[name.toLowerCase()];
    if (Array.isArray(value)) {
      const first = String(value[0] || "").trim();
      if (first) return first;
    } else {
      const text = String(value || "").trim();
      if (text) return text;
    }
  }
  return "";
}

function resolveAdoptId(req: Request, args: Record<string, unknown>): string {
  return String(
    args.adoptId
      || args.adopt_id
      || pickHeader(req, [
        "x-agent-adopt-id",
        "x-workforce-agent-adopt-id",
        "x-lingxia-adopt-id",
        "x-linggan-adopt-id",
        "x-jiuwen-channel-id",
        "x-openclaw-channel-id",
        "x-linggan-channel-id",
      ])
      || "",
  ).trim();
}

async function internalJson(path: string, init: RequestInit = {}) {
  const base = process.env.INTERNAL_BASE_URL || process.env.WORKFORCE_AGENT_INTERNAL_BASE_URL || process.env.LINGXIA_INTERNAL_BASE_URL || "http://127.0.0.1:5180";
  const headers = new Headers(init.headers || {});
  headers.set("X-Internal-Key", process.env.INTERNAL_API_KEY || "");
  const resp = await fetch(`${base}${path}`, { ...init, headers });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(String((data as any)?.error || resp.status));
  return data;
}

function summarizeAgents(data: any): string {
  const agents = Array.isArray(data?.agents) ? data.agents : [];
  if (agents.length === 0) return "No external Agents are available for this employee agent.";
  const lines = agents.map((agent: any) => {
    const ready = agent.routeReady ? "ready" : `not ready: ${agent.reason || "unknown"}`;
    const capabilities = Array.isArray(agent.capabilities) && agent.capabilities.length
      ? ` capabilities=${agent.capabilities.join(",")}`
      : "";
    const description = String(agent.description || "").trim();
    return `- ${agent.id}: ${agent.name} (${ready}; protocol=${agent.adapterProtocol || "unknown"}${capabilities})${description ? ` ${description}` : ""}`;
  });
  return [
    "Available external Agents:",
    ...lines,
    "",
    "Selection rule: use local skills/MCP for lightweight lookup, verification, or short explanations; use an external Agent for complete specialist analysis, batch work, formal reports, long-running tasks, or explicit user requests to call that Agent.",
  ].join("\n");
}

async function callTool(req: Request, name: string, args: Record<string, unknown>) {
  const adoptId = resolveAdoptId(req, args);
  if (!adoptId) return textResult("Error: adoptId is missing from JiuwenSwarm user context.", { isError: true });

  if (name === "get_user_channels") {
    const channels = ["conversation"];
    try {
      const wxData: any = await internalJson(`/api/claw/weixin/status?adoptId=${encodeURIComponent(adoptId)}`);
      if (wxData?.bound) channels.push("weixin");
    } catch {}
    try {
      const notifyData: any = await internalJson(`/api/claw/notify/config?adoptId=${encodeURIComponent(adoptId)}`);
      const cfg = notifyData?.config || {};
      if (cfg.wecom?.enabled) channels.push("wecom");
      if (cfg.feishu?.enabled) channels.push("feishu");
      if (cfg.webhook?.enabled) channels.push("webhook");
    } catch {}
    return textResult(`Available channels: ${channels.join(", ")}`);
  }

  if (name === "list_available_agents") {
    const data = await internalJson(`/api/claw/agents/available?adoptId=${encodeURIComponent(adoptId)}`);
    return textResult(summarizeAgents(data));
  }

  if (name === "submit_agent_task") {
    const agentId = String(args.agent_id || args.agentId || "").trim();
    const task = String(args.task || args.message || "").trim();
    if (!agentId) return textResult("Error: agent_id is required", { isError: true });
    if (!task) return textResult("Error: task is required", { isError: true });
    const data: any = await internalJson("/api/claw/agent-tasks/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        adoptId,
        agentId,
        task,
        conversationId: args.conversation_id || args.conversationId,
        sessionId: args.session_id || args.sessionId,
        sourceMessageId: args.source_message_id || args.sourceMessageId,
      }),
    });
    return textResult(`Agent task submitted. task_id=${data.taskId}. EA will track the asynchronous result and write it back when complete.`);
  }

  if (name === "create_scheduled_task") {
    const cronExpr = String(args.cron_expr || args.cronExpr || "0 9 * * *").trim();
    const deliveryChannel = String(args.delivery_channel || args.deliveryChannel || "conversation").trim();
    const channelId = deliveryChannel === "conversation" ? "web" : deliveryChannel === "weixin" ? "wechat" : deliveryChannel;
    const job = {
      name: String(args.name || "scheduled task"),
      description: String(args.message || "").slice(0, 100),
      enabled: true,
      schedule: { kind: "cron", expr: cronExpr },
      payload: { kind: "agentTurn", message: String(args.message || "") },
      sessionTarget: "isolated",
      delivery: {
        targets: [{
          channelId,
          channelLabel: channelId === "web" ? "定时任务记录" : channelId,
        }],
      },
      meta: {},
    };
    await internalJson("/api/claw/cron/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adoptId, job }),
    });
    return textResult(`Scheduled task "${job.name}" created. Cron: ${cronExpr}, delivery: ${deliveryChannel}.`);
  }

  return textResult(`Unknown tool: ${name}`, { isError: true });
}

async function handleMessage(req: Request, msg: any) {
  if (!msg || typeof msg !== "object") return null;
  const id = msg.id;
  try {
    if (msg.method === "notifications/initialized") return null;
    if (msg.method === "initialize") {
      if (!hasRequestId(id)) return null;
      return ok(id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: SERVICE_NAME, version: SERVICE_VERSION },
        instructions: "EA platform-control tools for scheduling, channel lookup, and external Agent task submission.",
      });
    }
    if (msg.method === "ping") return hasRequestId(id) ? ok(id, {}) : null;
    if (msg.method === "resources/list") return hasRequestId(id) ? ok(id, { resources: [] }) : null;
    if (msg.method === "prompts/list") return hasRequestId(id) ? ok(id, { prompts: [] }) : null;
    if (msg.method === "tools/list") return hasRequestId(id) ? ok(id, { tools: TOOLS }) : null;
    if (msg.method === "tools/call") {
      if (!hasRequestId(id)) return null;
      const result = await callTool(req, String(msg.params?.name || ""), msg.params?.arguments || {});
      return ok(id, result);
    }
    return hasRequestId(id) ? err(id, -32601, `Method not found: ${msg.method}`) : null;
  } catch (error: any) {
    return hasRequestId(id) ? err(id, -32000, error?.message || String(error)) : null;
  }
}

export function registerPlatformToolsMcpRoutes(app: Express): void {
  app.get("/api/internal/platform-tools/health", (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.json({ status: "ok", name: SERVICE_NAME, version: SERVICE_VERSION });
  });

  app.get("/api/internal/platform-tools/mcp", (req: Request, res: Response) => {
    if (!isAuthorized(req)) {
      res.status(401).json(err(null, -32001, "unauthorized"));
      return;
    }
    const sessionId = `platform-tools-${resolveAdoptId(req, {}) || "unknown"}`;
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Mcp-Session-Id", sessionId);
    res.flushHeaders?.();
    res.write(": platform-tools stream ready\n\n");

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 25_000);
    req.on("close", () => {
      clearInterval(heartbeat);
    });
  });

  app.delete("/api/internal/platform-tools/mcp", (req: Request, res: Response) => {
    if (!isAuthorized(req)) {
      res.status(401).json(err(null, -32001, "unauthorized"));
      return;
    }
    res.status(204).end();
  });

  app.post("/api/internal/platform-tools/mcp", async (req: Request, res: Response) => {
    if (!isAuthorized(req)) {
      res.status(401).json(err(null, -32001, "unauthorized"));
      return;
    }
    const body = req.body || {};
    const response = Array.isArray(body)
      ? (await Promise.all(body.map((item) => handleMessage(req, item)))).filter(Boolean)
      : await handleMessage(req, body);
    if (!response || (Array.isArray(response) && response.length === 0)) {
      res.status(202).json({});
      return;
    }
    res.setHeader("Mcp-Session-Id", `platform-tools-${resolveAdoptId(req, {}) || "unknown"}`);
    res.json(response);
  });
}
