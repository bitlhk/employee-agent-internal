import type { Request } from "express";
import path from "path";
import { COLLABORATION_GOAL_TOOLS } from "./collaboration/goal-tools";
import { COLLABORATION_PLATFORM_TOOLS } from "./collaboration/platform-tools";
import { issueCustomerSourceDelegation } from "./customer-context-source-delegation";
import { createConfiguredTwentyCustomerClient } from "./customer-context-twenty-access";
import { CUSTOMER_CRM_PLATFORM_TOOLS } from "./customer-crm-platform-tools";
import { fetchWithTimeout } from "./fetch-timeout";
import { GOVERNED_ROLE_POLICY_TOOLS } from "./governed-role-policy-tools";
import { GOVERNED_WORK_PLATFORM_TOOLS } from "./governed-work-platform-tools";
import { isAuthorizedInternalRequest } from "./helpers";
import { POST_LOAN_RISK_ESCALATION_TOOL } from "./post-loan-risk-tool-handler";
import { CASCADE_PLATFORM_TOOLS } from "./scheduling/cascade-tools";
import { SCHEDULING_PLATFORM_TOOLS } from "./scheduling/platform-tools";

export const SERVICE_NAME = "platform-tools";

export const SERVICE_VERSION = "1.0.0";

export function customerSourceAgentId(
  principal: Parameters<typeof issueCustomerSourceDelegation>[0]["principal"],
  toolName: string,
): string {
  return toolName === "wealth_assistant_customer_detail"
    || toolName === "wealth_assistant_customer_list"
    ? issueCustomerSourceDelegation({
        principal,
        sourceServerId: "wealth_assistant_customer",
      }).sourceAgentId
    : principal.agentId;
}

export async function wealthCustomerSourceId(input: {
  customerId: string;
  profileTarget: { toolName: string };
  portfolioTarget: { toolName: string };
}): Promise<string> {
  const usesLegacyWealthSource = input.profileTarget.toolName === "wealth_assistant_customer_detail"
    && input.portfolioTarget.toolName === "wealth_assistant_customer_detail";
  if (!usesLegacyWealthSource) {
    if (/^CUST-[0-9]{6}$/u.test(input.customerId)) return input.customerId;
    if (!/^C[0-9]{3}$/u.test(input.customerId)) return input.customerId;
    return await createConfiguredTwentyCustomerClient()
      .resolveGlobalCustomerId({
        customerId: input.customerId,
        allowedSourceSystems: ["wealth_assistant_customer"],
      }) || input.customerId;
  }
  if (!/^CUST-[0-9]{6}$/u.test(input.customerId)) return input.customerId;
  const sourceCustomerId = await createConfiguredTwentyCustomerClient()
    .resolveSourceCustomerId({
      globalCustomerId: input.customerId,
      sourceSystem: "wealth_assistant_customer",
    });
  if (!sourceCustomerId) throw new Error("客户统一标识缺少财富来源映射");
  return sourceCustomerId;
}

export type WealthAllocationDependency = "profile" | "portfolio" | "products" | "policy";

export class WealthAllocationDependencyError extends Error {
  constructor(
    readonly dependency: WealthAllocationDependency,
    readonly dependencyError: unknown,
  ) {
    super(dependencyError instanceof Error ? dependencyError.message : String(dependencyError || `${dependency} unavailable`));
    this.name = "WealthAllocationDependencyError";
  }
}

export function requiredCustomerFieldsMessage(labels: string[]): string {
  const fields = labels.length ? labels.join("、") : "当前任务必需的客户信息";
  return `当前客户缺少正式推荐必需信息：${fields}。请先向客户核实并补充，再进行产品适当性判断。`;
}

export async function loadWealthAllocationDependency<T>(
  dependency: WealthAllocationDependency,
  ready: Set<WealthAllocationDependency>,
  loader: () => Promise<T>,
): Promise<T> {
  try {
    const result = await loader();
    ready.add(dependency);
    return result;
  } catch (error) {
    throw new WealthAllocationDependencyError(dependency, error);
  }
}

export const PLATFORM_TOOLS = [
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
        governed_payload: {
          type: "object",
          description: "Optional governed structured payload. The target Agent must explicitly accept its schema.",
        },
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
  ...GOVERNED_WORK_PLATFORM_TOOLS,
  ...CUSTOMER_CRM_PLATFORM_TOOLS,
  ...SCHEDULING_PLATFORM_TOOLS,
  ...COLLABORATION_PLATFORM_TOOLS,
  ...COLLABORATION_GOAL_TOOLS,
  ...CASCADE_PLATFORM_TOOLS,
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
      "For a customer-specific formal recommendation, call this tool first and wait for its result; do not call customer profile, portfolio, policy, or product-list tools in parallel because this result already includes those facts.",
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
        task_id: { type: "string", enum: ["WM-GT-02", "WM-GT-04"], description: "Benchmark task contract. Defaults to WM-GT-02; use WM-GT-04 for an explicit risk-mismatch enforcement task." },
      },
      required: ["customer_id"],
    },
  },
  POST_LOAN_RISK_ESCALATION_TOOL,
  ...GOVERNED_ROLE_POLICY_TOOLS,
];

export const TOOL_NAMES = new Set(PLATFORM_TOOLS.map(tool => tool.name));

export function platformToolNames(): string[] {
  return Array.from(TOOL_NAMES).sort();
}

export function ok(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

export function err(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export function hasRequestId(id: unknown): boolean {
  return id !== undefined && id !== null;
}

export type PlatformToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
};

export function textResult(text: string, extra: Record<string, unknown> = {}): PlatformToolResult {
  return { content: [{ type: "text", text }], ...extra };
}

export function isAuthorized(req: Request): boolean {
  return isAuthorizedInternalRequest(req);
}

export function pathInside(child: string, parent: string): boolean {
  const normalizedChild = path.resolve(child);
  const normalizedParent = path.resolve(parent);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${path.sep}`);
}

export function pickHeader(req: Request, names: string[]): string {
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

export function resolveAdoptId(req: Request, args: Record<string, unknown>): string {
  const trustedAdoptId = pickHeader(req, [
    "x-agent-adopt-id",
    "x-workforce-agent-adopt-id",
    "x-jiuwen-channel-id",
    "x-openclaw-channel-id",
  ]);
  return resolvePlatformAdoptId(trustedAdoptId, args);
}

export async function internalJson(path: string, init: RequestInit = {}) {
  const base = process.env.INTERNAL_BASE_URL || process.env.WORKFORCE_AGENT_INTERNAL_BASE_URL || process.env.LINGXIA_INTERNAL_BASE_URL || "http://127.0.0.1:5180";
  const headers = new Headers(init.headers || {});
  headers.set("X-Internal-Key", process.env.INTERNAL_API_KEY || "");
  const resp = await fetchWithTimeout(`${base}${path}`, { ...init, headers });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(String((data as any)?.error || resp.status));
  return data;
}
