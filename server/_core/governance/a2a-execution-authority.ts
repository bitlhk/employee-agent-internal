import type { Request } from "express";
import type { ClawAdoption } from "../../../drizzle/schema";
import { getUserById } from "../../db/users";
import { auditRequest, recordAuditBestEffort } from "../audit-events";
import { stableToolInputHash } from "../tool-governance";
import { authorizeExecutionAuthority } from "./execution-authority";
import { resolveRuntimePrincipal, resolveRuntimePrincipalV2 } from "./principal";
import type { RuntimePrincipalV2 } from "./contracts";

export type A2AExecutionAuthorityCheck = {
  allowed: boolean;
  policyCode: string;
  reason: string;
  taskSnapshotId: string;
  currentSnapshotId?: string;
  effectiveAuthorityFingerprint?: string;
  effectivePrincipal?: RuntimePrincipalV2;
};

export async function authorizeA2AExecution(input: {
  req?: Request;
  claw: ClawAdoption;
  agentId: string;
  taskInput: string;
  sessionId?: unknown;
  dataPart?: Record<string, unknown>;
  taskAuthorizationSnapshotId?: string | null;
}): Promise<A2AExecutionAuthorityCheck> {
  const userId = Number(input.claw.userId || 0);
  const user = userId ? await getUserById(userId) : null;
  let result: A2AExecutionAuthorityCheck;
  if (!user) {
    result = {
      allowed: false,
      policyCode: "EA_EXECUTION_AUTHORITY_USER_MISSING",
      reason: "当前用户身份不可用，已停止外部 Agent 任务。",
      taskSnapshotId: String(input.taskAuthorizationSnapshotId || ""),
    };
  } else {
    const principalV2 = await resolveRuntimePrincipalV2({
      adoption: input.claw,
      user,
      sessionId: input.sessionId,
    });
    if (!principalV2.complete) {
      result = {
        allowed: false,
        policyCode: "EA_EXECUTION_AUTHORITY_PRINCIPAL_INCOMPLETE",
        reason: "当前执行身份无法形成可验证授权快照，已停止外部 Agent 任务。",
        taskSnapshotId: String(input.taskAuthorizationSnapshotId || ""),
      };
    } else {
      const decision = await authorizeExecutionAuthority({
        principal: principalV2.principal,
        taskAuthorizationSnapshotId: input.taskAuthorizationSnapshotId,
        operation: {
          capabilityId: "a2a.task",
          operation: "submit_agent_task",
          sideEffect: "external_send",
          resource: `business-agent:${input.agentId}`,
          payloadHash: stableToolInputHash({ input: input.taskInput, dataPart: input.dataPart || null }),
        },
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
      targetType: "business_agent",
      targetId: input.agentId,
      workspaceId: principal.principal.workspaceId || null,
      agentInstanceId: principal.principal.adoptionId || null,
      runtimeAgentId: principal.principal.agentId || null,
      sessionId: principal.principal.sessionId || null,
      policyCode: result.policyCode,
      source: "a2a_execution_authority",
      ...(input.req ? auditRequest(input.req) : {}),
      metadata: {
        taskSnapshotId: result.taskSnapshotId || null,
        currentSnapshotId: result.currentSnapshotId || null,
        effectiveAuthorityFingerprint: result.effectiveAuthorityFingerprint || null,
      },
    });
  }
  return result;
}
