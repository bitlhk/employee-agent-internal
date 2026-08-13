import type { A2ACapabilityIntent } from "./a2a-capability-intent";
import { stableToolInputHash } from "./tool-governance";

export type A2ACapabilityIntentBinding = {
  bindingId: string;
  bindingVersion: string;
  capabilityId: string;
  operation: string;
  sideEffect: A2ACapabilityIntent["sideEffect"];
  displayName: string;
  targetServerId: string;
  targetToolName: string;
};

export type ResolvedA2ACapabilityIntentBinding = {
  binding: A2ACapabilityIntentBinding;
  arguments: Record<string, unknown>;
  payloadHash: string;
  idempotencyKey: string;
};

export class A2ACapabilityIntentBindingError extends Error {
  constructor(
    readonly code: "UNSUPPORTED_INTENT" | "SIDE_EFFECT_MISMATCH" | "INVALID_ARGUMENTS",
    message: string,
  ) {
    super(message);
  }
}

const WEALTH_DEMO_FOLLOWUP: A2ACapabilityIntentBinding = {
  bindingId: "linggan-bank.wealth-demo.create-followup",
  bindingVersion: "1.0.0",
  capabilityId: "enterprise.crm",
  operation: "create_followup",
  sideEffect: "write",
  displayName: "创建 Demo 客户跟进任务",
  targetServerId: "wealth_governance_demo",
  targetToolName: "demo_create_followup_task",
};

export const A2A_CAPABILITY_INTENT_BINDINGS: readonly A2ACapabilityIntentBinding[] = [
  WEALTH_DEMO_FOLLOWUP,
] as const;

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

export function resolveA2ACapabilityIntentBinding(
  intent: A2ACapabilityIntent,
): ResolvedA2ACapabilityIntentBinding {
  const binding = A2A_CAPABILITY_INTENT_BINDINGS.find(item => (
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
    : (() => { throw new A2ACapabilityIntentBindingError("UNSUPPORTED_INTENT", "平台未实现该业务动作绑定。"); })();
  return {
    binding,
    arguments: args,
    payloadHash: stableToolInputHash(args),
    idempotencyKey: String(args.idempotency_key),
  };
}
