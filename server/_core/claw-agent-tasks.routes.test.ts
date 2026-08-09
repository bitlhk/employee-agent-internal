import type { AddressInfo } from "net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  reservation: { kind: "created" } as any,
  permissionProfile: "plus",
  reserveCalls: 0,
  remoteRunCalls: 0,
  recoverLeaseCalls: 0,
  failOwnedLeaseCalls: 0,
  task: { status: "running" } as Record<string, unknown>,
}));

vi.mock("../db/agents", () => ({
  answerAgentTaskInteractionAndCreate: vi.fn(),
  claimAgentTaskLease: vi.fn(async () => true),
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
  getAgentTask: vi.fn(async () => state.task),
  getAgentTaskBySourceMessage: vi.fn(),
  insertCallLog: vi.fn(),
  listAgentTasks: vi.fn(async () => []),
  listAgentTasksByIds: vi.fn(async () => []),
  listAgentTaskCounts: vi.fn(async () => ({})),
  listEnabledBusinessAgentsForContext: vi.fn(async () => []),
  reserveAgentTask: vi.fn(async () => {
    state.reserveCalls++;
    return state.reservation;
  }),
  updateActiveAgentTask: vi.fn(),
  updateLeasedAgentTask: vi.fn(async () => true),
}));

vi.mock("../db/users", () => ({
  getUserById: vi.fn(async () => ({ id: 1, role: "user", accessLevel: "plus" })),
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
  markAgentTaskFailed: vi.fn(),
  markAgentTaskSucceeded: vi.fn(),
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
  state.task = { status: "running" };
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
