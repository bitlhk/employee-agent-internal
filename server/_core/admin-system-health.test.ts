import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  execFileSync: vi.fn(),
  getAuditBaselineHealth: vi.fn(),
  getBackgroundWorkerSnapshot: vi.fn(),
  getCapacitySnapshot: vi.fn(),
  getAgentTaskRuntimeSnapshot: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFileSync: mocks.execFileSync,
}));

vi.mock("../db", () => ({
  getDb: vi.fn(async () => ({ execute: mocks.execute })),
}));

vi.mock("./audit-health", () => ({
  getAuditBaselineHealth: mocks.getAuditBaselineHealth,
}));

vi.mock("./background-workers", () => ({
  getBackgroundWorkerSnapshot: mocks.getBackgroundWorkerSnapshot,
}));

vi.mock("./helpers", () => ({
  APP_ROOT: "/tmp/employee-agent-health-test",
  JIUWENCLAW_HOME: "/tmp",
  jiuwenClawServiceId: () => "test",
}));

vi.mock("./operational-capacity", () => ({
  getCapacitySnapshot: mocks.getCapacitySnapshot,
}));

vi.mock("../db/agents", () => ({
  getAgentTaskRuntimeSnapshot: mocks.getAgentTaskRuntimeSnapshot,
}));

function databaseResult(rows: Array<Record<string, unknown>>) {
  return [rows, []];
}

describe("admin system health", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.PM2_APP_NAME = "employee-agent";
    delete process.env.EA_ALERT_FEISHU_WEBHOOK_URL;

    mocks.execFileSync.mockImplementation((file: string, args: string[]) => {
      if (file === "pm2") {
        return JSON.stringify([{
          name: "employee-agent",
          pm2_env: { status: "online", restart_time: 1, pm_uptime: 123 },
          monit: { cpu: 3, memory: 1024 },
        }]);
      }
      if (file === "git" && args.includes("--abbrev-ref")) return "main\n";
      if (file === "git") return "abc1234\n";
      if (file === "systemctl") return "active\n";
      return "";
    });

    mocks.execute.mockImplementation(async (query: string) => {
      if (query.startsWith("SHOW TABLES")) return databaseResult([{ table: "present" }]);
      if (query.includes("skill_marketplace")) return databaseResult([{ count: 12 }]);
      return databaseResult([{
        total: 8,
        active: 6,
        jiuwenActive: 6,
        openclawActive: 0,
      }]);
    });
    mocks.getCapacitySnapshot.mockReturnValue({
      api: { active: 2, limit: 200 },
      chat_http: { active: 1, limit: 60 },
      chat_ws: { active: 0, limit: 120 },
    });
    mocks.getBackgroundWorkerSnapshot.mockReturnValue([
      { id: "knowledge-index", state: "running" },
    ]);
    mocks.getAgentTaskRuntimeSnapshot.mockResolvedValue({ pending: 1, running: 2, stale: 0, tasks: [] });
    mocks.getAuditBaselineHealth.mockResolvedValue({
      ok: true,
      checkedAt: "2026-07-30T00:00:00.000Z",
      tables: [
        { name: "audit_events", exists: true, rowCount: 1, oldest: null, newest: null },
      ],
      ledger: { exists: true, rowCount: 1, oldestEventTime: null, newestEventTime: null },
      runtimePermissions: { ok: true, currentUser: "ea", grantCount: 1, forbiddenPrivileges: [] },
      triggers: { expected: [], present: [], missing: [], ok: true },
      dlq: { eventCount: 0, oldestEventTime: null, newestEventTime: null },
      recentFailures: [],
    });
  });

  it("returns the stable admin health contract for the active runtime", async () => {
    const { getAdminSystemHealth } = await import("./admin-system-health");
    const result = await getAdminSystemHealth([
      { id: "openpangu", name: "openPangu", isDefault: true },
    ]);

    expect(result.summary).toMatchObject({ ok: true, error: 0, warning: 0 });
    expect(result.app.pm2).toMatchObject({ name: "employee-agent", status: "online" });
    expect(result.operations.capacity.chat_http).toEqual({ active: 1, limit: 60 });
    expect(result.operations.agentTasks).toMatchObject({ pending: 1, running: 2, stale: 0 });
    expect(result.database).toMatchObject({
      ok: true,
      skillMarketApproved: 12,
      claws: { total: 8, active: 6, jiuwenActive: 6, openclawActive: 0 },
    });
    expect(result.runtimes.openclaw).toMatchObject({ enabled: false, active: 0, retired: true });
    expect(result.models.primary).toBe("openpangu");
  });

  it("surfaces active retired-runtime rows as an operator warning", async () => {
    mocks.execute.mockImplementation(async (query: string) => {
      if (query.startsWith("SHOW TABLES")) return databaseResult([{ table: "present" }]);
      if (query.includes("skill_marketplace")) return databaseResult([{ count: 12 }]);
      return databaseResult([{
        total: 9,
        active: 7,
        jiuwenActive: 6,
        openclawActive: 1,
      }]);
    });

    const { getAdminSystemHealth } = await import("./admin-system-health");
    const result = await getAdminSystemHealth([]);
    const retiredCheck = result.checks.find((check) => check.key === "runtime.retired");

    expect(retiredCheck).toMatchObject({ status: "warning" });
    expect(result.summary.warning).toBe(1);
    expect(result.summary.ok).toBe(false);
  });
});
