import type { Express, Request, Response } from "express";
import { createHash } from "crypto";
import path from "path";
import { existsSync, mkdirSync, rmSync } from "fs";
import { isAuthorizedInternalRequest, resolveRuntimeAgentId, resolveRuntimeWorkspaceByIds } from "./helpers";
import type { SkillSource } from "../../shared/types/skill";
import { getClawByAdoptId, getClawByAgentId, getUserById } from "../db";
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
import { beginMcpCall } from "./observability/metrics";
import { fetchWithTimeout } from "./fetch-timeout";
import { evaluateGovernance, governanceFingerprint, principalFingerprint } from "./governance/contracts";
import { platformMcpPolicyAdapter } from "./governance/platform-mcp-policy";
import { resolveRuntimePrincipal, resolveRuntimePrincipalV2 } from "./governance/principal";
import { authorizePlatformMcpExecution } from "./governance/platform-mcp-execution-authority";
import {
  buildCapabilitySnapshot,
  buildTaskContextPack,
  buildTaskExecutionEnvelope,
} from "./governance/task-execution-envelope";
import { evaluateWealthTaskReadiness, readinessCheck } from "./governance/wealth-task-readiness";
import { capabilitySetFingerprint } from "./governance/capability-registry";
import { resolveToolGovernance, stableToolInputHash } from "./tool-governance";
import { runtimeGovernanceIsAttested } from "./runtime-governance-attestation";
import { callInternalMcpTool, parseInternalMcpJsonResult } from "./internal-mcp-client";
import { prepareWealthAllocationContext } from "./wealth-allocation-context";
import { prepareWealthMaturityContext } from "./wealth-maturity-context";
import { handleWealthPrevisitTool } from "./wealth-previsit-tool-handler";
import { resolveWealthRolePackReleaseEvidence, wealthRolePackReleaseReadiness } from "./wealth-role-pack-release";
import {
  resolveWealthPolicyBasis,
  resolveWealthSuitabilityPolicySource,
} from "./wealth-policy-source";

const SERVICE_NAME = "platform-tools";
const SERVICE_VERSION = "1.0.0";

const TOOLS = [
  {
    name: "create_scheduled_task",
    description: "Create either a one-time or recurring scheduled task for reminders, periodic checks, or automated reports. Use run_at for one-time tasks and cron_expr for recurring tasks. Results should be tracked in the EA schedule task record unless the user explicitly asks for another delivery channel.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short task name" },
        message: { type: "string", description: "Instruction to execute on each run" },
        run_at: { type: "string", description: "ISO 8601 timestamp with timezone for a one-time task, for example '2026-08-13T14:00:00+08:00'" },
        cron_expr: { type: "string", description: "Cron expression for a recurring task, for example '30 10 * * *' for daily 10:30" },
        delivery_channel: { type: "string", enum: ["conversation", "weixin", "wecom", "feishu", "webhook"], description: "Where to deliver results" },
      },
      required: ["name", "message"],
      oneOf: [
        { required: ["run_at"] },
        { required: ["cron_expr"] },
      ],
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
  {
    name: "get_wealth_policy_basis",
    description: [
      "Get the currently effective wealth suitability policy basis for the current wealth-manager role.",
      "Use this before answering which sales or suitability policy is current, whether a historical version may be used, or which policy basis governs a formal recommendation.",
      "The result contains only eligible current-policy metadata and safe aggregate filtering evidence; it never returns restricted document names or contents.",
    ].join(" "),
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "prepare_wealth_previsit_context",
    description: [
      "Prepare the governed customer and knowledge context for a wealth-manager previsit brief.",
      "It verifies the Runtime Principal, customer data scope, current customer facts, data timestamp, and eligible previsit SOP in one call.",
      "Use this before producing a customer-specific previsit brief. Respect readiness.allowedOutcomes and never invent missing customer facts.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "Customer id selected from the current wealth manager's authorized customer list." },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "prepare_wealth_maturity_context",
    description: [
      "Prepare a bounded list of upcoming maturity events for customers authorized to the current wealth manager.",
      "Use for 7/14/30/90-day maturity operations, prioritization, and follow-up planning.",
      "It never recommends replacement products and never creates tasks; any product recommendation requires prepare_wealth_allocation_context, and any write requires a separate governed tool call.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        window_days: { type: "number", minimum: 1, maximum: 90, description: "Maturity window in days, default 30." },
        max_customers: { type: "number", minimum: 1, maximum: 30, description: "Maximum authorized customers to scan, default 20." },
        max_items: { type: "number", minimum: 1, maximum: 50, description: "Maximum maturity events returned, default 30." },
      },
    },
  },
  {
    name: "prepare_wealth_allocation_context",
    description: [
      "Prepare governed wealth-allocation context for one authorized customer.",
      "This is the only platform tool that may produce a formal candidate-product set for a wealth allocation task.",
      "It loads current customer and product data, verifies the currently effective suitability policy, and returns only products allowed by deterministic policy.",
      "Use eligibleProducts for recommendations; excludedProducts are reason-only and must never be recommended.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "Customer id from the authorized wealth customer MCP." },
        amount: { type: "number", description: "Optional proposed allocation amount." },
        horizon_months: { type: "number", description: "Optional customer investment horizon in months." },
        channel: { type: "string", description: "Optional sales channel, for example branch or mobile." },
        keyword: { type: "string", description: "Optional product search keyword." },
        product_type: { type: "string", description: "Optional product type filter." },
        max_products: { type: "number", description: "Maximum candidates to evaluate, default 10 and maximum 20." },
      },
      required: ["customer_id"],
    },
  },
];
const TOOL_NAMES = new Set(TOOLS.map(tool => tool.name));

