import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawAdoption } from "../../../drizzle/schema";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  resolveV1: vi.fn(),
  resolveV2: vi.fn(),
  authorize: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("../../db/users", () => ({ getUserById: mocks.getUser }));
vi.mock("./principal", () => ({
  resolveRuntimePrincipal: mocks.resolveV1,
  resolveRuntimePrincipalV2: mocks.resolveV2,
}));
vi.mock("./execution-authority", () => ({ authorizeExecutionAuthority: mocks.authorize }));
vi.mock("../audit-events", () => ({
  auditRequest: vi.fn(() => ({})),
  recordAuditBestEffort: mocks.audit,
}));

import { authorizeClawRouteExecution } from "./claw-route-execution-authority";

const claw = {
  adoptId: "lgj-route",
  userId: 7,
  agentId: "agent-route",
  roleTemplate: "wealth-manager",
  permissionProfile: "plus",
} as ClawAdoption;

const principal = {
  tenantId: "tenant-1",
  organizationId: "org-1",
  userId: 7,
  adoptionId: "lgj-route",
  agentId: "agent-route",
  roleTemplate: "wealth-manager",
  workspaceId: "/workspace/lgj-route",
  permissionProfile: "plus",
  authorizationSnapshotId: "auth-current",
  authorizationFingerprint: "a".repeat(64),
  sessionId: "session-1",
  identityVersion: "2" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ id: 7, organization: "Bank", groupId: 3 });
  mocks.resolveV1.mockReturnValue({ principal, complete: true, issues: [] });
  mocks.resolveV2.mockResolvedValue({ principal, complete: true, issues: [] });
  mocks.authorize.mockResolvedValue({
    effect: "ALLOW",
    policyCode: "EA_EXECUTION_AUTHORITY_INTERSECTION_V1",
    ruleVersion: "execution-authority-v1",
    reason: "allowed",
    effectivePrincipal: principal,
    taskSnapshotId: "auth-task",
    currentSnapshotId: "auth-current",
    effectiveAuthorityFingerprint: "b".repeat(64),
  });
});

describe("claw route execution authority adapter", () => {
  it("forwards the task ceiling and returns the effective principal", async () => {
    const operation = {
      capabilityId: "workspace.files",
      operation: "upload_workspace_file",
      sideEffect: "workspace_write" as const,
      resource: "workspace-file:report.md",
    };
    const result = await authorizeClawRouteExecution({
      claw,
      source: "test_route",
      taskAuthorizationSnapshotId: "auth-task",
      operation,
    });
    expect(result.allowed).toBe(true);
    expect(result.effectivePrincipal).toEqual(principal);
    expect(mocks.authorize).toHaveBeenCalledWith({
      principal,
      taskAuthorizationSnapshotId: "auth-task",
      operation,
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("fails closed and records evidence when the user no longer exists", async () => {
    mocks.getUser.mockResolvedValueOnce(null);
    const result = await authorizeClawRouteExecution({
      claw,
      source: "test_route",
      operation: {
        capabilityId: "notification.send",
        operation: "send_notification",
        sideEffect: "external_send",
      },
    });
    expect(result).toMatchObject({
      allowed: false,
      policyCode: "EA_EXECUTION_AUTHORITY_USER_MISSING",
    });
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "governance.execution_authority.blocked",
      source: "test_route",
    }));
  });
});
