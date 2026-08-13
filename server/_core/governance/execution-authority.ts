import type { RuntimeAuthorizationSnapshot } from "../../../drizzle/schema";
import { getRuntimeAuthorizationSnapshot } from "../../db/runtime-principal";
import type { GovernanceOperation, RuntimePrincipalV2 } from "./contracts";
import { governanceFingerprint } from "./contracts";

type AuthorityRecord = {
  tenantId: string;
  organizationId: string;
  userId: number;
  adoptionId: string;
  agentId: string;
  roleTemplate: string;
  workspaceId: string;
  permissionProfile: string;
  groupIds: string[];
  membershipVersion: number;
};

export type ExecutionAuthorityDecision = {
  effect: "ALLOW" | "DENY";
  policyCode: string;
  ruleVersion: "execution-authority-v1";
  reason: string;
  effectivePrincipal: RuntimePrincipalV2;
  taskSnapshotId: string;
  currentSnapshotId: string;
  effectiveAuthorityFingerprint: string;
};

export function requiresExecutionAuthority(sideEffect: GovernanceOperation["sideEffect"]): boolean {
  return sideEffect !== "read" && sideEffect !== "compute";
}

const PROFILE_RANK: Record<string, number> = { starter: 1, plus: 2, internal: 3 };

function authority(snapshot: RuntimeAuthorizationSnapshot | undefined): AuthorityRecord | null {
  if (!snapshot || snapshot.status !== "active") return null;
  const raw = snapshot.authorityJson && typeof snapshot.authorityJson === "object"
    ? snapshot.authorityJson
    : {};
  const groupIds = Array.isArray(raw.groupIds)
    ? raw.groupIds.map((value) => String(value).trim()).filter(Boolean).sort()
    : [];
  return {
    tenantId: String(raw.tenantId || snapshot.tenantId),
    organizationId: String(raw.organizationId || snapshot.organizationId),
    userId: Number(raw.userId || snapshot.userId),
    adoptionId: String(raw.adoptionId || snapshot.adoptionId),
    agentId: String(raw.agentId || snapshot.agentId),
    roleTemplate: String(raw.roleTemplate || snapshot.roleTemplate),
    workspaceId: String(raw.workspaceId || snapshot.workspaceId),
    permissionProfile: String(raw.permissionProfile || snapshot.permissionProfile),
    groupIds,
    membershipVersion: Number(raw.membershipVersion || 0),
  };
}

function deny(input: {
  principal: RuntimePrincipalV2;
  taskSnapshotId: string;
  code: string;
  reason: string;
}): ExecutionAuthorityDecision {
  return {
    effect: "DENY",
    policyCode: input.code,
    ruleVersion: "execution-authority-v1",
    reason: input.reason,
    effectivePrincipal: input.principal,
    taskSnapshotId: input.taskSnapshotId,
    currentSnapshotId: input.principal.authorizationSnapshotId,
    effectiveAuthorityFingerprint: governanceFingerprint({ denied: input.code }),
  };
}

export function intersectExecutionAuthority(input: {
  principal: RuntimePrincipalV2;
  taskSnapshot: RuntimeAuthorizationSnapshot;
  currentSnapshot: RuntimeAuthorizationSnapshot;
  operation: GovernanceOperation;
}): ExecutionAuthorityDecision {
  const taskSnapshotId = input.taskSnapshot.snapshotId;
  const task = authority(input.taskSnapshot);
  const current = authority(input.currentSnapshot);
  if (!task || !current) return deny({
    principal: input.principal,
    taskSnapshotId,
    code: "EA_EXECUTION_AUTHORITY_REVOKED",
    reason: "任务授权或当前授权已失效，已停止执行。",
  });
  const stableFields = ["tenantId", "organizationId", "userId", "adoptionId", "agentId", "roleTemplate", "workspaceId"] as const;
  const mismatch = stableFields.find((field) => task[field] !== current[field] || current[field] !== input.principal[field]);
  if (mismatch) return deny({
    principal: input.principal,
    taskSnapshotId,
    code: "EA_EXECUTION_AUTHORITY_IDENTITY_CHANGED",
    reason: "任务执行身份或岗位边界已经变化，请重新发起任务。",
  });
  const taskRank = PROFILE_RANK[task.permissionProfile] || 0;
  const currentRank = PROFILE_RANK[current.permissionProfile] || 0;
  if (!taskRank || !currentRank) return deny({
    principal: input.principal,
    taskSnapshotId,
    code: "EA_EXECUTION_AUTHORITY_PROFILE_UNKNOWN",
    reason: "当前权限配置无法验证，已停止执行。",
  });
  const permissionProfile = taskRank <= currentRank ? task.permissionProfile : current.permissionProfile;
  const currentGroups = new Set(current.groupIds);
  const effectiveGroupIds = task.groupIds.filter((groupId) => currentGroups.has(groupId));
  const effectiveAuthority = {
    tenantId: current.tenantId,
    organizationId: current.organizationId,
    userId: current.userId,
    adoptionId: current.adoptionId,
    agentId: current.agentId,
    roleTemplate: current.roleTemplate,
    workspaceId: current.workspaceId,
    permissionProfile,
    groupIds: effectiveGroupIds,
    taskMembershipVersion: task.membershipVersion,
    currentMembershipVersion: current.membershipVersion,
    operation: {
      capabilityId: input.operation.capabilityId,
      sideEffect: input.operation.sideEffect,
      resource: input.operation.resource || null,
    },
  };
  const effectiveAuthorityFingerprint = governanceFingerprint(effectiveAuthority);
  return {
    effect: "ALLOW",
    policyCode: "EA_EXECUTION_AUTHORITY_INTERSECTION_V1",
    ruleVersion: "execution-authority-v1",
    reason: "执行权限已按任务快照、当前权限和当前操作取交集。",
    effectivePrincipal: {
      ...input.principal,
      permissionProfile,
      authorizationSnapshotId: taskSnapshotId,
      authorizationFingerprint: effectiveAuthorityFingerprint,
    },
    taskSnapshotId,
    currentSnapshotId: input.currentSnapshot.snapshotId,
    effectiveAuthorityFingerprint,
  };
}

export async function authorizeExecutionAuthority(input: {
  principal: RuntimePrincipalV2;
  taskAuthorizationSnapshotId?: string | null;
  operation: GovernanceOperation;
}): Promise<ExecutionAuthorityDecision> {
  const taskSnapshotId = String(input.taskAuthorizationSnapshotId || input.principal.authorizationSnapshotId).trim();
  const [taskSnapshot, currentSnapshot] = await Promise.all([
    getRuntimeAuthorizationSnapshot(taskSnapshotId),
    getRuntimeAuthorizationSnapshot(input.principal.authorizationSnapshotId),
  ]);
  if (!taskSnapshot || !currentSnapshot) return deny({
    principal: input.principal,
    taskSnapshotId,
    code: "EA_EXECUTION_AUTHORITY_SNAPSHOT_MISSING",
    reason: "任务授权快照无法验证，已停止执行。",
  });
  return intersectExecutionAuthority({
    principal: input.principal,
    taskSnapshot,
    currentSnapshot,
    operation: input.operation,
  });
}
