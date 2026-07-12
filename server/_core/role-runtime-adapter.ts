import type { AgentRoleTemplate, AgentRuntime } from "./role-templates";
import type { EffectiveRoleAssets } from "./role-asset-grants";

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
  bumpSessionEpoch(adoptId: string, agentId: string): Promise<number> | number;
  audit(input: RoleRuntimeReconcileInput & { action: string; metadata?: Record<string, unknown> }): Promise<void> | void;
}

export function resolveRoleRuntimeProvisionPlan(
  role: AgentRoleTemplate,
  options: {
    jiuwenswarmProvisionEnabled?: boolean;
    forceRuntime?: AgentRuntime | null;
  } = {},
): RoleRuntimeProvisionPlan {
  const requestedRuntime = options.forceRuntime || role.runtime;
  return {
    requestedRuntime,
    runtime: requestedRuntime,
    fallbackApplied: false,
  };
}
