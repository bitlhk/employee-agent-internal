import type { ToolSideEffect } from "./tool-governance";
import { governanceFingerprint } from "./governance/contracts";

export type A2ACapabilityIntentSideEffect = Exclude<ToolSideEffect, "read" | "compute">;

const SIDE_EFFECTS = new Set<A2ACapabilityIntentSideEffect>([
  "workspace_write", "write", "external_send", "financial_action", "approval_action", "admin_action",
]);

export type A2ACapabilityIntent = {
  schema: "ea.capability-intent.v1";
  intentId: string;
  capabilityId: string;
  operation: string;
  sideEffect: A2ACapabilityIntentSideEffect;
  resource?: string;
  arguments: Record<string, unknown>;
  idempotencyKey?: string;
  intentFingerprint: string;
  executionStatus: "pending_local_governance";
};

function normalize(value: Record<string, unknown>): A2ACapabilityIntent | null {
  if (value.schema !== "ea.capability-intent.v1") return null;
  const capabilityId = String(value.capabilityId || value.capability_id || "").trim().slice(0, 128);
  const operation = String(value.operation || "").trim().slice(0, 128);
  const sideEffect = String(value.sideEffect || value.side_effect || "") as A2ACapabilityIntentSideEffect;
  const args = value.arguments && typeof value.arguments === "object" && !Array.isArray(value.arguments)
    ? value.arguments as Record<string, unknown>
    : {};
  if (!capabilityId || !operation || !SIDE_EFFECTS.has(sideEffect)) return null;
  try {
    if (Buffer.byteLength(JSON.stringify(args), "utf8") > 64 * 1024) return null;
  } catch {
    return null;
  }
  const resource = String(value.resource || "").trim().slice(0, 256) || undefined;
  const idempotencyKey = String(value.idempotencyKey || value.idempotency_key || "").trim().slice(0, 191) || undefined;
  const body = { capabilityId, operation, sideEffect, resource: resource || null, arguments: args, idempotencyKey: idempotencyKey || null };
  const intentFingerprint = governanceFingerprint(body);
  const suppliedId = String(value.intentId || value.intent_id || "").trim();
  return {
    schema: "ea.capability-intent.v1",
    intentId: /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(suppliedId) ? suppliedId : `intent_${intentFingerprint.slice(0, 24)}`,
    capabilityId,
    operation,
    sideEffect,
    ...(resource ? { resource } : {}),
    arguments: args,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    intentFingerprint,
    executionStatus: "pending_local_governance",
  };
}

export function collectA2ACapabilityIntents(value: unknown): A2ACapabilityIntent[] {
  const intents = new Map<string, A2ACapabilityIntent>();
  const visit = (node: unknown, depth = 0): void => {
    if (depth > 12 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, depth + 1));
      return;
    }
    const record = node as Record<string, unknown>;
    const normalized = normalize(record);
    if (normalized) intents.set(normalized.intentId, normalized);
    for (const key of ["data", "value", "parts", "message", "status", "result", "artifact", "artifacts", "task"]) {
      if (key in record) visit(record[key], depth + 1);
    }
  };
  visit(value);
  return Array.from(intents.values()).slice(0, 20);
}

export function capabilityIntentResultNotice(intents: A2ACapabilityIntent[]): string {
  if (!intents.length) return "";
  return [
    "### 待执行的业务动作",
    `远端专家提出 ${intents.length} 项业务动作，均未直接执行。`,
    "这些动作必须回到岗位智能体，由 EA 治理网关重新校验当前权限、参数、人工确认和幂等后才能执行。",
  ].join("\n");
}
