import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtimeAttested: false,
  internalFetch: vi.fn(),
}));

vi.mock("../db", () => ({
  getClawByAdoptId: vi.fn(async () => ({
    id: 1,
    userId: 7,
    adoptId: "lgj-platform",
    agentId: "jiuwen_lgj-platform",
    roleTemplate: "wealth-manager",
    permissionProfile: "plus",
    status: "active",
  })),
  getClawByAgentId: vi.fn(),
}));
vi.mock("../db/role-assets", () => ({ resolveEffectiveRoleAssets: vi.fn(async () => ({ mcpServers: { default: [], optional: [] } })) }));
vi.mock("./helpers", () => ({
  isAuthorizedInternalRequest: vi.fn(() => true),
  resolveRuntimeAgentId: vi.fn(),
  resolveRuntimeWorkspaceByIds: vi.fn((adoptId: string) => `/workspace/${adoptId}`),
}));
vi.mock("./audit-events", () => ({ auditRequest: vi.fn(() => ({})), recordAuditBestEffort: vi.fn() }));
vi.mock("./agent-memory", () => ({
  forgetAgentMemory: vi.fn(),
  listAgentMemoryView: vi.fn(),
  rememberExplicitPreference: vi.fn(),
}));
vi.mock("./observability/metrics", () => ({
  beginMcpCall: vi.fn(() => () => undefined),
  observeGovernanceDecision: vi.fn(),
}));
vi.mock("./fetch-timeout", () => ({ fetchWithTimeout: mocks.internalFetch }));
vi.mock("./runtime-governance-attestation", () => ({
  runtimeGovernanceIsAttested: vi.fn(() => mocks.runtimeAttested),
}));
vi.mock("./skills/skill-source", () => ({ parseSkillSourceDirectory: vi.fn(), sanitizeSkillId: vi.fn() }));
vi.mock("./skills/skill-installer", () => ({ skillInstaller: {} }));
vi.mock("./skills/skill-registry", () => ({ skillRegistry: {} }));
vi.mock("./skills/skill-store", () => ({ skillStoreRuntimeImportedDir: vi.fn() }));

import { registerPlatformToolsMcpRoutes } from "./platform-tools-mcp";

let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
let baseUrl = "";

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.runtimeAttested = false;
  const app = express();
  app.use(express.json());
  registerPlatformToolsMcpRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server?.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
  server = undefined;
});

describe("platform MCP PEP wiring", () => {
  it("never reaches the platform executor when governance denies a write", async () => {
    const response = await fetch(`${baseUrl}/api/internal/platform-tools/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-agent-adopt-id": "lgj-platform",
        "x-ea-runtime-id": "jiuwenswarm-local",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "platform-denied",
        method: "tools/call",
        params: {
          name: "create_scheduled_task",
          arguments: { name: "日报", message: "生成日报", cron_expr: "0 9 * * *" },
        },
      }),
    });
    const body = await response.json() as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(response.status).toBe(200);
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toMatch(/治理挂钩/);
    expect(mocks.internalFetch).not.toHaveBeenCalled();
  });
});
