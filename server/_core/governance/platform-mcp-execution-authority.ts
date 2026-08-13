import type { Request } from "express";
import type { ClawAdoption } from "../../../drizzle/schema";
import { getUserById } from "../../db";
import { auditRequest, recordAuditBestEffort } from "../audit-events";
import type { GovernanceOperation } from "./contracts";
import {
  authorizeExecutionAuthority,
  requiresExecutionAuthority,
  type ExecutionAuthorityDecision,
} from "./execution-authority";
import { resolveRuntimePrincipalV2, type PrincipalResolution } from "./principal";

export type PlatformMcpExecutionAuthorityResult = {
  allowed: boolean;
  reason?: string;
  principal: PrincipalResolution;
  decision: ExecutionAuthorityDecision | null;
};

export async function authorizePlatformMcpExecution(input: {
  req: Request;
  adoption: ClawAdoption;
  principal: PrincipalResolution;
  operation: GovernanceOperation;
}): Promise<PlatformMcpExecutionAuthorityResult> {
  if (!requiresExecutionAuthority(input.operation.sideEffect)) {
    return { allowed: true, principal: input.principal, decision: null };
  }
  const user = await getUserById(Number(input.adoption.userId));
  if (!user) return {
    allowed: false,
    reason: "当前用户身份不可用，已停止该操作。",
    principal: input.principal,
    decision: null,
  };
  const principalV2 = await resolveRuntimePrincipalV2({
    adoption: input.adoption,
    user,
    sessionId: input.principal.principal.sessionId,
  });
  if (!principalV2.complete) return {
    allowed: false,
    reason: "当前执行身份无法形成可验证授权快照，已停止该操作。",
    principal: input.principal,
    decision: null,
  };
  const decision = await authorizeExecutionAuthority({
    principal: principalV2.principal,
    taskAuthorizationSnapshotId: String(input.req.headers["x-ea-authorization-snapshot-id"] || "").trim() || null,
    operation: input.operation,
  });
  if (decision.effect !== "ALLOW") {
    await recordAuditBestEffort({
      action: "governance.execution_authority.blocked",
      result: "denied",
      severity: "high",
      actorType: "agent",
      actorUserId: principalV2.principal.userId,
      actorRole: principalV2.principal.roleTemplate,
      targetType: "platform_tool",
      targetId: input.operation.operation,
      workspaceId: principalV2.principal.workspaceId,
      agentInstanceId: principalV2.principal.adoptionId,
      runtimeAgentId: principalV2.principal.agentId,
      sessionId: principalV2.principal.sessionId,
      toolName: input.operation.operation,
      policyCode: decision.policyCode,
      source: "platform_tools_mcp",
      ...auditRequest(input.req),
      metadata: {
        ruleVersion: decision.ruleVersion,
        taskSnapshotId: decision.taskSnapshotId,
        currentSnapshotId: decision.currentSnapshotId,
        effectiveAuthorityFingerprint: decision.effectiveAuthorityFingerprint,
      },
    });
    return { allowed: false, reason: decision.reason, principal: principalV2, decision };
  }
  return {
    allowed: true,
    principal: { principal: decision.effectivePrincipal, complete: true, issues: [] },
    decision,
  };
}
