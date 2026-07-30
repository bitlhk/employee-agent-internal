import type { AddressInfo } from "net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  reservation: { kind: "created" } as any,
  failInterruptedCalls: 0,
}));

vi.mock("../db/agents", () => ({
  answerAgentTaskInteractionAndCreate: vi.fn(),
  failInterruptedAgentTasks: vi.fn(async () => {
    state.failInterruptedCalls++;
    return 0;
  }),
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
  getAgentTask: vi.fn(async () => ({ status: "running" })),
  getAgentTaskBySourceMessage: vi.fn(),
  insertCallLog: vi.fn(),
  listAgentTasks: vi.fn(async () => []),
  listAgentTasksByIds: vi.fn(async () => []),
  listAgentTaskCounts: vi.fn(async () => ({})),
  listEnabledBusinessAgentsForContext: vi.fn(async () => []),
  reserveAgentTask: vi.fn(async () => state.reservation),
  updateActiveAgentTask: vi.fn(),
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
  runA2AExpertTask: vi.fn(async () => ({ state: "completed", text: "done", rawEvents: [] })),
  summarizeA2AEvents: vi.fn(() => null),
}));

vi.mock("./agent-artifacts", () => ({ materializeA2AArtifacts: vi.fn(async () => []) }));
vi.mock("./observability/metrics", () => ({
  beginOperationalActivity: vi.fn(() => () => {}),
  observeOperationalActivity: vi.fn(),
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
  if (server) {
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  }
});

describe("agent task consistency", () => {
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
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ taskId: "agt_existing", reused: true });
  });

  it("marks interrupted tasks during runtime startup and shutdown", async () => {
    const before = state.failInterruptedCalls;
    const stop = await startAgentTaskRuntime();
    await stop();
    expect(state.failInterruptedCalls - before).toBe(2);
  });
});
