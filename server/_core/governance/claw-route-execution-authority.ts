import type { Request } from "express";
import type { ClawAdoption } from "../../../drizzle/schema";
import { getUserById } from "../../db/users";
import { auditRequest, recordAuditBestEffort } from "../audit-events";
import type { GovernanceOperation, RuntimePrincipalV2 } from "./contracts";
import { authorizeExecutionAuthority } from "./execution-authority";
import { resolveRuntimePrincipal, resolveRuntimePrincipalV2 } from "./principal";

export type ClawRouteExecutionAuthorityCheck = {
  allowed: boolean;
  policyCode: string;
  reason: string;
  taskSnapshotId: string;
  currentSnapshotId?: string;
  effectiveAuthorityFingerprint?: string;
  effectivePrincipal?: RuntimePrincipalV2;
};

function header(req: Request | undefined, name: string): string {
  return String(req?.headers?.[name] || "").trim();
}

export function requestTaskAuthorizationSnapshotId(req?: Request): string | null {
  return header(req, "x-ea-authorization-snapshot-id") || null;
}

export async function authorizeClawRouteExecution(input: {
  req?: Request;
  claw: ClawAdoption;
  operation: GovernanceOperation;
  source: string;
  sessionId?: unknown;
  taskAuthorizationSnapshotId?: string | null;
}): Promise<ClawRouteExecutionAuthorityCheck> {
  const userId = Number(input.claw.userId || 0);
  const user = userId ? await getUserById(userId) : null;
  const taskSnapshotId = String(
    input.taskAuthorizationSnapshotId || requestTaskAuthorizationSnapshotId(input.req) || "",
  ).trim();
  let result: ClawRouteExecutionAuthorityCheck;

  if (!user) {
    result = {
      allowed: false,
      policyCode: "EA_EXECUTION_AUTHORITY_USER_MISSING",
      reason: "当前用户身份不可用，已停止该操作。",
      taskSnapshotId,
    };
  } else {
    const principalV2 = await resolveRuntimePrincipalV2({
      adoption: input.claw,
      user,
      sessionId: input.sessionId
        || header(input.req, "x-linggan-session-id")
        || header(input.req, "x-jiuwen-session-id"),
    });
    if (!principalV2.complete) {
      result = {
        allowed: false,
        policyCode: "EA_EXECUTION_AUTHORITY_PRINCIPAL_INCOMPLETE",
        reason: "当前执行身份无法形成可验证授权快照，已停止该操作。",
        taskSnapshotId,
      };
    } else {
      const decision = await authorizeExecutionAuthority({
        principal: principalV2.principal,
        taskAuthorizationSnapshotId: taskSnapshotId || null,
        operation: input.operation,
      });
      result = {
        allowed: decision.effect === "ALLOW",
        policyCode: decision.policyCode,
        reason: decision.reason,
        taskSnapshotId: decision.taskSnapshotId,
        currentSnapshotId: decision.currentSnapshotId,
        effectiveAuthorityFingerprint: decision.effectiveAuthorityFingerprint,
        effectivePrincipal: decision.effectivePrincipal,
      };
    }
  }

  if (!result.allowed) {
    const principal = resolveRuntimePrincipal({ adoption: input.claw, sessionId: input.sessionId });
    await recordAuditBestEffort({
      action: "governance.execution_authority.blocked",
      result: "denied",
      severity: "high",
      actorType: "agent",
      actorUserId: principal.principal.userId || null,
      actorRole: principal.principal.roleTemplate || null,
      targetType: "capability",
      targetId: input.operation.capabilityId,
      resourceType: input.operation.resource ? "governed_resource" : null,
      resourceId: input.operation.resource || null,
      workspaceId: principal.principal.workspaceId || null,
      agentInstanceId: principal.principal.adoptionId || null,
      runtimeAgentId: principal.principal.agentId || null,
      sessionId: principal.principal.sessionId || null,
      toolName: input.operation.operation,
      policyCode: result.policyCode,
      source: input.source,
      ...(input.req ? auditRequest(input.req) : {}),
      metadata: {
        taskSnapshotId: result.taskSnapshotId || null,
        currentSnapshotId: result.currentSnapshotId || null,
        effectiveAuthorityFingerprint: result.effectiveAuthorityFingerprint || null,
        sideEffect: input.operation.sideEffect,
      },
    });
  }

  return result;
}