function ok(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function err(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function hasRequestId(id: unknown): boolean {
  return id !== undefined && id !== null;
}

type PlatformToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
};

function textResult(text: string, extra: Record<string, unknown> = {}): PlatformToolResult {
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
  const resp = await fetchWithTimeout(`${base}${path}`, { ...init, headers });
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

async function callTool(
  req: Request,
  name: string,
  args: Record<string, unknown>,
  requestIdentity?: unknown,
) {
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
  const claw = await getClawByAdoptId(adoptId);
  if (!claw || !["active", "expiring"].includes(String(claw.status || ""))) {
    return textResult("Error: employee agent is not active.", { isError: true });
  }
  const profile = resolveToolGovernance(`mcp_platform_tools_${name}`);
  const principal = resolveRuntimePrincipal({
    adoption: claw,
    sessionId: pickHeader(req, ["x-linggan-session-id", "x-jiuwen-session-id"]),
  });
  const operation = {
    capabilityId: "platform.mcp",
    operation: name,
    sideEffect: profile.sideEffect,
    resource: `platform-tool:${name}`,
    payloadHash: stableToolInputHash(args),
  } as const;
  const authority = await authorizePlatformMcpExecution({ req, adoption: claw, principal, operation });
  if (!authority.allowed) return textResult(authority.reason || "当前执行权限不可用。", { isError: true });
  const effectivePrincipal = authority.principal;
  const executionAuthority = authority.decision;
  const governance = await evaluateGovernance({
    principal: effectivePrincipal.principal,
    operation,
  }, [platformMcpPolicyAdapter({
    knownTool: TOOL_NAMES.has(name),
    profile,
    principal: effectivePrincipal,
    runtimeAttested: runtimeGovernanceIsAttested(req.headers["x-ea-runtime-id"]),
  })], {
    effect: "DENY",
    policyCode: "EA_PLATFORM_MCP_POLICY_UNAVAILABLE",
    ruleVersion: "platform-mcp-v1",
    reason: "Platform MCP policy is unavailable.",
    obligations: [{ type: "AUDIT", level: "strong" }],
  });
  await recordAuditBestEffort({
    action: governance.effect === "ALLOW" ? "governance.platform_mcp.allowed" : "governance.platform_mcp.blocked",
    result: governance.effect === "ALLOW" ? "success" : "denied",
    severity: governance.effect === "ALLOW" ? "info" : "high",
    actorType: "agent",
    actorUserId: effectivePrincipal.principal.userId || null,
    actorRole: effectivePrincipal.principal.roleTemplate || null,
    targetType: "platform_tool",
    targetId: name,
    workspaceId: effectivePrincipal.principal.workspaceId || null,
    agentInstanceId: effectivePrincipal.principal.adoptionId || null,
    runtimeAgentId: effectivePrincipal.principal.agentId || null,
    sessionId: effectivePrincipal.principal.sessionId || null,
    toolName: name,
    policyCode: governance.policyCode,
    source: "platform_tools_mcp",
    ...auditRequest(req),
    metadata: {
      policyDecisionId: governance.decisionId,
      ruleVersion: governance.ruleVersion,
      principalFingerprint: governance.principalFingerprint,
      operationFingerprint: governance.operationFingerprint,
      capabilitySetFingerprint: capabilitySetFingerprint(),
      sideEffect: profile.sideEffect,
      executionAuthorityFingerprint: executionAuthority?.effectiveAuthorityFingerprint || null,
    },
  });
  if (governance.effect !== "ALLOW") return textResult(governance.reason, { isError: true });

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

  if (name === "get_wealth_policy_basis") {
    const user = await getUserById(Number(claw.userId));
    if (!user) return textResult("当前用户身份不可用，请重新登录后重试。", { isError: true });
    const basis = await resolveWealthPolicyBasis({
      userId: Number(user.id),
      groupId: Number(user.groupId || 0),
      actorRole: String(user.role || "user"),
      roleTemplate: principal.principal.roleTemplate,
    });
    const principalV2 = await resolveRuntimePrincipalV2({
      adoption: claw,
      user,
      sessionId: principal.principal.sessionId,
    });
    const policyReady = basis.status === "ready" && Boolean(basis.selected);
    const releaseEvidence = await resolveWealthRolePackReleaseEvidence();
    const readiness = evaluateWealthTaskReadiness({
      taskId: "WM-GT-03",
      checks: {
        identity: principalV2.complete
          ? readinessCheck("READY", "PRINCIPAL_V2_READY", "岗位身份和授权快照已就绪。")
          : readinessCheck("BLOCKED", "PRINCIPAL_V2_UNAVAILABLE", "当前岗位身份无法形成可验证授权快照。", { retryable: true }),
        knowledge: policyReady
          ? readinessCheck("READY", "CURRENT_POLICY_READY", "当前有效制度已通过知识资格校验。", { asOf: basis.evaluatedAt })
          : readinessCheck("BLOCKED", "CURRENT_POLICY_UNAVAILABLE", basis.userMessage),
        policy: policyReady
          ? readinessCheck("READY", "POLICY_SOURCE_BOUND", "政策判断已绑定现行制度版本。")
          : readinessCheck("BLOCKED", "POLICY_SOURCE_UNAVAILABLE", "没有可用于正式判断的现行制度依据。"),
        evidence: basis.governance.eligibilityFingerprint
          ? readinessCheck("READY", "KNOWLEDGE_EVIDENCE_READY", "知识资格证据已生成。")
          : readinessCheck("BLOCKED", "KNOWLEDGE_EVIDENCE_MISSING", "知识资格证据缺失。"),
        release: wealthRolePackReleaseReadiness(releaseEvidence),
      },
    });
    const executionEnvelope = principalV2.complete ? buildTaskExecutionEnvelope({
      principal: principalV2.principal,
      context: buildTaskContextPack({
        knowledge: {
          selectedAssets: basis.selected ? [{
            assetId: basis.selected.sourceAssetId,
            version: basis.selected.versionLabel,
            contentHash: basis.selected.contentHash || "",
          }] : [],
          eligibilityFingerprint: basis.governance.eligibilityFingerprint,
        },
        businessData: { sources: [] },
        memory: { memoryRefs: [] },
        principalFingerprint: principalFingerprint(principalV2.principal),
        assembledAt: basis.evaluatedAt,
      }),
      readiness,
      capabilitySnapshot: buildCapabilitySnapshot({
        capabilityIds: ["get_wealth_policy_basis"],
        capabilityVersions: { get_wealth_policy_basis: "1" },
        sideEffectProfiles: { get_wealth_policy_basis: "read" },
        policyBindings: { get_wealth_policy_basis: ["EA_KNOWLEDGE_ELIGIBILITY_V1"] },
      }),
      releaseEvidence,
      correlationId: pickHeader(req, ["x-request-id", "x-correlation-id"]) || undefined,
    }) : null;
    await recordAuditBestEffort({
      action: basis.status === "ready"
        ? "governance.wealth_policy_basis.selected"
        : "governance.wealth_policy_basis.unavailable",
      result: basis.status === "ready" ? "success" : "denied",
      severity: basis.status === "ready" ? "info" : "medium",
      actorType: "agent",
      actorUserId: Number(user.id),
      actorRole: principal.principal.roleTemplate,
      targetType: "wealth_policy_basis",
      targetId: basis.selected?.sourceAssetId || "unavailable",
      workspaceId: principal.principal.workspaceId || null,
      agentInstanceId: adoptId,
      runtimeAgentId: principal.principal.agentId,
      sessionId: principal.principal.sessionId,
      toolName: name,
      policyCode: "EA_KNOWLEDGE_ELIGIBILITY_V1",
      source: "platform_tools_mcp",
      ...auditRequest(req),
      metadata: {
        ruleVersion: "knowledge-eligibility-v1",
        policySourceVersion: basis.selected?.versionLabel || null,
        contextEligibilityFingerprint: basis.governance.eligibilityFingerprint,
        historicalVersionFiltered: basis.governance.historicalVersionFiltered,
        filteredForValidity: basis.governance.filteredForValidity,
        accessRestricted: basis.governance.accessRestricted,
      },
    });
    return textResult(`EA_WEALTH_POLICY_BASIS:${JSON.stringify({ ...basis, readiness, executionEnvelope })}`, principalV2.complete ? {} : { isError: true });
  }

  if (name === "prepare_wealth_previsit_context") {
    return handleWealthPrevisitTool({
      req,
      args,
      adoption: claw,
      adoptId,
      sessionId: principal.principal.sessionId,
    });
  }

  if (name === "prepare_wealth_maturity_context") {
    const boundedInteger = (value: unknown, fallback: number, maximum: number) => {
      const number = Math.floor(Number(value || fallback));
      return Number.isFinite(number) ? Math.min(maximum, Math.max(1, number)) : fallback;
    };
    const windowDays = boundedInteger(args.window_days || args.windowDays, 30, 90);
    const maxCustomers = boundedInteger(args.max_customers || args.maxCustomers, 20, 30);
    const maxItems = boundedInteger(args.max_items || args.maxItems, 30, 50);
    const customerEndpoint = String(process.env.WEALTH_CUSTOMER_MCP_URL || "http://127.0.0.1:18008/mcp").trim();
    try {
      const result = await prepareWealthMaturityContext({
        roleTemplate: principal.principal.roleTemplate,
        request: { windowDays, maxCustomers, maxItems },
        dependencies: {
          listCustomers: async (query) => parseInternalMcpJsonResult(await callInternalMcpTool({
            endpointUrl: customerEndpoint,
            toolName: "wealth_assistant_customer_list",
            args: query,
            agentId: principal.principal.agentId,
            adoptId,
            sessionId: principal.principal.sessionId,
          })),
          loadCustomer: async (customerId) => parseInternalMcpJsonResult(await callInternalMcpTool({
            endpointUrl: customerEndpoint,
            toolName: "wealth_assistant_customer_detail",
            args: { customerId },
            agentId: principal.principal.agentId,
            adoptId,
            sessionId: principal.principal.sessionId,
          })),
        },
      });
      await recordAuditBestEffort({
        action: "governance.wealth_maturity_context.prepared",
        result: result.status === "unavailable" ? "failed" : "success",
        severity: result.status === "unavailable" ? "medium" : "info",
        actorType: "agent",
        actorUserId: principal.principal.userId || null,
        actorRole: principal.principal.roleTemplate,
        targetType: "wealth_maturity_context",
        targetId: stableToolInputHash({ windowDays, maxCustomers, maxItems }),
        workspaceId: principal.principal.workspaceId || null,
        agentInstanceId: adoptId,
        runtimeAgentId: principal.principal.agentId,
        sessionId: principal.principal.sessionId,
        toolName: name,
        policyCode: "EA_WEALTH_MATURITY_SCOPE_V1",
        source: "platform_tools_mcp",
        ...auditRequest(req),
        metadata: {
          windowDays,
          customersScanned: result.summary.customersScanned,
          customersFailed: result.summary.customersFailed,
          returnedItems: result.summary.returnedItems,
          truncated: result.summary.truncated,
          scope: result.evidence.scope,
        },
      });
      return textResult(`EA_WEALTH_MATURITY_CONTEXT:${JSON.stringify(result)}`, result.status === "unavailable" ? { isError: true } : {});
    } catch {
      return textResult(`EA_WEALTH_MATURITY_CONTEXT:${JSON.stringify({
        schema: "ea.wealth-maturity-context.v1",
        status: "unavailable",
        message: "客户数据服务暂时不可用，不能形成具体客户到期经营结论。可以先整理通用跟进检查表。",
      })}`, { isError: true });
    }
  }

  if (name === "prepare_wealth_allocation_context") {
    const customerId = String(args.customer_id || args.customerId || "").trim().slice(0, 128);
    if (!customerId) return textResult("需要先选择本人授权范围内的客户，再准备资产配置建议。", { isError: true });
    const optionalPositiveNumber = (value: unknown, maximum: number): number | null => {
      if (value === undefined || value === null || value === "") return null;
      const number = Number(value);
      return Number.isFinite(number) && number > 0 && number <= maximum ? number : null;
    };
    const amount = optionalPositiveNumber(args.amount, 10_000_000_000);
    const horizonMonths = optionalPositiveNumber(args.horizon_months || args.horizonMonths, 1_200);
    const channel = String(args.channel || "").trim().slice(0, 64);
    const keyword = String(args.keyword || "").trim().slice(0, 120);
    const productType = String(args.product_type || args.productType || "").trim().slice(0, 64);
    const maxProducts = Math.min(20, Math.max(1, Math.floor(Number(args.max_products || args.maxProducts || 10)) || 10));
    const customerEndpoint = String(process.env.WEALTH_CUSTOMER_MCP_URL || "http://127.0.0.1:18008/mcp").trim();
    const productEndpoint = String(process.env.WEALTH_PRODUCT_MCP_URL || "http://127.0.0.1:18007/mcp").trim();
    try {
      const user = await getUserById(Number(claw.userId));
      if (!user) throw new Error("当前用户身份不可用");
      const principalV2 = await resolveRuntimePrincipalV2({
        adoption: claw,
        user,
        sessionId: principal.principal.sessionId,
      });
      if (!principalV2.complete) {
        const readiness = evaluateWealthTaskReadiness({
          taskId: "WM-GT-04",
          checks: {
            identity: readinessCheck("BLOCKED", "PRINCIPAL_V2_UNAVAILABLE", "当前岗位身份无法形成可验证授权快照。", { retryable: true }),
          },
        });
        return textResult(`EA_WEALTH_ALLOCATION_CONTEXT:${JSON.stringify({
          schema: "ea.wealth-allocation-context.v1",
          status: "blocked",
          message: "当前岗位身份校验未完成，暂不能形成正式产品推荐。",
          readiness,
        })}`, { isError: true });
      }
      const result = await prepareWealthAllocationContext({
        principal: principalV2.principal,
        request: { customerId, amount, horizonMonths, channel, keyword, productType, maxProducts },
        dependencies: {
          loadCustomer: async (requestedCustomerId) => parseInternalMcpJsonResult(await callInternalMcpTool({
            endpointUrl: customerEndpoint,
            toolName: "wealth_assistant_customer_detail",
            args: { customerId: requestedCustomerId },
            agentId: principal.principal.agentId,
            adoptId,
            sessionId: principal.principal.sessionId,
          })),
          searchProducts: async (search) => parseInternalMcpJsonResult(await callInternalMcpTool({
            endpointUrl: productEndpoint,
            toolName: "wealth_assistant_product_search",
            args: {
              keyword: search.keyword || undefined,
              type: search.type || undefined,
              page: 1,
              pageSize: search.pageSize,
            },
            agentId: principal.principal.agentId,
            adoptId,
            sessionId: principal.principal.sessionId,
          })),
          resolvePolicySource: async () => resolveWealthSuitabilityPolicySource({
            userId: Number(user.id),
            groupId: Number(user.groupId || 0),
            actorRole: String(user.role || "user"),
            roleTemplate: principal.principal.roleTemplate,
          }),
        },
      });
      const policyReady = result.policySource.ready && result.eligibleProducts.length > 0;
      const productDataReady = result.evidence.productDataAsOf.length > 0;
      const releaseEvidence = await resolveWealthRolePackReleaseEvidence();
      const readiness = evaluateWealthTaskReadiness({
        taskId: "WM-GT-04",
        checks: {
          identity: readinessCheck("READY", "PRINCIPAL_V2_READY", "岗位身份和授权快照已就绪。"),
          knowledge: result.policySource.ready
            ? readinessCheck("READY", "CURRENT_POLICY_READY", "当前有效制度已通过知识资格校验。")
            : readinessCheck("BLOCKED", "CURRENT_POLICY_UNAVAILABLE", "当前有效适当性制度不可用。"),
          customerData: result.evidence.customerDataAsOf
            ? readinessCheck("READY", "CUSTOMER_DATA_READY", "客户数据已就绪。", { asOf: result.evidence.customerDataAsOf })
            : readinessCheck("BLOCKED", "CUSTOMER_DATA_STALE", "客户数据缺少有效时间，不能形成正式推荐。"),
          productData: productDataReady
            ? readinessCheck("READY", "PRODUCT_DATA_READY", "当前产品数据已就绪。", { asOf: result.evidence.productDataAsOf[0] })
            : readinessCheck("BLOCKED", "PRODUCT_DATA_UNAVAILABLE", "当前产品数据不可用。", { retryable: true }),
          policy: policyReady
            ? readinessCheck("READY", "SUITABILITY_POLICY_ALLOW", "存在通过适当性校验的产品候选。")
            : readinessCheck("BLOCKED", "SUITABILITY_POLICY_DENY", result.excludedProducts[0]?.reason || "没有产品通过当前适当性规则。"),
          capability: readinessCheck("READY", "WEALTH_CONTEXT_CAPABILITY_READY", "财富配置上下文能力已就绪。"),
          evidence: result.evidence.policyDecisionIds.length
            ? readinessCheck("READY", "POLICY_EVIDENCE_READY", "适当性判断证据已生成。")
            : readinessCheck("BLOCKED", "POLICY_EVIDENCE_MISSING", "适当性判断证据缺失。"),
          release: wealthRolePackReleaseReadiness(releaseEvidence),
        },
      });
      const executionEnvelope = buildTaskExecutionEnvelope({
        principal: principalV2.principal,
        context: buildTaskContextPack({
          knowledge: {
            selectedAssets: result.policySource.sourceAssetId ? [{
              assetId: result.policySource.sourceAssetId,
              version: result.policySource.versionLabel,
              contentHash: "",
            }] : [],
            eligibilityFingerprint: result.policySource.eligibilityFingerprint,
          },
          businessData: {
            sources: [
              {
                sourceSystem: "wealth_customer_mcp",
                entityRef: result.customer.customerId,
                asOf: result.evidence.customerDataAsOf,
                resultFingerprint: governanceFingerprint(result.customer),
              },
              {
                sourceSystem: "wealth_product_mcp",
                entityRef: "eligible-product-set",
                asOf: result.evidence.productDataAsOf[0] || "",
                resultFingerprint: governanceFingerprint({ eligible: result.eligibleProducts, excluded: result.excludedProducts }),
              },
            ],
          },
          memory: { memoryRefs: [] },
          principalFingerprint: principalFingerprint(principalV2.principal),
          assembledAt: new Date().toISOString(),
        }),
        readiness,
        capabilitySnapshot: buildCapabilitySnapshot({
          capabilityIds: ["prepare_wealth_allocation_context", "wealth_customer_mcp", "wealth_product_mcp"],
          capabilityVersions: { prepare_wealth_allocation_context: "1", wealth_customer_mcp: "1", wealth_product_mcp: "1" },
          sideEffectProfiles: { prepare_wealth_allocation_context: "read", wealth_customer_mcp: "read", wealth_product_mcp: "read" },
          policyBindings: { prepare_wealth_allocation_context: ["WEALTH_SUITABILITY_MATCH"] },
        }),
        releaseEvidence,
        correlationId: pickHeader(req, ["x-request-id", "x-correlation-id"]) || undefined,
      });
      await recordAuditBestEffort({
        action: "governance.wealth_suitability.evaluated",
        result: result.status === "ready" ? "success" : "denied",
        severity: result.status === "ready" ? "info" : "medium",
        actorType: "agent",
        actorUserId: Number(user.id),
        actorRole: principal.principal.roleTemplate,
        targetType: "wealth_allocation_context",
        targetId: stableToolInputHash({ customerId }),
        agentInstanceId: adoptId,
        runtimeAgentId: principal.principal.agentId,
        sessionId: principal.principal.sessionId,
        toolName: name,
        policyCode: "WEALTH_SUITABILITY_MATCH",
        source: "platform_tools_mcp",
        ...auditRequest(req),
        metadata: {
          ruleVersion: result.evidence.ruleVersion,
          policySourceAssetId: result.policySource.sourceAssetId,
          policySourceVersion: result.policySource.versionLabel,
          contextEligibilityFingerprint: result.policySource.eligibilityFingerprint,
          policyDecisionIds: result.evidence.policyDecisionIds,
          eligibleProductCount: result.eligibleProducts.length,
          excludedProductCount: result.excludedProducts.length,
        },
      });
      return textResult(`EA_WEALTH_ALLOCATION_CONTEXT:${JSON.stringify({ ...result, readiness, executionEnvelope })}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "");
      const policyUnavailable = /policy|制度|knowledge/i.test(message);
      const readiness = evaluateWealthTaskReadiness({
        taskId: "WM-GT-04",
        checks: {
          identity: readinessCheck("READY", "PRINCIPAL_V2_READY", "岗位身份和授权快照已就绪。"),
          knowledge: policyUnavailable
            ? readinessCheck("BLOCKED", "CURRENT_POLICY_UNAVAILABLE", "当前有效适当性制度不可用。", { retryable: true })
            : readinessCheck("DEGRADED", "KNOWLEDGE_NOT_ASSEMBLED", "本轮未完成制度上下文装配。", { retryable: true }),
          customerData: readinessCheck("BLOCKED", "CUSTOMER_DATA_UNAVAILABLE", "当前客户数据不可用，不能形成正式推荐。", { retryable: true }),
          productData: readinessCheck("BLOCKED", "PRODUCT_DATA_UNAVAILABLE", "当前产品数据不可用，不能形成正式推荐。", { retryable: true }),
          policy: readinessCheck("BLOCKED", "SUITABILITY_POLICY_NOT_EVALUATED", "适当性判断尚未完成。", { retryable: true }),
          capability: readinessCheck("DEGRADED", "WEALTH_CONTEXT_DEPENDENCY_FAILED", "财富配置上下文依赖暂时不可用。", { retryable: true }),
          evidence: readinessCheck("DEGRADED", "POLICY_EVIDENCE_PARTIAL", "本轮仅保留依赖失败证据。", { retryable: true }),
        },
      });
      return textResult(`EA_WEALTH_ALLOCATION_CONTEXT:${JSON.stringify({
        schema: "ea.wealth-allocation-context.v1",
        status: "blocked",
        errorCode: policyUnavailable ? "POLICY_CONTEXT_UNAVAILABLE" : "BUSINESS_CONTEXT_UNAVAILABLE",
        message: policyUnavailable
          ? "当前有效适当性制度不可用，暂不能形成正式产品推荐。"
          : "客户或产品数据服务暂时不可用，可以先完成不依赖当前产品的资产结构分析。",
        readiness,
      })}`);
    }
  }

  if (name === "submit_agent_task") {
    const agentId = String(args.agent_id || args.agentId || "").trim();
    const task = String(args.task || args.message || "").trim();
    if (!agentId) return textResult("Error: agent_id is required", { isError: true });
    if (!task) return textResult("Error: task is required", { isError: true });
    const suppliedSourceMessageId = String(args.source_message_id || args.sourceMessageId || "").trim();
    const sourceMessageId = suppliedSourceMessageId || `mcp:${createHash("sha256")
      .update(`${String(requestIdentity ?? "")}:${stableToolInputHash({ agentId, task, args })}`)
      .digest("hex")}`;
    const data: any = await internalJson("/api/claw/agent-tasks/submit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(executionAuthority?.taskSnapshotId
          ? { "X-EA-Authorization-Snapshot-Id": executionAuthority.taskSnapshotId }
          : {}),
      },
      body: JSON.stringify({
        adoptId,
        agentId,
        task,
        conversationId: args.conversation_id || args.conversationId,
        sessionId: args.session_id || args.sessionId,
        sourceMessageId,
      }),
    });
    return textResult(`Agent task submitted. task_id=${data.taskId}. EA will track the asynchronous result and write it back when complete.`);
  }

  if (name === "create_scheduled_task") {
    const runAt = String(args.run_at || args.runAt || "").trim();
    const cronExpr = String(args.cron_expr || args.cronExpr || "").trim();
    if (Boolean(runAt) === Boolean(cronExpr)) {
      return textResult("请且仅提供 run_at（单次任务）或 cron_expr（周期任务）中的一个。", { isError: true });
    }
    if (runAt) {
      const parsedRunAt = new Date(runAt);
      if (!Number.isFinite(parsedRunAt.getTime()) || !/(?:z|[+-]\d{2}:\d{2})$/i.test(runAt)) {
        return textResult("run_at 必须是包含时区的 ISO 8601 时间，例如 2026-08-13T14:00:00+08:00。", { isError: true });
      }
      if (parsedRunAt.getTime() <= Date.now()) {
        return textResult("run_at 必须晚于当前时间。", { isError: true });
      }
    }
    const deliveryChannel = String(args.delivery_channel || args.deliveryChannel || "conversation").trim();
    const channelId = deliveryChannel === "conversation" ? "web" : deliveryChannel === "weixin" ? "wechat" : deliveryChannel;
    const job = {
      name: String(args.name || "scheduled task"),
      description: String(args.message || "").slice(0, 100),
      enabled: true,
      schedule: runAt
        ? { kind: "once", runAt, display: runAt }
        : { kind: "cron", cronExpr, display: cronExpr },
      payload: { kind: "agentTurn", message: String(args.message || "") },
      sessionTarget: "isolated",
      delivery: {
        targets: [{
          channelId,
          channelLabel: channelId === "web" ? "定时任务记录" : channelId,
        }],
      },
      meta: {
        taskAuthorizationSnapshotId: executionAuthority?.taskSnapshotId,
        executionAuthorityFingerprint: executionAuthority?.effectiveAuthorityFingerprint,
      },
    };
    const suppliedKey = String(args.idempotency_key || args.idempotencyKey || "").trim();
    const idempotencyKey = suppliedKey || `mcp:${createHash("sha256")
      .update(`${String(requestIdentity ?? "")}:${JSON.stringify(args)}`)
      .digest("hex")}`;
    await internalJson("/api/claw/cron/add", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(executionAuthority?.taskSnapshotId
          ? { "X-EA-Authorization-Snapshot-Id": executionAuthority.taskSnapshotId }
          : {}),
      },
      body: JSON.stringify({ adoptId, job, idempotencyKey }),
    });
    const scheduleSummary = runAt ? `one-time: ${runAt}` : `recurring cron: ${cronExpr}`;
    return textResult(`Scheduled task "${job.name}" created. Schedule: ${scheduleSummary}, delivery: ${deliveryChannel}.`);
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
      const finishMetric = beginMcpCall("platform");
      try {
        const result = await callTool(
          req,
          String(msg.params?.name || ""),
          msg.params?.arguments || {},
          id,
        );
        finishMetric(result.isError === true ? "error" : "success");
        return ok(id, result);
      } catch (error) {
        finishMetric("error");
        throw error;
      }
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

    const roleId = String(claw.roleTemplate || "").trim();
    if (!roleId) {
      return res.status(403).json({ ok: false, authorized: false, reason: "principal_role_missing" });
    }
    const assets = await resolveEffectiveRoleAssets(roleId);
    const allowedMcpServers = new Set([
      ...assets.mcpServers.default,
      ...assets.mcpServers.optional,
    ]);
    const authorized = allowedMcpServers.has(mcpServerId);

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
      await skillInstaller.installFromSource(runtimePath, sourceDir);

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
