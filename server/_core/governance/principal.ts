import type { ClawAdoption } from "../../../drizzle/schema";
import { resolveRuntimeWorkspaceByIds } from "../helpers";
import type { DelegationScope, RuntimePrincipal } from "./contracts";

export type PrincipalResolution = {
  principal: RuntimePrincipal;
  complete: boolean;
  issues: string[];
};

export function resolveRuntimePrincipal(input: {
  adoption: Pick<ClawAdoption, "userId" | "adoptId" | "agentId" | "roleTemplate" | "permissionProfile">;
  sessionId?: unknown;
  taskId?: unknown;
  delegationScope?: DelegationScope;
}): PrincipalResolution {
  const issues: string[] = [];
  const userId = Number(input.adoption.userId || 0);
  const adoptionId = String(input.adoption.adoptId || "").trim();
  const agentId = String(input.adoption.agentId || "").trim();
  const roleTemplate = String(input.adoption.roleTemplate || "").trim();
  const permissionProfile = String(input.adoption.permissionProfile || "").trim();
  const sessionId = String(input.sessionId || "").trim();
  if (!Number.isSafeInteger(userId) || userId <= 0) issues.push("userId");
  if (!adoptionId) issues.push("adoptionId");
  if (!agentId) issues.push("agentId");
  if (!roleTemplate) issues.push("roleTemplate");
  if (!permissionProfile) issues.push("permissionProfile");

  return {
    principal: {
      userId,
      adoptionId,
      agentId,
      roleTemplate,
      workspaceId: adoptionId && agentId ? resolveRuntimeWorkspaceByIds(adoptionId, agentId) : "",
      permissionProfile,
      sessionId,
      ...(String(input.taskId || "").trim() ? { taskId: String(input.taskId).trim() } : {}),
      ...(input.delegationScope ? { delegationScope: input.delegationScope } : {}),
    },
    complete: issues.length === 0,
    issues,
  };
}

export function principalSupportsSideEffect(
  resolution: PrincipalResolution,
  sideEffect: string,
): boolean {
  if (sideEffect === "read" || sideEffect === "compute") return true;
  return resolution.complete && Boolean(resolution.principal.workspaceId);
}
