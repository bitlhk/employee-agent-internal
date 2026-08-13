import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authority: vi.fn(),
  providerSend: vi.fn(),
  recordRun: vi.fn(),
  updateDelivery: vi.fn(),
}));

vi.mock("../db", () => ({
  getClawByAdoptId: vi.fn(async () => ({
    adoptId: "lgj-cron", userId: 1, agentId: "agent-cron",
    roleTemplate: "general-assistant", permissionProfile: "plus",
  })),
}));
vi.mock("./helpers", () => ({ isAuthorizedInternalRequest: vi.fn(() => true) }));
vi.mock("./governance/claw-route-execution-authority", () => ({
  authorizeClawRouteExecution: mocks.authority,
}));
vi.mock("./cron/jiuwenclaw-cron-provider", () => ({
  findJiuwenCronRouteMeta: vi.fn(() => ({
    adoptId: "lgj-cron",
    channelId: "feishu",
    name: "日报",
    taskAuthorizationSnapshotId: "auth-task",
  })),
  findJiuwenCronRunRouteMeta: vi.fn(() => null),
  recordJiuwenCronRun: mocks.recordRun,
  updateJiuwenCronRunDelivery: mocks.updateDelivery,
}));
vi.mock("./cron/channel-provider-registry", () => ({
  normalizeChannelId: vi.fn((value: string) => value),
  getChannelProvider: vi.fn(() => ({ send: mocks.providerSend })),
}));

import { registerJiuwenWebhookRoutes } from "./jiuwen-webhook";

let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
let baseUrl = "";

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.authority.mockResolvedValue({
    allowed: false,
    policyCode: "EA_EXECUTION_AUTHORITY_REVOKED",
    reason: "任务授权已失效",
    taskSnapshotId: "auth-task",
  });
  mocks.recordRun.mockReturnValue({ recorded: true, duplicate: false });
  const app = express();
  app.use(express.json());
  registerJiuwenWebhookRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server?.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
  server = undefined;
});

describe("scheduled external-delivery execution authority", () => {
  it("records the run but never calls the channel provider when authority was revoked", async () => {
    const response = await fetch(`${baseUrl}/api/internal/jiuwen/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Key": "test" },
      body: JSON.stringify({
        content: "日报完成",
        ok: true,
        cron: { task_id: "cron-1", run_id: "run-1" },
        metadata: {
          workforceAgent: {
            adoptId: "lgj-cron",
            delivery: { channelId: "feishu" },
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, delivery: "blocked" });
    expect(mocks.authority).toHaveBeenCalledWith(expect.objectContaining({
      taskAuthorizationSnapshotId: "auth-task",
    }));
    expect(mocks.providerSend).not.toHaveBeenCalled();
    expect(mocks.recordRun).toHaveBeenCalledWith(expect.objectContaining({ deliveryStatus: "failed" }));
  });
});
