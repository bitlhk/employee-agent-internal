import { describe, expect, it } from "vitest";
import type { RuntimeAuthorizationSnapshot } from "../../../drizzle/schema";
import type { RuntimePrincipalV2 } from "./contracts";
import { intersectExecutionAuthority } from "./execution-authority";

const principal = {
  tenantId: "tn-1", organizationId: "org-1", userId: 7, adoptionId: "lgj-1", agentId: "agent-1",
  roleTemplate: "wealth-manager", workspaceId: "/tmp/wealth", permissionProfile: "plus",
  authorizationSnapshotId: "auth-current", authorizationFingerprint: "a".repeat(64),
  sessionId: "session-1", identityVersion: "2",
} satisfies RuntimePrincipalV2;

function snapshot(input: { id: string; profile?: string; status?: "active" | "revoked"; role?: string }): RuntimeAuthorizationSnapshot {
  const permissionProfile = input.profile || "plus";
  return {
    id: 1,
    snapshotId: input.id,
    authorizationFingerprint: "b".repeat(64),
    tenantId: "tn-1",
    organizationId: "org-1",
    userId: 7,
    adoptionId: "lgj-1",
    agentId: "agent-1",
    roleTemplate: input.role || "wealth-manager",
    workspaceId: "/tmp/wealth",
    permissionProfile,
    authorityJson: {
      tenantId: "tn-1", organizationId: "org-1", userId: 7, adoptionId: "lgj-1", agentId: "agent-1",
      roleTemplate: input.role || "wealth-manager", workspaceId: "/tmp/wealth", permissionProfile,
      groupIds: ["3", "8"], membershipVersion: 2,
    },
    status: input.status || "active",
    createdAt: new Date(),
    revokedAt: input.status === "revoked" ? new Date() : null,
  };
}

const operation = { capabilityId: "enterprise.mcp", operation: "update", sideEffect: "write" as const, resource: "customer:1" };

describe("execution authority intersection", () => {
  it("never expands authority acquired after task start", () => {
    const result = intersectExecutionAuthority({
      principal: { ...principal, permissionProfile: "internal" },
      taskSnapshot: snapshot({ id: "auth-task", profile: "plus" }),
      currentSnapshot: snapshot({ id: "auth-current", profile: "internal" }),
      operation,
    });
    expect(result.effect).toBe("ALLOW");
    expect(result.effectivePrincipal.permissionProfile).toBe("plus");
  });

  it("shrinks a task when current authority is reduced", () => {
    const result = intersectExecutionAuthority({
      principal: { ...principal, permissionProfile: "starter" },
      taskSnapshot: snapshot({ id: "auth-task", profile: "internal" }),
      currentSnapshot: snapshot({ id: "auth-current", profile: "starter" }),
      operation,
    });
    expect(result.effect).toBe("ALLOW");
    expect(result.effectivePrincipal.permissionProfile).toBe("starter");
  });

  it("fails closed after revocation or role identity changes", () => {
    const revoked = intersectExecutionAuthority({
      principal,
      taskSnapshot: snapshot({ id: "auth-task" }),
      currentSnapshot: snapshot({ id: "auth-current", status: "revoked" }),
      operation,
    });
    const changed = intersectExecutionAuthority({
      principal,
      taskSnapshot: snapshot({ id: "auth-task", role: "insurance-advisor" }),
      currentSnapshot: snapshot({ id: "auth-current" }),
      operation,
    });
    expect(revoked.effect).toBe("DENY");
    expect(changed.effect).toBe("DENY");
  });
});
