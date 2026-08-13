import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveSnapshot } = vi.hoisted(() => ({ resolveSnapshot: vi.fn() }));

vi.mock("../../db/runtime-principal", () => ({
  resolveOrCreateAuthorizationSnapshot: resolveSnapshot,
}));

import { principalFingerprint } from "./contracts";
import { buildRuntimePrincipalV2, resolveRuntimePrincipalV2 } from "./principal";

const adoption = {
  userId: 7,
  adoptId: "lgj-demo",
  agentId: "agent-demo",
  roleTemplate: "wealth-manager",
  permissionProfile: "plus",
};

describe("Runtime Principal V2", () => {
  beforeEach(() => {
    resolveSnapshot.mockReset();
  });

  it("binds the stable organization and authorization snapshot to the principal", async () => {
    resolveSnapshot.mockResolvedValue({
      tenantId: "tn_demo",
      organizationId: "org_demo",
      authorizationSnapshotId: "authz_demo",
      authorizationFingerprint: "a".repeat(64),
    });

    const resolution = await resolveRuntimePrincipalV2({
      adoption,
      user: { organization: "Example Bank", groupId: 3 },
      sessionId: "session-demo",
      taskId: "task-demo",
    });

    expect(resolution.complete).toBe(true);
    expect(resolution.principal).toMatchObject({
      identityVersion: "2",
      tenantId: "tn_demo",
      organizationId: "org_demo",
      authorizationSnapshotId: "authz_demo",
      userId: 7,
      adoptionId: "lgj-demo",
      roleTemplate: "wealth-manager",
    });
    expect(resolveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      organizationName: "Example Bank",
      groupIds: [3],
    }));
  });

  it("fails closed when a durable authorization snapshot cannot be resolved", async () => {
    resolveSnapshot.mockRejectedValue(new Error("database unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const resolution = await resolveRuntimePrincipalV2({
      adoption,
      user: { organization: "Example Bank", groupId: 0 },
      sessionId: "session-demo",
    });

    expect(resolution.complete).toBe(false);
    expect(resolution.issues).toContain("authorizationSnapshot");
    expect(resolution.principal.authorizationSnapshotId).toBe("");
    consoleError.mockRestore();
  });

  it("includes V2 identity bindings in the principal fingerprint", () => {
    const base = {
      userId: 7,
      adoptionId: "lgj-demo",
      agentId: "agent-demo",
      roleTemplate: "wealth-manager",
      workspaceId: "/tmp/workspace",
      permissionProfile: "plus",
      sessionId: "session-demo",
    };
    const first = buildRuntimePrincipalV2({
      principal: base,
      tenantId: "tn_a",
      organizationId: "org_a",
      authorizationSnapshotId: "authz_a",
      authorizationFingerprint: "a".repeat(64),
    });
    const second = { ...first, authorizationSnapshotId: "authz_b" };

    expect(principalFingerprint(first)).not.toBe(principalFingerprint(second));
  });
});
