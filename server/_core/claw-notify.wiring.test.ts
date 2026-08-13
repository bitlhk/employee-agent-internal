import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  postWebhook: vi.fn(),
  authority: vi.fn(),
}));

vi.mock("node:fs", () => ({
  chmodSync: vi.fn(),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => JSON.stringify({
    "lgj-notify": { type: "webhook", webhook: "encrypted-webhook" },
  })),
  renameSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock("./helpers", () => ({
  isAuthorizedInternalRequest: vi.fn(() => true),
  requireClawOwner: vi.fn(),
}));
vi.mock("./safe-webhook", () => ({
  safePostWebhookJson: mocks.postWebhook,
  validateWebhookTarget: vi.fn(),
}));
vi.mock("./secret-protection", () => ({
  decryptSecret: vi.fn(() => "https://notify.example.com/hook"),
  encryptSecret: vi.fn((value: string) => value),
  isEncryptedSecret: vi.fn(() => true),
}));
vi.mock("./external-delivery-guard", () => ({ guardExternalDelivery: mocks.guard }));
vi.mock("./fetch-timeout", () => ({ fetchWithTimeout: vi.fn() }));
vi.mock("../db", () => ({
  getClawByAdoptId: vi.fn(async () => ({
    adoptId: "lgj-notify", userId: 1, agentId: "agent-notify",
    roleTemplate: "general-assistant", permissionProfile: "plus",
  })),
}));
vi.mock("./governance/claw-route-execution-authority", () => ({
  authorizeClawRouteExecution: mocks.authority,
}));

import { registerNotifyRoutes } from "./claw-notify";

let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
let baseUrl = "";

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.authority.mockResolvedValue({
    allowed: true,
    policyCode: "EA_EXECUTION_AUTHORITY_INTERSECTION_V1",
    reason: "allowed",
    taskSnapshotId: "auth-current",
  });
  mocks.guard.mockResolvedValue({ ok: false, error: "检测到敏感信息，已阻止外发" });
  const app = express();
  app.use(express.json());
  registerNotifyRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server?.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
  server = undefined;
});

describe("notification PEP wiring", () => {
  it("never reaches the webhook executor when the external-delivery guard denies", async () => {
    const response = await fetch(`${baseUrl}/api/claw/notify/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adoptId: "lgj-notify", message: "sensitive", channel: "webhook" }),
    });
    const body = await response.json() as { ok?: boolean; error?: string };
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: false, error: "检测到敏感信息，已阻止外发" });
    expect(mocks.postWebhook).not.toHaveBeenCalled();
  });

  it("never reaches the delivery guard or webhook when execution authority denies", async () => {
    mocks.authority.mockResolvedValueOnce({
      allowed: false,
      policyCode: "EA_EXECUTION_AUTHORITY_REVOKED",
      reason: "任务授权已失效",
      taskSnapshotId: "auth-task",
    });
    const response = await fetch(`${baseUrl}/api/claw/notify/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adoptId: "lgj-notify", message: "hello", channel: "webhook" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "EA_EXECUTION_AUTHORITY_REVOKED",
    });
    expect(mocks.guard).not.toHaveBeenCalled();
    expect(mocks.postWebhook).not.toHaveBeenCalled();
  });
});
