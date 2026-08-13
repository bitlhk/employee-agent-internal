import type { A2ACapabilityIntent } from "./a2a-capability-intent";
import { stableToolInputHash } from "./tool-governance";
import { z } from "zod";

export type A2ACapabilityIntentBinding = {
  schema: "ea.a2a-capability-binding.v1";
  mode: "demo" | "production";
  bindingId: string;
  bindingVersion: string;
  capabilityId: string;
  operation: string;
  sideEffect: A2ACapabilityIntent["sideEffect"];
  displayName: string;
  targetServerId: string;
  targetToolName: string;
  argumentMap?: Record<string, string>;
  requiredArguments?: string[];
  approvalRequired: boolean;
  idempotencyRequired: boolean;
  identityRequired: boolean;
};

export type ResolvedA2ACapabilityIntentBinding = {
  binding: A2ACapabilityIntentBinding;
  arguments: Record<string, unknown>;
  payloadHash: string;
  idempotencyKey: string;
};

export class A2ACapabilityIntentBindingError extends Error {
  constructor(
    readonly code: "UNSUPPORTED_INTENT" | "SIDE_EFFECT_MISMATCH" | "INVALID_ARGUMENTS" | "BINDING_CONFIG_INVALID",
    message: string,
  ) {
    super(message);
  }
}

const WEALTH_DEMO_FOLLOWUP: A2ACapabilityIntentBinding = {
  schema: "ea.a2a-capability-binding.v1",
  mode: "demo",
  bindingId: "linggan-bank.wealth-demo.create-followup",
  bindingVersion: "1.0.0",
  capabilityId: "enterprise.crm",
  operation: "create_followup",
  sideEffect: "write",
  displayName: "创建 Demo 客户跟进任务",
  targetServerId: "wealth_governance_demo",
  targetToolName: "demo_create_followup_task",
  approvalRequired: true,
  idempotencyRequired: true,
  identityRequired: true,
};

export const A2A_CAPABILITY_INTENT_BINDINGS: readonly A2ACapabilityIntentBinding[] = [
  WEALTH_DEMO_FOLLOWUP,
] as const;

const productionBindingSchema = z.object({
  schema: z.literal("ea.a2a-capability-binding.v1"),
  mode: z.literal("production"),
  bindingId: z.string().min(3).max(128).regex(/^[a-zA-Z0-9._-]+$/),
  bindingVersion: z.string().min(1).max(64),
  capabilityId: z.string().min(1).max(128),
  operation: z.string().min(1).max(128),
  sideEffect: z.enum(["workspace_write", "write", "external_send", "financial_action", "approval_action", "admin_action"]),
  displayName: z.string().min(1).max(160),
  targetServerId: z.string().min(3).max(128),
  targetToolName: z.string().min(1).max(256),
  argumentMap: z.record(z.string().min(1).max(128), z.string().min(1).max(128)).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 64),
  requiredArguments: z.array(z.string().min(1).max(128)).max(64).default([]),
  approvalRequired: z.literal(true),
  idempotencyRequired: z.literal(true),
  identityRequired: z.literal(true),
}).superRefine((value, ctx) => {
  const mapped = new Set(Object.keys(value.argumentMap));
  for (const required of value.requiredArguments) {
    if (!mapped.has(required)) ctx.addIssue({ code: "custom", path: ["requiredArguments"], message: `必填参数 ${required} 未在 argumentMap 中声明` });
  }
  if (new Set(Object.values(value.argumentMap)).size !== Object.values(value.argumentMap).length) {
    ctx.addIssue({ code: "custom", path: ["argumentMap"], message: "多个远端参数不能映射到同一个目标字段" });
  }
});

let cachedRaw = "";
let cachedProductionBindings: A2ACapabilityIntentBinding[] = [];

