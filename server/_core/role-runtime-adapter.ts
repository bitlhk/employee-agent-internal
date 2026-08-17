import type { AgentRoleTemplate, AgentRuntime } from "./role-templates";
import type { EffectiveRoleAssets } from "./role-asset-grants";
import { retiredRuntimeMessage } from "./runtime-policy";

export type RoleRuntimeProvisionRuntime = AgentRuntime;

export type RoleRuntimeProvisionPlan = {
  requestedRuntime: AgentRuntime;
  runtime: RoleRuntimeProvisionRuntime;
  fallbackApplied: boolean;
  fallbackReason?: string;
};

export type RoleRuntimeProvisionInput = {
  adoptId: string;
  agentId: string;
  userId: number;
  permissionProfile: "starter" | "plus" | "internal";
  ttlDays: number;
  role: AgentRoleTemplate;
  effectiveAssets: EffectiveRoleAssets;
};

export type RoleRuntimeProvisionResult = {
  ok: boolean;
  mode: string;
  runtime: RoleRuntimeProvisionRuntime;
  result?: unknown;
  message?: string;
};

export type RoleRuntimeReconcileInput = {
  adoptId: string;
  agentId: string;
  role: AgentRoleTemplate;
  effectiveAssets: EffectiveRoleAssets;
  activeSkillIds?: string[];
  disabledDefaultSkillIds?: string[];
  includePlatformMcp?: boolean;
};

export type RoleRuntimeReconcileResult = {
  ok: boolean;
  applied: boolean;
  changed: number;
  skipped?: number;
  reason?: string;
};

export interface RoleRuntimeAdapter {
  readonly runtime: RoleRuntimeProvisionRuntime;
  provision(input: RoleRuntimeProvisionInput): Promise<RoleRuntimeProvisionResult> | RoleRuntimeProvisionResult;
  reconcileSkills(input: RoleRuntimeReconcileInput): Promise<RoleRuntimeReconcileResult> | RoleRuntimeReconcileResult;
  reconcileMcp(input: RoleRuntimeReconcileInput): Promise<RoleRuntimeReconcileResult> | RoleRuntimeReconcileResult;
  reconcileAssets?(input: RoleRuntimeReconcileInput): Promise<RoleRuntimeReconcileResult> | RoleRuntimeReconcileResult;
  refreshCapabilities(adoptId: string, agentId: string): Promise<number> | number;
  bumpSessionEpoch(adoptId: string, agentId: string): Promise<number> | number;
  audit(input: RoleRuntimeReconcileInput & { action: string; metadata?: Record<string, unknown> }): Promise<void> | void;
}

export async function reconcileRoleRuntimeAssets(
  adapter: RoleRuntimeAdapter,
  input: RoleRuntimeReconcileInput,
): Promise<RoleRuntimeReconcileResult> {
  if (adapter.reconcileAssets) return adapter.reconcileAssets(input);
  const skill = await adapter.reconcileSkills(input);
  const mcp = await adapter.reconcileMcp(input);
  return {
    ok: skill.ok && mcp.ok,
    applied: skill.applied || mcp.applied,
    changed: skill.changed + mcp.changed,
    reason: [skill.reason, mcp.reason].filter(Boolean).join("; "),
  };
}

export function resolveRoleRuntimeProvisionPlan(
  role: AgentRoleTemplate,
  options: {
    jiuwenswarmProvisionEnabled?: boolean;
    forceRuntime?: AgentRuntime | null;
  } = {},
): RoleRuntimeProvisionPlan {
  const requestedRuntime = options.forceRuntime || role.runtime;
  if (requestedRuntime !== "jiuwenswarm") {
    throw new Error(retiredRuntimeMessage());
  }
  return {
    requestedRuntime,
    runtime: requestedRuntime,
    fallbackApplied: false,
  };
}
