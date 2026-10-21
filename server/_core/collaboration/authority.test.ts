import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollaborationRun } from "../../../drizzle/schema";
const grant = vi.hoisted(() => ({
  owner: vi.fn(),
  request: vi.fn(),
  authorize: vi.fn(),
  get: vi.fn(),
  bind: vi.fn(),
}));
vi.mock("../../db", () => ({
  getClawByAdoptId: grant.owner,
  getCollabRequest: grant.request,
}));
vi.mock("../../db/collaboration-runs", () => ({
  getCollaborationRun: grant.get,
  bindCollaborationAuthority: grant.bind,
  runSessionId: (id: string, turn: number) => `ea_collab_${id}_${turn}`,
}));
vi.mock("../governance/claw-route-execution-authority", () => ({
  authorizeClawRouteExecution: grant.authorize,
}));
import {
  assertCollaborationAuthority,
  CollaborationAuthorityRevoked,
} from "./authority";
const make = () =>
  ({
    id: "run",
    adoptId: "a",
    userId: 1,
    turn: 2,
    budgetRootId: "run",
    authorizationSnapshotId: "original",
    parentRunId: null,
  }) as CollaborationRun;
beforeEach(() => {
  vi.resetAllMocks();
  grant.owner.mockResolvedValue({
    userId: 1,
    status: "active",
    permissionProfile: "plus",
  });
  grant.authorize.mockResolvedValue({
    allowed: true,
    taskSnapshotId: "original",
  });
});
describe("original and current collaboration authority", () => {
  it("reuses the original snapshot and current route policy on every turn", async () => {
    await assertCollaborationAuthority(make());
    expect(grant.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        taskAuthorizationSnapshotId: "original",
        sessionId: "ea_collab_run_2",
        operation: expect.objectContaining({
          capabilityId: "platform.mcp",
          sideEffect: "read",
        }),
      })
    );
  });
  it("captures authority only at first dispatch and rejects an unbound tool call", async () => {
    const run = { ...make(), authorizationSnapshotId: null };
    await expect(assertCollaborationAuthority(run)).rejects.toBeInstanceOf(
      CollaborationAuthorityRevoked
    );
    grant.get.mockResolvedValue({ authorizationSnapshotId: "original" });
    await assertCollaborationAuthority(run, true);
    expect(grant.bind).toHaveBeenCalledWith("run", "original");
    expect(run.authorizationSnapshotId).toBe("original");
  });
  it("does not carry forward revoked ownership, profile or task authority", async () => {
    grant.owner.mockResolvedValue({
      userId: 2,
      status: "active",
      permissionProfile: "plus",
    });
    await expect(assertCollaborationAuthority(make())).rejects.toBeInstanceOf(
      CollaborationAuthorityRevoked
    );
    grant.owner.mockResolvedValue({
      userId: 1,
      status: "active",
      permissionProfile: "starter",
    });
    await expect(assertCollaborationAuthority(make())).rejects.toThrow("失效");
    grant.owner.mockResolvedValue({
      userId: 1,
      status: "active",
      permissionProfile: "plus",
    });
    grant.authorize.mockResolvedValue({
      allowed: false,
      reason: "scope revoked",
    });
    await expect(assertCollaborationAuthority(make())).rejects.toThrow(
      "scope revoked"
    );
  });
  it("stops deeper delegation when an upstream exchange was cancelled without exposing the chain", async () => {
    const run = { ...make(), parentRunId: "parent", budgetRootId: "root" };
    grant.get.mockImplementation(async id =>
      id === "root"
        ? { status: "waiting" }
        : { status: "waiting", requestId: 42, parentRunId: "root" }
    );
    grant.request.mockResolvedValue({ status: "cancelled" });
    await expect(assertCollaborationAuthority(run)).rejects.toThrow(
      "上游询问已结束"
    );
    grant.get.mockResolvedValue({ status: "cancelled" });
    await expect(assertCollaborationAuthority(run)).rejects.toThrow(
      "上游目标已结束"
    );
  });
});
