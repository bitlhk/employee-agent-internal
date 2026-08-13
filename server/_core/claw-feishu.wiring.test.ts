import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authority: vi.fn(),
  guard: vi.fn(),
}));

vi.mock("fs", () => ({
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => JSON.stringify({
    appId: "app-id", appSecret: "app-secret", openId: "ou-test",
    domain: "feishu", boundAt: "2026-08-13T00:00:00.000Z",
  })),
  writeFileSync: vi.fn(),
  existsSync: vi.fn((value: unknown) => String(value).endsWith("lgj-feishu.json")),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}));
vi.mock("./helpers", () => ({
  APP_ROOT: "/tmp/ea-feishu-test",
  isAuthorizedInternalRequest: vi.fn(() => false),
  jiuwenClawAgentId: vi.fn(() => "agent-feishu"),
  jiuwenClawWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  requireClawOwner: vi.fn(async () => ({
    adoptId: "lgj-feishu", userId: 1, agentId: "agent-feishu",
    roleTemplate: "general-assistant", permissionProfile: "plus",
  })),
}));
vi.mock("../db/channel-bindings", () => ({
  getChannelBindingByAdopt: vi.fn(async () => null),
  getChannelBindingByExternalUser: vi.fn(async () => null),
  removeChannelBindingByAdopt: vi.fn(),
  removeChannelBindingsForExternalUser: vi.fn(),
  upsertChannelBinding: vi.fn(),
}));
vi.mock("./external-delivery-guard", () => ({ guardExternalDelivery: mocks.guard }));
vi.mock("./governance/claw-route-execution-authority", () => ({
  authorizeClawRouteExecution: mocks.authority,
}));

import { registerFeishuRoutes } from "./claw-feishu";

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
  const app = express();
  app.use(express.json());
  registerFeishuRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server?.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
  server = undefined;
});

describe("Feishu execution-authority PEP wiring", () => {
  it("does not reach the external-delivery guard when authority denies", async () => {
    const response = await fetch(`${baseUrl}/api/claw/feishu/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adoptId: "lgj-feishu" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "EA_EXECUTION_AUTHORITY_REVOKED" });
    expect(mocks.guard).not.toHaveBeenCalled();
  });
});
