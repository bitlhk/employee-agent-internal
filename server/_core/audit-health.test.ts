import { describe, expect, it } from "vitest";
import { detectForbiddenGrantPrivileges, getAuditBaselineHealth } from "./audit-health";

function fakeDb(execute: (query: string) => any) {
  return {
    execute: async (query: string) => execute(query),
  };
}

describe("audit baseline health", () => {
  it("reports table metrics, recent failures, DLQ stats, grants, and WORM triggers", async () => {
    const health = await getAuditBaselineHealth({
      now: () => new Date("2026-05-12T01:00:00.000Z"),
      dlqStats: async () => ({
        dir: "/tmp/audit-dlq",
        exists: true,
        fileCount: 1,
        eventCount: 2,
        bytes: 512,
        diskAvailableBytes: 900,
        diskTotalBytes: 1000,
      }),
      db: fakeDb((query) => {
        if (query.includes("SHOW TABLES LIKE")) return [[{ table: "present" }]];
        if (query.includes("FROM `audit_events`")) {
          return [[{
            row_count: 3,
            oldest_at: new Date("2026-05-10T01:00:00.000Z"),
            newest_at: new Date("2026-05-12T01:00:00.000Z"),
          }]];
        }
        if (query.includes("FROM `audit_tool_events`")) return [[{ row_count: 1, oldest_at: null, newest_at: null }]];
        if (query.includes("FROM `audit_security_findings`")) return [[{ row_count: 0, oldest_at: null, newest_at: null }]];
        if (query.includes("FROM `audit_exports`")) return [[{ row_count: 0, oldest_at: null, newest_at: null }]];
        if (query.includes("FROM audit_events")) {
          return [[{
            event_id: "01FAIL",
            event_time: new Date("2026-05-12T00:59:00.000Z"),
            category: "auth",
            action: "auth.login.failed",
            result: "failed",
            severity: "medium",
            error_code: "BAD_PASSWORD",
            policy_code: null,
          }]];
        }
        if (query.includes("SHOW GRANTS")) return [[{ grant: "GRANT SELECT, INSERT ON `linggan`.* TO 'app'@'%'" }]];
        if (query.includes("CURRENT_USER()")) return [[{ audit_current_user: "app@%" }]];
        if (query.includes("INFORMATION_SCHEMA.TRIGGERS")) {
          return [[
            { name: "audit_events_no_update" },
            { name: "audit_events_no_delete" },
            { name: "audit_tool_events_no_update" },
            { name: "audit_tool_events_no_delete" },
            { name: "audit_exports_no_update" },
            { name: "audit_exports_no_delete" },
            { name: "audit_security_findings_no_delete" },
            { name: "audit_security_findings_restricted_update" },
          ]];
        }
        return [[]];
      }),
    });

    expect(health.ok).toBe(true);
    expect(health.checkedAt).toBe("2026-05-12T01:00:00.000Z");
    expect(health.ledger).toEqual({
      exists: true,
      rowCount: 3,
      oldestEventTime: "2026-05-10T01:00:00.000Z",
      newestEventTime: "2026-05-12T01:00:00.000Z",
    });
    expect(health.dlq?.eventCount).toBe(2);
    expect(health.recentFailures[0]).toEqual(expect.objectContaining({ eventId: "01FAIL", result: "failed" }));
    expect(health.permissions).toEqual(expect.objectContaining({ ok: true, currentUser: "app@%", forbiddenPrivileges: [] }));
    expect(health.triggers.ok).toBe(true);
  });

  it("flags missing tables and forbidden runtime DB privileges", async () => {
    const health = await getAuditBaselineHealth({
      dlqStats: async () => ({ dir: "/tmp/audit-dlq", exists: false, fileCount: 0, eventCount: 0, bytes: 0 }),
      db: fakeDb((query) => {
        if (query.includes("SHOW TABLES LIKE 'audit_events'")) return [[{ table: "audit_events" }]];
        if (query.includes("SHOW TABLES LIKE")) return [[]];
        if (query.includes("FROM `audit_events`")) return [[{ row_count: 0, oldest_at: null, newest_at: null }]];
        if (query.includes("SHOW GRANTS")) return [[{ grant: "GRANT ALL PRIVILEGES ON *.* TO 'root'@'localhost' WITH GRANT OPTION" }]];
        if (query.includes("CURRENT_USER()")) return [[{ audit_current_user: "root@localhost" }]];
        if (query.includes("INFORMATION_SCHEMA.TRIGGERS")) return [[]];
        return [[]];
      }),
    });

    expect(health.ok).toBe(false);
    expect(health.tables.filter((table) => !table.exists).map((table) => table.name)).toEqual([
      "audit_tool_events",
      "audit_security_findings",
      "audit_exports",
    ]);
    expect(health.permissions.forbiddenPrivileges).toContain("ALL PRIVILEGES");
    expect(health.permissions.forbiddenPrivileges).toContain("GRANT OPTION");
    expect(health.triggers.missing.length).toBeGreaterThan(0);
  });

  it("detects forbidden grant privileges without flagging normal DML grants", () => {
    expect(detectForbiddenGrantPrivileges(["GRANT SELECT, INSERT ON `app`.* TO 'app'@'%'"])).toEqual([]);
    expect(detectForbiddenGrantPrivileges(["GRANT SELECT, INSERT, TRIGGER, ALTER ON `app`.* TO 'app'@'%'"])).toEqual([
      "ALTER",
      "TRIGGER",
    ]);
  });

  it("uses the read-only trigger attestation view for least-privilege runtime users", async () => {
    const health = await getAuditBaselineHealth({
      dlqStats: async () => ({ dir: "/tmp/audit-dlq", exists: true, fileCount: 0, eventCount: 0, bytes: 0 }),
      db: fakeDb((query) => {
        if (query.includes("SHOW TABLES LIKE")) return [[{ table: "present" }]];
        if (query.includes("FROM `")) return [[{ row_count: 1, oldest_at: new Date(), newest_at: new Date() }]];
        if (query.includes("FROM audit_events")) return [[]];
        if (query.includes("SHOW GRANTS")) return [[{ grant: "GRANT SELECT, INSERT, UPDATE, DELETE ON `app`.* TO 'app'@'host'" }]];
        if (query.includes("CURRENT_USER()")) return [[{ audit_current_user: "app@host" }]];
        if (query.includes("INFORMATION_SCHEMA.TRIGGERS")) return [[]];
        if (query.includes("audit_worm_trigger_status")) return [[
          { name: "audit_events_no_update" },
          { name: "audit_events_no_delete" },
          { name: "audit_tool_events_no_update" },
          { name: "audit_tool_events_no_delete" },
          { name: "audit_exports_no_update" },
          { name: "audit_exports_no_delete" },
          { name: "audit_security_findings_no_delete" },
          { name: "audit_security_findings_restricted_update" },
        ]];
        return [[]];
      }),
    });
    expect(health.permissions.ok).toBe(true);
    expect(health.triggers.ok).toBe(true);
  });
});
