import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuditRecordError,
  FAIL_CLOSE_AUDIT_ACTIONS,
  createAuditLedger,
  drainAuditDlq,
  getAuditDlqStats,
  normalizeAuditEvent,
  redactAuditMetadata,
} from "./audit-ledger";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "audit-ledger-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("audit ledger metadata redaction", () => {
  it("redacts secret keys and common PII patterns", () => {
    const redacted = redactAuditMetadata({
      apiToken: "secret-token",
      nested: {
        authorization: "Bearer abc",
        email: "alice@example.com",
        phone: "13800138000",
        id: "110105199001011234",
        card: "6222 0202 0202 0202",
      },
    }) as any;

    expect(redacted.apiToken).toBe("[REDACTED]");
    expect(redacted.nested.authorization).toBe("[REDACTED]");
    expect(redacted.nested.email).toBe("[REDACTED_EMAIL]");
    expect(redacted.nested.phone).toBe("[REDACTED_PHONE]");
    expect(redacted.nested.id).toBe("[REDACTED_ID]");
    expect(redacted.nested.card).toBe("[REDACTED_BANK_CARD]");
  });

  it("redacts inline secrets in strings", () => {
    const redacted = redactAuditMetadata({
      command: "curl -H 'Authorization: Bearer abc.def' https://x.test?apiKey=live-key --token=cli-token",
      env: "password=plain secret:also-plain",
    }) as any;

    expect(redacted.command).not.toContain("abc.def");
    expect(redacted.command).not.toContain("live-key");
    expect(redacted.command).not.toContain("cli-token");
    expect(redacted.env).not.toContain("plain");
  });

  it("marks oversized metadata as truncated", () => {
    const event = normalizeAuditEvent({
      action: "admin.user.role_changed",
      metadata: { body: "x".repeat(20 * 1024) },
    });

    expect(event.metadataTruncated).toBe(true);
    expect(event.metadataOriginalBytes).toBeGreaterThan(16 * 1024);
    expect(event.metadataJson).toEqual(expect.objectContaining({ truncated: true }));
  });
});

describe("recordAuditEvent", () => {
  it("persists normalized events through the injected writer", async () => {
    const rows: any[] = [];
    const ledger = createAuditLedger({
      idFactory: () => "01TESTAUDITID000000000001",
      now: () => new Date("2026-05-12T01:02:03.000Z"),
      insertAuditEvent: async (event) => {
        rows.push(event);
      },
    });

    const result = await ledger.recordAuditEvent({
      action: "auth.login.success",
      actorUserId: 7,
      metadata: { method: "password", password: "hidden" },
    });

    expect(result).toEqual(expect.objectContaining({
      eventId: "01TESTAUDITID000000000001",
      status: "persisted",
      persisted: true,
      dlqWritten: false,
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      eventId: "01TESTAUDITID000000000001",
      category: "auth",
      action: "auth.login.success",
      actorUserId: 7,
      eventTime: new Date("2026-05-12T01:02:03.000Z"),
    }));
    expect(rows[0].metadataJson.password).toBe("[REDACTED]");
  });

  it("writes non-fail-close events to DLQ when persistence fails", async () => {
    const dlqDir = await makeTempDir();
    const ledger = createAuditLedger({
      dlqDir,
      idFactory: () => "01TESTAUDITID000000000002",
      insertAuditEvent: async () => {
        throw new Error("db down");
      },
    });

    const result = await ledger.recordAuditEvent({
      action: "auth.login.failed",
      result: "failed",
      metadata: { reason: "bad_password" },
    });

    expect(result).toEqual(expect.objectContaining({
      status: "dlq",
      persisted: false,
      dlqWritten: true,
      error: "db down",
    }));

    const stats = await getAuditDlqStats(dlqDir);
    expect(stats.eventCount).toBe(1);
    const files = await readFile(path.join(dlqDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8");
    expect(files).toContain("01TESTAUDITID000000000002");
    expect(files).toContain("db down");
  });

  it("bounds identifiers to their audit table column lengths", () => {
    const event = normalizeAuditEvent({
      action: "file.read",
      targetId: "/workspace/" + "a".repeat(200),
      resourceId: "b".repeat(200),
      resourceName: "c".repeat(400),
    });
    expect(event.targetId).toHaveLength(128);
    expect(event.resourceId).toHaveLength(128);
    expect(event.resourceName).toHaveLength(256);
  });

  it("throws for fail-close events only when both persistence and DLQ fail", async () => {
    const ledger = createAuditLedger({
      dlqDir: "\0bad-dir",
      idFactory: () => "01TESTAUDITID000000000003",
      insertAuditEvent: async () => {
        throw new Error("db down");
      },
    });

    await expect(ledger.recordAuditEvent({
      action: "audit.export.requested",
      mode: "sync",
    })).rejects.toBeInstanceOf(AuditRecordError);
  });

  it("treats requested audit self-actions as fail-close", () => {
    expect(FAIL_CLOSE_AUDIT_ACTIONS.has("audit.export.requested")).toBe(true);
    expect(FAIL_CLOSE_AUDIT_ACTIONS.has("audit.export.completed")).toBe(true);
    expect(FAIL_CLOSE_AUDIT_ACTIONS.has("admin.user.access_changed.requested")).toBe(true);
    expect(FAIL_CLOSE_AUDIT_ACTIONS.has("admin.user.password_reset.requested")).toBe(true);
  });

  it("queues async non-fail-close events without blocking callers", async () => {
    const rows: any[] = [];
    const ledger = createAuditLedger({
      idFactory: () => "01TESTAUDITID000000000004",
      insertAuditEvent: async (event) => {
        rows.push(event);
      },
    });

    const result = await ledger.recordAuditEvent({
      action: "system.health.checked",
      mode: "async",
    });

    expect(result.status).toBe("queued");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rows).toHaveLength(1);
  });

  it("replays DLQ records, deduplicates persisted events, and retains failures", async () => {
    const dlqDir = await makeTempDir();
    const first = normalizeAuditEvent({ eventId: "01DLQ000000000000000000001", action: "auth.login.success" });
    const duplicate = normalizeAuditEvent({ eventId: "01DLQ000000000000000000002", action: "auth.logout" });
    const failed = normalizeAuditEvent({ eventId: "01DLQ000000000000000000003", action: "system.health.failed" });
    await writeFile(path.join(dlqDir, "2026-05-12.jsonl"), [first, duplicate, failed]
      .map((event) => JSON.stringify({ type: "audit.event", event }))
      .join("\n") + "\n");

    const persisted: string[] = [];
    const result = await drainAuditDlq({
      dir: dlqDir,
      insertAuditEvent: async (event) => {
        if (event.eventId === duplicate.eventId) throw Object.assign(new Error("wrapped duplicate"), {
          cause: Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" }),
        });
        if (event.eventId === failed.eventId) throw new Error("db unavailable");
        persisted.push(event.eventId);
      },
    });

    expect(result).toEqual(expect.objectContaining({ scanned: 3, persisted: 1, duplicates: 1, failed: 1, remaining: 1 }));
    expect(persisted).toEqual([first.eventId]);
    expect((await getAuditDlqStats(dlqDir)).eventCount).toBe(1);
    expect(await readFile(path.join(dlqDir, "2026-05-12.jsonl"), "utf8")).toContain(failed.eventId);
  });
});
