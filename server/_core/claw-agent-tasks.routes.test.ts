import type { AddressInfo } from "net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  reservation: { kind: "created" } as any,
  permissionProfile: "plus",
  reserveCalls: 0,
  remoteRunCalls: 0,
  authorityCalls: 0,
  authorityEffects: [] as Array<"ALLOW" | "DENY">,
  leaseOwner: "",
  recoverLeaseCalls: 0,
  failOwnedLeaseCalls: 0,
  task: { status: "running" } as Record<string, unknown>,
  reservedTask: null as Record<string, unknown> | null,
}));

vi.mock("../db/agents", () => ({
  answerAgentTaskInteractionAndCreate: vi.fn(),
  claimAgentTaskLease: vi.fn(async (input: { owner: string }) => {
    state.leaseOwner = input.owner;
    return true;
  }),
  failOwnedAgentTaskLeases: vi.fn(async () => {
    state.failOwnedLeaseCalls++;
    return 0;
  }),
  recoverExpiredAgentTaskLeases: vi.fn(async () => {
    state.recoverLeaseCalls++;
    return 0;
  }),
  renewAgentTaskLease: vi.fn(async () => true),
  getBusinessAgentForContext: vi.fn(async () => ({
    id: "expert-1",
    name: "测试专家",
    enabled: 1,
    providerType: "a2a",
    adapterProtocol: "a2a-v1",
    apiUrl: "https://expert.example/a2a",
    apiToken: null,
    allowedProfiles: "plus,internal",
    endpointConfigJson: JSON.stringify({ maxConcurrent: 1 }),
    capabilitiesJson: JSON.stringify(["agent"]),
    visibility: "platform",
    maxDailyRequests: 10,
    healthStatus: "healthy",
  })),
  getAgentTask: vi.fn(async () => ({ ...state.task, ...(state.leaseOwner ? { leaseOwner: state.leaseOwner } : {}) })),
  getAgentTaskBySourceMessage: vi.fn(),
  insertCallLog: vi.fn(async () => undefined),
  listAgentTasks: vi.fn(async () => []),
  listAgentTasksByIds: vi.fn(async () => []),
  listAgentTaskCounts: vi.fn(async () => ({})),
  listEnabledBusinessAgentsForContext: vi.fn(async () => []),
  reserveAgentTask: vi.fn(async (task: Record<string, unknown>) => {
    state.reserveCalls++;
    state.reservedTask = task;
    return state.reservation;
  }),
  updateActiveAgentTask: vi.fn(),
  updateLeasedAgentTask: vi.fn(async () => true),
}));

vi.mock("../db/users", () => ({
  getUserById: vi.fn(async () => ({ id: 1, role: "user", accessLevel: "plus" })),
}));
vi.mock("../db", () => ({
  getClawByAdoptId: vi.fn(async (adoptId: string) => ({
    adoptId, userId: 1, agentId: "runtime-1", roleTemplate: "general",
    permissionProfile: state.permissionProfile, status: "active",
  })),
}));

vi.mock("./helpers", () => ({
  isAuthorizedInternalRequest: vi.fn(() => false),
  requireClawOwner: vi.fn(async (_req: unknown, _res: unknown, adoptId: string) => ({
    adoptId,
    userId: 1,
    agentId: "runtime-1",
    roleTemplate: "general",
    permissionProfile: state.permissionProfile,
  })),
  resolveRuntimeWorkspaceByIds: vi.fn(() => "/tmp"),
}));

vi.mock("./agent-health", () => ({
  AgentUnavailableError: class AgentUnavailableError extends Error {},
  agentHealthRouteReason: vi.fn(() => ""),
  ensureAgentAvailable: vi.fn(),
  friendlyAgentTaskError: vi.fn((error: Error) => error.message),
  markAgentTaskFailed: vi.fn(async () => undefined),
  markAgentTaskSucceeded: vi.fn(async () => undefined),
}));

vi.mock("./a2a-expert-client", () => ({
  cancelA2AExpertTask: vi.fn(async () => false),
  runA2AExpertTask: vi.fn(async () => {
    state.remoteRunCalls++;
    return { state: "completed", text: "done", rawEvents: [] };
  }),
  summarizeA2AEvents: vi.fn(() => null),
}));

vi.mock("./agent-artifacts", () => ({ materializeA2AArtifacts: vi.fn(async () => []) }));
vi.mock("./tool-egress-policy", () => ({ guardToolEgress: vi.fn(async () => ({ ok: true })) }));
vi.mock("./governance/principal", () => {
  const principal = () => ({
    userId: 1, adoptionId: "lgj-owner", agentId: "runtime-1", roleTemplate: "general",
    workspaceId: "/tmp", permissionProfile: state.permissionProfile, sessionId: "",
  });
  return {
    resolveRuntimePrincipal: vi.fn(() => ({ principal: principal(), complete: true, issues: [] })),
    resolveRuntimePrincipalV2: vi.fn(async () => ({
      principal: {
        ...principal(), tenantId: "tn-test", organizationId: "org-test",
        authorizationSnapshotId: "auth-current", authorizationFingerprint: "a".repeat(64), identityVersion: "2",
      },
      complete: true,
      issues: [],
    })),
  };
});
vi.mock("./governance/execution-authority", () => ({
  authorizeExecutionAuthority: vi.fn(async ({ principal, taskAuthorizationSnapshotId }: {
    principal: Record<string, unknown>;
    taskAuthorizationSnapshotId?: string | null;
  }) => {
    state.authorityCalls += 1;
    const effect = state.authorityEffects.shift() || "ALLOW";
    return {
      effect,
      policyCode: effect === "ALLOW" ? "EA_EXECUTION_AUTHORITY_INTERSECTION_V1" : "EA_EXECUTION_AUTHORITY_REVOKED",
      ruleVersion: "execution-authority-v1",
      reason: effect === "ALLOW" ? "allowed" : "任务授权或当前授权已失效，已停止执行。",
      effectivePrincipal: principal,
      taskSnapshotId: String(taskAuthorizationSnapshotId || "auth-current"),
      currentSnapshotId: "auth-current",
      effectiveAuthorityFingerprint: "b".repeat(64),
    };
  }),
}));
vi.mock("./observability/metrics", () => ({
  beginOperationalActivity: vi.fn(() => () => {}),
  observeAgentTaskRetry: vi.fn(),
  observeCapabilityPreflight: vi.fn(),
  observeOperationalActivity: vi.fn(),
  observeGovernanceDecision: vi.fn(),
}));

