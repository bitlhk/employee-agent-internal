import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workspace = mkdtempSync(path.join(tmpdir(), "ea-files-authority-"));
const mocks = vi.hoisted(() => ({ authority: vi.fn() }));

vi.mock("./helpers", () => ({
  isJiuwenClawAdoptId: vi.fn(() => true),
  requireClawOwner: vi.fn(async () => ({
    adoptId: "lgj-files", userId: 1, agentId: "agent-files",
    roleTemplate: "general-assistant", permissionProfile: "plus",
  })),
  resolveRuntimeWorkspace: vi.fn(() => process.env.EA_TEST_FILES_WORKSPACE || ""),
}));
vi.mock("./governance/claw-route-execution-authority", () => ({
  authorizeClawRouteExecution: mocks.authority,
}));
vi.mock("./upload-security", () => ({
  decodeBase64Strict: vi.fn((value: string) => Buffer.from(value, "base64")),
  scanUploadForMalware: vi.fn(async () => ({ ok: true })),
  validateUploadContent: vi.fn(() => ({ ok: true })),
}));
vi.mock("./audit-events", () => ({
  auditActor: vi.fn(() => ({})),
  auditErrorMetadata: vi.fn(() => ({})),
  auditRequest: vi.fn(() => ({})),
  recordAuditBestEffort: vi.fn(),
  recordAuditRequired: vi.fn(),
}));
vi.mock("./skills/skill-store", () => ({
  skillSourceDirsForRuntime: vi.fn(() => []),
  skillStoreAgentDir: vi.fn(() => "/nonexistent-skill-store"),
}));

import { registerFilesRoutes } from "./claw-files";

let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
let baseUrl = "";

beforeEach(async () => {
  process.env.EA_TEST_FILES_WORKSPACE = workspace;
  vi.clearAllMocks();
  mocks.authority.mockResolvedValue({
    allowed: false,
    policyCode: "EA_EXECUTION_AUTHORITY_REVOKED",
    reason: "任务授权已失效",
    taskSnapshotId: "auth-task",
  });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  registerFilesRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server?.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
  server = undefined;
});

afterAll(() => {
  delete process.env.EA_TEST_FILES_WORKSPACE;
  rmSync(workspace, { recursive: true, force: true });
});

describe("workspace execution-authority PEP wiring", () => {
  it("does not write an uploaded file when authority denies", async () => {
    const response = await fetch(`${baseUrl}/api/claw/files/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        adoptId: "lgj-files",
        filename: "denied.txt",
        contentBase64: Buffer.from("blocked").toString("base64"),
      }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "EA_EXECUTION_AUTHORITY_REVOKED" });
    expect(existsSync(path.join(workspace, "denied.txt"))).toBe(false);
  });
});
