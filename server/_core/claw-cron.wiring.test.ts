import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authority: vi.fn(),
  createIdempotently: vi.fn(),
  addJob: vi.fn(),
  listJobs: vi.fn(),
}));

vi.mock("./helpers", () => ({
  isAuthorizedInternalRequest: vi.fn(() => true),
  isJiuwenClawAdoptId: vi.fn(() => true),
  requireClawOwner: vi.fn(),
  resolveRuntimeAgentId: vi.fn(() => "agent-cron"),
}));
vi.mock("../db", () => ({
  getClawByAdoptId: vi.fn(async () => ({
    adoptId: "lgj-cron", userId: 1, agentId: "agent-cron",
    roleTemplate: "general-assistant", permissionProfile: "plus",
  })),
}));
vi.mock("./governance/claw-route-execution-authority", () => ({
  authorizeClawRouteExecution: mocks.authority,
}));
vi.mock("./cron/jiuwenclaw-cron-provider", () => ({
  JiuwenClawCronProvider: class {
    capabilities() { return { supportedChannels: ["web", "feishu"] }; }
    addJob = mocks.addJob;
    listJobs = mocks.listJobs;
  },
}));
vi.mock("./cron/channel-capabilities", () => ({
  resolveCronCapabilities: vi.fn(async () => ({ supportedChannels: ["web", "feishu"] })),
  unavailableDeliveryChannelError: vi.fn(() => null),
}));
vi.mock("./cron-delivery", () => ({
  deleteCronDeliveryConfig: vi.fn(),
  saveCronDeliveryConfig: vi.fn(),
}));
vi.mock("./cron/channel-provider-registry", () => ({ normalizeChannelId: vi.fn((value: string) => value) }));
vi.mock("./cron/cron-idempotency", () => ({
  normalizeCronIdempotencyKey: vi.fn((value: string) => value || "idem-test"),
  createCronJobIdempotently: mocks.createIdempotently,
}));
vi.mock("../db/cron-job-creations", () => ({
  withCronCreationScopeLock: vi.fn(async (_adoptId: string, fn: () => Promise<unknown>) => fn()),
}));

import { registerCronRoutes } from "./claw-cron";

let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
let baseUrl = "";

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.authority.mockResolvedValue({
    allowed: true,
    policyCode: "EA_EXECUTION_AUTHORITY_INTERSECTION_V1",
    reason: "allowed",
    taskSnapshotId: "auth-task",
    effectiveAuthorityFingerprint: "f".repeat(64),
  });
  mocks.listJobs.mockResolvedValue({ ok: true, value: [] });
  mocks.addJob.mockResolvedValue({
    ok: true,
    value: { id: "cron-1", name: "日报", delivery: { targets: [{ channelId: "web" }] } },
  });
  mocks.createIdempotently.mockImplementation(async ({ input, create }: {
    input: { meta?: Record<string, unknown> };
    create: () => Promise<unknown>;
  }) => ({
    job: await create(), reused: false, input,
  }));
  const app = express();
  app.use(express.json());
  registerCronRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server?.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
  server = undefined;
});

function createJob() {
  return fetch(`${baseUrl}/api/claw/cron/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Key": "test" },
    body: JSON.stringify({
      adoptId: "lgj-cron",
      idempotencyKey: "idem-1",
      job: {
        name: "日报",
        schedule: { kind: "cron", cronExpr: "0 9 * * *" },
        prompt: "生成日报",
        delivery: { targets: [{ channelId: "web", channelLabel: "当前对话" }] },
      },
    }),
  });
}

describe("cron execution-authority PEP wiring", () => {
  it("does not call idempotency or cron provider when authority denies", async () => {
    mocks.authority.mockResolvedValueOnce({
      allowed: false,
      policyCode: "EA_EXECUTION_AUTHORITY_REVOKED",
      reason: "任务授权已失效",
      taskSnapshotId: "auth-task",
    });
    const response = await createJob();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "EA_EXECUTION_AUTHORITY_REVOKED" });
    expect(mocks.createIdempotently).not.toHaveBeenCalled();
    expect(mocks.addJob).not.toHaveBeenCalled();
  });

  it("persists the task authorization snapshot before invoking the provider", async () => {
    const response = await createJob();
    expect(response.status).toBe(200);
    const input = mocks.createIdempotently.mock.calls[0][0].input;
    expect(input.meta).toMatchObject({
      taskAuthorizationSnapshotId: "auth-task",
      executionAuthorityFingerprint: "f".repeat(64),
    });
    expect(mocks.addJob).toHaveBeenCalledOnce();
  });
});