import { registerAgentTaskRoutes, startAgentTaskRuntime } from "./claw-agent-tasks";

let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;

async function startServer(): Promise<string> {
  const app = express();
  app.use(express.json());
  registerAgentTaskRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  state.reservation = { kind: "created" };
  state.permissionProfile = "plus";
  state.reserveCalls = 0;
  state.remoteRunCalls = 0;
  state.authorityCalls = 0;
  state.authorityEffects = [];
  state.leaseOwner = "";
  state.task = { status: "running" };
  state.reservedTask = null;
  if (server) {
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  }
});

describe("agent task consistency", () => {
  it("never reserves or executes an A2A task when delegation governance denies it", async () => {
    state.permissionProfile = "starter";
    const base = await startServer();
    const response = await fetch(`${base}/api/claw/agent-tasks/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        adoptId: "lgj-owner",
        agentId: "expert-1",
        task: "分析材料",
      }),
    });
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(403);
    expect(body.error).toBe("DELEGATION_NOT_ALLOWED");
    expect(state.reserveCalls).toBe(0);
    expect(state.remoteRunCalls).toBe(0);
  });

  it("returns the existing task when the database idempotency reservation wins", async () => {
    state.reservation = {
      kind: "existing",
      task: { id: "agt_existing", agentId: "expert-1", status: "running" },
    };
    const base = await startServer();
    const response = await fetch(`${base}/api/claw/agent-tasks/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        adoptId: "lgj-owner",
        agentId: "expert-1",
        task: "分析材料",
        sourceMessageId: "message-1",
      }),
    });
    const body = await response.json() as { taskId?: string; reused?: boolean };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ taskId: "agt_existing", reused: true });
  });

  it("never calls the remote A2A executor when authority is revoked after reservation", async () => {
    state.authorityEffects = ["ALLOW", "DENY"];
    const base = await startServer();
    const response = await fetch(`${base}/api/claw/agent-tasks/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ea-authorization-snapshot-id": "auth-task" },
      body: JSON.stringify({ adoptId: "lgj-owner", agentId: "expert-1", task: "分析材料" }),
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(state.authorityCalls).toBe(2));
    expect(state.reserveCalls).toBe(1);
    expect(JSON.parse(String(state.reservedTask?.requestContextJson))).toMatchObject({
      taskAuthorizationSnapshotId: "auth-task",
    });
    expect(state.remoteRunCalls).toBe(0);
  });

  it("calls the remote A2A executor only after submission and worker authority checks allow", async () => {
    const base = await startServer();
    const response = await fetch(`${base}/api/claw/agent-tasks/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ea-authorization-snapshot-id": "auth-task" },
      body: JSON.stringify({ adoptId: "lgj-owner", agentId: "expert-1", task: "分析材料" }),
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(state.authorityCalls).toBe(2));
    await vi.waitFor(() => expect(state.remoteRunCalls).toBe(1));
  });

  it("recovers expired leases at startup and releases owned tasks at shutdown", async () => {
    const recoveredBefore = state.recoverLeaseCalls;
    const releasedBefore = state.failOwnedLeaseCalls;
    const stop = await startAgentTaskRuntime();
    await stop();
    expect(state.recoverLeaseCalls - recoveredBefore).toBe(1);
    expect(state.failOwnedLeaseCalls - releasedBefore).toBe(1);
  });

  it("retries a failed task with the persisted runtime request", async () => {
    state.task = {
      id: "agt_failed12345678",
      adoptId: "lgj-owner",
      userId: 1,
      agentId: "expert-1",
      status: "failed",
      input: "展示给用户的任务",
      requestContextJson: JSON.stringify({ input: "远端原始任务", contextId: "ea-context" }),
      sourceConversationId: "conversation-1",
      sourceSessionId: "session-1",
    };
    const base = await startServer();
    const response = await fetch(`${base}/api/claw/agent-tasks/agt_failed12345678/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adoptId: "lgj-owner" }),
    });
    const body = await response.json() as {
      taskId?: string;
      task: { parentTaskId?: string; lifecycleState?: string; requestContextJson?: string };
    };

    expect(response.status).toBe(200);
    expect(body.taskId).toMatch(/^agt_/);
    expect(body.task).toMatchObject({ parentTaskId: "agt_failed12345678", lifecycleState: "queued" });
    expect(body.task.requestContextJson).toBeUndefined();
  });
});