export function parseProductionA2ACapabilityBindings(raw: string): A2ACapabilityIntentBinding[] {
  const value = raw.trim();
  if (!value) return [];
  if (Buffer.byteLength(value, "utf8") > 256 * 1024) throw new Error("A2A binding config exceeds 256 KiB");
  const parsed = z.array(productionBindingSchema).max(50).parse(JSON.parse(value));
  const identities = new Set<string>();
  for (const binding of parsed) {
    const identity = `${binding.capabilityId}\u0000${binding.operation}`;
    if (identities.has(identity)) throw new Error(`Duplicate A2A capability binding: ${binding.capabilityId}/${binding.operation}`);
    identities.add(identity);
  }
  return parsed;
}

export function configuredA2ACapabilityIntentBindings(env: NodeJS.ProcessEnv = process.env): readonly A2ACapabilityIntentBinding[] {
  const raw = String(env.EA_A2A_CAPABILITY_BINDINGS_JSON || "");
  if (raw !== cachedRaw) {
    try {
      cachedProductionBindings = parseProductionA2ACapabilityBindings(raw);
      cachedRaw = raw;
    } catch (error) {
      cachedRaw = "";
      cachedProductionBindings = [];
      throw new A2ACapabilityIntentBindingError(
        "BINDING_CONFIG_INVALID",
        `生产 A2A 能力绑定配置无效，已关闭相关执行：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return [...A2A_CAPABILITY_INTENT_BINDINGS, ...cachedProductionBindings];
}

function stringArgument(args: Record<string, unknown>, names: string[], maxLength: number): string {
  for (const name of names) {
    const value = String(args[name] || "").trim();
    if (value) return value.slice(0, maxLength);
  }
  return "";
}

function wealthDemoFollowupArguments(intent: A2ACapabilityIntent): Record<string, unknown> {
  const customerRef = stringArgument(intent.arguments, ["customer_ref", "customerRef", "customerId"], 128);
  const objective = stringArgument(intent.arguments, ["objective", "subject"], 500);
  const rawDueAt = stringArgument(intent.arguments, ["due_at", "dueAt"], 64);
  const dueTimestamp = Date.parse(rawDueAt);
  const priority = stringArgument(intent.arguments, ["priority"], 16) || "medium";
  const sourceEventRef = stringArgument(intent.arguments, ["source_event_ref", "sourceEventRef"], 128);
  const idempotencyKey = String(
    intent.idempotencyKey
    || intent.arguments.idempotency_key
    || intent.arguments.idempotencyKey
    || "",
  ).trim().slice(0, 191);

  if (!customerRef || !/(?:^|[（(\s_-])demo(?:$|[）)\s_-])/i.test(customerRef)) {
    throw new A2ACapabilityIntentBindingError("INVALID_ARGUMENTS", "参考执行器只接受明确标注 Demo 的客户称谓。");
  }
  if (!objective) throw new A2ACapabilityIntentBindingError("INVALID_ARGUMENTS", "跟进目标不能为空。");
  if (!Number.isFinite(dueTimestamp)) throw new A2ACapabilityIntentBindingError("INVALID_ARGUMENTS", "跟进时间必须为有效的 ISO 8601 时间。");
  if (!["high", "medium", "low"].includes(priority)) {
    throw new A2ACapabilityIntentBindingError("INVALID_ARGUMENTS", "跟进优先级必须为 high、medium 或 low。");
  }
  if (idempotencyKey.length < 8) {
    throw new A2ACapabilityIntentBindingError("INVALID_ARGUMENTS", "业务写入必须提供至少 8 位幂等键。");
  }

  return {
    customer_ref: customerRef,
    objective,
    due_at: new Date(dueTimestamp).toISOString(),
    priority,
    ...(sourceEventRef ? { source_event_ref: sourceEventRef } : {}),
    idempotency_key: idempotencyKey,
  };
}

function productionArguments(binding: A2ACapabilityIntentBinding, intent: A2ACapabilityIntent): Record<string, unknown> {
  const idempotencyKey = String(intent.idempotencyKey || intent.arguments.idempotency_key || intent.arguments.idempotencyKey || "").trim().slice(0, 191);
  if (binding.idempotencyRequired && idempotencyKey.length < 8) {
    throw new A2ACapabilityIntentBindingError("INVALID_ARGUMENTS", "生产业务动作必须提供至少 8 位幂等键。");
  }
  const args: Record<string, unknown> = {};
  for (const required of binding.requiredArguments || []) {
    const value = intent.arguments[required];
    if (value === undefined || value === null || value === "") {
      throw new A2ACapabilityIntentBindingError("INVALID_ARGUMENTS", `远端业务动作缺少必填参数: ${required}`);
    }
  }
  for (const [source, target] of Object.entries(binding.argumentMap || {})) {
    if (!(source in intent.arguments)) continue;
    args[target] = intent.arguments[source];
  }
  if (binding.idempotencyRequired) args.idempotency_key = idempotencyKey;
  try {
    if (Buffer.byteLength(JSON.stringify(args), "utf8") > 64 * 1024) throw new Error("too large");
  } catch {
    throw new A2ACapabilityIntentBindingError("INVALID_ARGUMENTS", "映射后的业务参数无效或超过 64 KiB。");
  }
  return args;
}

export function resolveA2ACapabilityIntentBinding(
  intent: A2ACapabilityIntent,
  bindings: readonly A2ACapabilityIntentBinding[] = configuredA2ACapabilityIntentBindings(),
): ResolvedA2ACapabilityIntentBinding {
  const binding = bindings.find(item => (
    item.capabilityId === intent.capabilityId && item.operation === intent.operation
  ));
  if (!binding) {
    throw new A2ACapabilityIntentBindingError(
      "UNSUPPORTED_INTENT",
      "该远端业务动作尚未绑定到平台受治理能力，已保持未执行。",
    );
  }
  if (intent.sideEffect !== binding.sideEffect) {
    throw new A2ACapabilityIntentBindingError(
      "SIDE_EFFECT_MISMATCH",
      "远端声明的副作用类型与平台绑定不一致，已拒绝执行。",
    );
  }
  const args = binding.bindingId === WEALTH_DEMO_FOLLOWUP.bindingId
    ? wealthDemoFollowupArguments(intent)
    : binding.mode === "production"
      ? productionArguments(binding, intent)
      : (() => { throw new A2ACapabilityIntentBindingError("UNSUPPORTED_INTENT", "平台未实现该业务动作绑定。"); })();
  return {
    binding,
    arguments: args,
    payloadHash: stableToolInputHash(args),
    idempotencyKey: String(args.idempotency_key),
  };
}

export function assertProductionA2ABindingRuntime(input: {
  binding: A2ACapabilityIntentBinding;
  connection: {
    environment?: string | null;
    lifecycleState?: string | null;
    authMode?: string | null;
    identityVerificationStatus?: string | null;
  } | null;
  policy: {
    toolName?: string | null;
    enabled?: boolean | number | null;
    sideEffect?: string | null;
    approvalMode?: string | null;
    idempotencyRequired?: boolean | number | null;
  } | null;
}): void {
  if (input.binding.mode !== "production") return;
  const connection = input.connection;
  const policy = input.policy;
  const valid = connection?.environment === "prod"
    && connection.lifecycleState === "enforced"
    && connection.authMode === "oauth2_access_token"
    && connection.identityVerificationStatus === "verified"
    && policy?.toolName === input.binding.targetToolName
    && Boolean(policy.enabled)
    && policy.sideEffect === input.binding.sideEffect
    && policy.approvalMode !== "never"
    && Boolean(policy.idempotencyRequired);
  if (!valid) {
    throw new A2ACapabilityIntentBindingError(
      "BINDING_CONFIG_INVALID",
      "生产 A2A 业务动作尚未绑定到已验明身份、强制治理且启用确认和幂等的企业能力，已保持未执行。",
    );
  }
}
