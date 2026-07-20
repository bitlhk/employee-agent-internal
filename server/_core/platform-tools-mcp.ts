import type { Express, Request, Response } from "express";
import path from "path";
import { existsSync, mkdirSync, rmSync } from "fs";
import { isAuthorizedInternalRequest, resolveRuntimeAgentId, resolveRuntimeWorkspaceByIds } from "./helpers";
import type { SkillSource } from "../../shared/types/skill";
import { getClawByAdoptId, getClawByAgentId } from "../db";
import { resolveEffectiveRoleAssets } from "../db/role-assets";
import { parseSkillSourceDirectory, sanitizeSkillId } from "./skills/skill-source";
import { skillInstaller } from "./skills/skill-installer";
import { skillRegistry } from "./skills/skill-registry";
import { skillStoreRuntimeImportedDir } from "./skills/skill-store";
import { auditRequest, recordAuditBestEffort } from "./audit-events";
import {
  forgetAgentMemory,
  listAgentMemoryView,
  rememberExplicitPreference,
} from "./agent-memory";

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
      "Use this for long-running or complete specialist work that should run outside the current conversation, or when the user explicitly asks to call an external Agent.",
      "For lightweight lookup, field verification, single-factor checks, or short explanations, prefer local skills/MCP tools instead of this asynchronous Agent.",
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
  {
    name: "remember_preference",
    description: [
      "Save a durable work preference for the current EA employee agent only when the user explicitly asks to remember it, corrects a prior preference, or clearly says future work should follow it.",
      "Store only stable working style, output format, or reusable personal process preferences.",
      "Never store credentials, attachment contents, customer records, balances, positions, market data, product status, or other changing business facts.",
      "Do not claim that something was remembered unless this tool returns success.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "A concise Chinese statement of the durable preference, without secrets or transient facts." },
        key: { type: "string", description: "Optional stable dotted key such as output.risk_first. Use the same key when correcting the same preference." },
        kind: { type: "string", enum: ["preference", "instruction", "entity", "procedure"], description: "Preference category; normally preference or instruction." },
      },
      required: ["content"],
    },
  },
  {
    name: "forget_preference",
    description: "Forget a saved preference for the current EA employee agent when the user explicitly asks to remove or stop using it.",
    inputSchema: {
      type: "object",
      properties: {
        memory_id: { type: "integer", description: "Optional memory id returned by list_learned_preferences." },
        query: { type: "string", description: "Short text identifying the preference to forget when memory_id is unavailable." },
      },
    },
  },
  {
    name: "list_learned_preferences",
    description: "List active work preferences learned by the current EA employee agent. Use when the user asks what is remembered about their work style.",
    inputSchema: { type: "object", properties: {} },
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

function pathInside(child: string, parent: string): boolean {
  const normalizedChild = path.resolve(child);
  const normalizedParent = path.resolve(parent);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${path.sep}`);
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

export class PlatformIdentityError extends Error {
  constructor(
    message: string,
    readonly trustedAdoptId: string,
    readonly requestedAdoptId: string,
  ) {
    super(message);
    this.name = "PlatformIdentityError";
  }
}

export function resolvePlatformAdoptId(
  trustedAdoptIdRaw: unknown,
  args: Record<string, unknown>,
): string {
  const trustedAdoptId = String(trustedAdoptIdRaw || "").trim();
  const requestedAdoptId = String(args.adoptId || args.adopt_id || "").trim();
  if (!trustedAdoptId) {
    if (requestedAdoptId) {
      throw new PlatformIdentityError(
        "trusted Agent identity is missing; adoptId arguments cannot establish identity",
        "",
        requestedAdoptId,
      );
    }
    return "";
  }
  if (requestedAdoptId && requestedAdoptId !== trustedAdoptId) {
    throw new PlatformIdentityError(
      "adoptId argument does not match the trusted runtime identity",
      trustedAdoptId,
      requestedAdoptId,
    );
  }
  return trustedAdoptId;
}

function resolveAdoptId(req: Request, args: Record<string, unknown>): string {
  const trustedAdoptId = pickHeader(req, [
    "x-agent-adopt-id",
    "x-workforce-agent-adopt-id",
    "x-jiuwen-channel-id",
    "x-openclaw-channel-id",
  ]);
  return resolvePlatformAdoptId(trustedAdoptId, args);
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
  let adoptId = "";
  try {
    adoptId = resolveAdoptId(req, args);
  } catch (error) {
    if (error instanceof PlatformIdentityError) {
      await recordAuditBestEffort({
        action: "platform.mcp.identity_mismatch",
        result: "denied",
        severity: "high",
        actorType: "agent",
        targetType: "claw_adoption",
        targetId: error.trustedAdoptId || null,
        toolName: name,
        source: "platform_tools_mcp",
        policyCode: "TRUSTED_AGENT_IDENTITY_REQUIRED",
        ...auditRequest(req),
        metadata: {
          trustedAdoptId: error.trustedAdoptId || null,
          requestedAdoptId: error.requestedAdoptId || null,
        },
      });
    }
    throw error;
  }
  if (!adoptId) return textResult("Error: adoptId is missing from JiuwenSwarm user context.", { isError: true });

  if (name === "remember_preference") {
    const content = String(args.content || "").trim();
    if (!content) return textResult("Error: content is required", { isError: true });
    const memory = await rememberExplicitPreference({
      adoptId,
      content,
      key: String(args.key || "").trim() || undefined,
      kind: ["preference", "instruction", "entity", "procedure"].includes(String(args.kind || ""))
        ? String(args.kind) as any
        : "preference",
      channel: pickHeader(req, ["x-jiuwen-channel-id", "x-openclaw-channel-id"]) || "conversation",
    });
    await recordAuditBestEffort({
      action: "memory.preference.remember",
      result: "success",
      severity: "info",
      actorType: "agent",
      targetType: "agent_memory",
      targetId: String(memory.id),
      agentInstanceId: adoptId,
      toolName: name,
      source: "platform_tools_mcp",
      ...auditRequest(req),
      metadata: { kind: memory.kind, scope: memory.scope },
    });
    return textResult(`EA_MEMORY_RECEIPT:${JSON.stringify({
      action: "remembered",
      id: memory.id,
      content: memory.content,
      kind: memory.kind,
      scope: memory.scope,
      status: memory.status,
    })}`);
  }

  if (name === "forget_preference") {
    const claw = await getClawByAdoptId(adoptId);
    if (!claw) return textResult("Error: employee agent not found", { isError: true });
    const memoryId = Number(args.memory_id || args.memoryId || 0) || undefined;
    const query = String(args.query || args.content || "").trim() || undefined;
    if (!memoryId && !query) return textResult("Error: memory_id or query is required", { isError: true });
    const memory = await forgetAgentMemory({
      userId: Number(claw.userId),
      adoptId,
      id: memoryId,
      query,
    });
    await recordAuditBestEffort({
      action: "memory.preference.forget",
      result: "success",
      severity: "info",
      actorType: "agent",
      targetType: "agent_memory",
      targetId: String(memory.id),
      agentInstanceId: adoptId,
      toolName: name,
      source: "platform_tools_mcp",
      ...auditRequest(req),
    });
    return textResult(`EA_MEMORY_RECEIPT:${JSON.stringify({
      action: "forgotten",
      id: memory.id,
      content: memory.content,
      status: "forgotten",
    })}`);
  }

  if (name === "list_learned_preferences") {
    const claw = await getClawByAdoptId(adoptId);
    if (!claw) return textResult("Error: employee agent not found", { isError: true });
    const view = await listAgentMemoryView({
      userId: Number(claw.userId),
      adoptId,
      adoptionId: Number(claw.id),
    });
    const active = view.items.filter((item) => item.status === "active");
    if (!active.length) return textResult("当前岗位还没有已生效的工作偏好。");
    return textResult([
      `当前岗位已学会 ${active.length} 条工作偏好：`,
      ...active.map((item) => `- [${item.id}] ${item.content}`),
    ].join("\n"));
  }

  if (name === "get_user_channels") {
    const channels = ["conversation"];
    try {
      const wxData: any = await internalJson(`/api/claw/weixin/status?adoptId=${encodeURIComponent(adoptId)}`);
      if (wxData?.bound) channels.push("weixin");
    } catch {}
    try {
      const notifyData: any = await internalJson(`/api/claw/notify/config?adoptId=${encodeURIComponent(adoptId)}`);
      const cfg = notifyData?.config || {};
      if (cfg.type === "wechat_work" && cfg.secretConfigured) channels.push("wecom");
      if (cfg.type === "feishu" && cfg.webhookConfigured) channels.push("feishu");
      if (cfg.type === "webhook" && cfg.webhookConfigured) channels.push("webhook");
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
        instructions: "EA platform-control tools for scheduling, channel lookup, external Agent task submission, and governed employee-agent preference learning.",
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

  app.get("/api/internal/mcp/agent-authorization", async (req, res) => {
    if (!isAuthorized(req)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const agentId = String(req.query.agentId || "").trim();
    const mcpServerId = String(req.query.mcpServerId || "").trim();
    if (!agentId || !mcpServerId) {
      return res.status(400).json({ ok: false, error: "agentId and mcpServerId are required" });
    }

    const claw = await getClawByAgentId(agentId);
    if (!claw || !["active", "expiring"].includes(claw.status)) {
      return res.status(403).json({ ok: false, authorized: false, reason: "agent_not_active" });
    }

    const roleId = String(claw.roleTemplate || "general-assistant").trim();
    const assets = await resolveEffectiveRoleAssets(roleId);
    const allowedMcpServers = new Set([
      ...assets.mcpServers.default,
      ...assets.mcpServers.optional,
    ]);
    const authorized = roleId === "wealth-manager" && allowedMcpServers.has(mcpServerId);

    return res.status(authorized ? 200 : 403).json({
      ok: authorized,
      authorized,
      reason: authorized ? "authorized" : "role_or_asset_not_authorized",
      agentId: claw.agentId,
      adoptId: claw.adoptId,
      roleId,
      mcpServerId,
      userCode: claw.adoptId.replace(/^[^-]+-/, ""),
    });
  });

  app.post("/api/internal/platform-tools/skills/register-runtime", async (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const adoptId = String(body.adoptId || body.adopt_id || "").trim();
      const rawRuntimePath = String(body.runtimePath || body.runtime_path || "").trim();
      const requestedSkillId = sanitizeSkillId(String(body.skillId || body.skill_id || path.basename(rawRuntimePath) || ""));
      if (!adoptId || !rawRuntimePath || !requestedSkillId) {
        res.status(400).json({ error: "adoptId, skillId and runtimePath required" });
        return;
      }
      const claw = await getClawByAdoptId(adoptId).catch(() => null);
      if (!claw) {
        res.status(404).json({ error: "agent not found" });
        return;
      }
      const runtimeAgentId = resolveRuntimeAgentId(adoptId, String((claw as any).agentId || ""));
      const workspaceDir = resolveRuntimeWorkspaceByIds(adoptId, runtimeAgentId);
      const runtimePath = path.resolve(rawRuntimePath);
      const expectedSkillsRoot = path.join(workspaceDir, "skills");
      if (!pathInside(runtimePath, expectedSkillsRoot)) {
        res.status(400).json({ error: "runtimePath is outside agent skills workspace" });
        return;
      }
      if (!existsSync(path.join(runtimePath, "SKILL.md"))) {
        res.status(400).json({ error: "runtime skill is missing SKILL.md" });
        return;
      }

      const parsed = parseSkillSourceDirectory(runtimePath, requestedSkillId);
      const skillId = parsed.skillId || requestedSkillId;
      const existing = await skillRegistry.listSkills(adoptId);
      if (existing.ok) {
        const registered = existing.value.find((skill) => skill.id === skillId || skill.id === requestedSkillId);
        if (registered && registered.source.kind !== "runtime_imported") {
          res.json({
            ok: true,
            skipped: true,
            reason: "skill already managed by registry",
            skillId: registered.id,
            sourceKind: registered.source.kind,
            sourcePath: registered.source.sourcePath || null,
            runtimePath,
          });
          return;
        }
      }

      const sourceDir = skillStoreRuntimeImportedDir(adoptId, skillId);
      if (existsSync(sourceDir)) rmSync(sourceDir, { recursive: true, force: true });
      mkdirSync(path.dirname(sourceDir), { recursive: true });
      skillInstaller.installFromSource(runtimePath, sourceDir);

      const source: SkillSource = {
        kind: "runtime_imported",
        skillId,
        displayName: parsed.displayName || skillId,
        description: parsed.description || "运行时导入的个人技能",
        sourcePath: sourceDir,
        version: String(parsed.manifest?.version || ""),
      };
      const installed = await skillRegistry.install(adoptId, source);
      if (!installed.ok) {
        res.status(500).json({ error: installed.error.detail, kind: installed.error.kind });
        return;
      }
      await skillRegistry.updateScan(adoptId, skillId, {
        warnings: parsed.warnings,
        scannedAt: new Date().toISOString(),
      });
      res.json({ ok: true, skillId, sourcePath: sourceDir, runtimePath });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || "register runtime skill failed") });
    }
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
