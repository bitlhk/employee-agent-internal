import type { ClawAdoption, User } from "../../../drizzle/schema";
import { resolveOrCreateAuthorizationSnapshot } from "../../db/runtime-principal";
import { resolveRuntimeWorkspaceByIds } from "../helpers";
import type { DelegationScope, RuntimePrincipal, RuntimePrincipalV2 } from "./contracts";

export type PrincipalResolution = {
  principal: RuntimePrincipal;
  complete: boolean;
  issues: string[];
};

export type PrincipalResolutionV2 = {
  principal: RuntimePrincipalV2;
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

export function buildRuntimePrincipalV2(input: {
  principal: RuntimePrincipal;
  tenantId: string;
  organizationId: string;
  authorizationSnapshotId: string;
  authorizationFingerprint: string;
}): RuntimePrincipalV2 {
  return {
    ...input.principal,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    authorizationSnapshotId: input.authorizationSnapshotId,
    authorizationFingerprint: input.authorizationFingerprint,
    identityVersion: "2",
  };
}

export async function resolveRuntimePrincipalV2(input: {
  adoption: Pick<ClawAdoption, "userId" | "adoptId" | "agentId" | "roleTemplate" | "permissionProfile">;
  user: Pick<User, "organization" | "groupId">;
  sessionId?: unknown;
  taskId?: unknown;
  delegationScope?: DelegationScope;
}): Promise<PrincipalResolutionV2> {
  const base = resolveRuntimePrincipal(input);
  const unresolved = buildRuntimePrincipalV2({
    principal: base.principal,
    tenantId: "",
    organizationId: "",
    authorizationSnapshotId: "",
    authorizationFingerprint: "",
  });
  if (!base.complete) return { principal: unresolved, complete: false, issues: base.issues };

  try {
    const snapshot = await resolveOrCreateAuthorizationSnapshot({
      userId: base.principal.userId,
      organizationName: input.user.organization,
      groupIds: input.user.groupId > 0 ? [input.user.groupId] : [],
      adoptionId: base.principal.adoptionId,
      agentId: base.principal.agentId,
      roleTemplate: base.principal.roleTemplate,
      workspaceId: base.principal.workspaceId,
      permissionProfile: base.principal.permissionProfile,
    });
    return {
      principal: buildRuntimePrincipalV2({ principal: base.principal, ...snapshot }),
      complete: true,
      issues: [],
    };
  } catch (error) {
    console.error("[Governance] Failed to resolve Runtime Principal V2:", error);
    return {
      principal: unresolved,
      complete: false,
      issues: [...base.issues, "authorizationSnapshot"],
    };
  }
}

export function principalSupportsSideEffect(
  resolution: PrincipalResolution,
  sideEffect: string,
): boolean {
  if (sideEffect === "read" || sideEffect === "compute") return true;
  return resolution.complete && Boolean(resolution.principal.workspaceId);
}
