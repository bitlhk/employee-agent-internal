import { afterEach, describe, expect, it, vi } from "vitest";
import { auditActor, auditErrorMetadata, auditRequest, recordAuditBestEffort } from "./audit-events";

vi.mock("./audit-ledger", () => ({
  FAIL_CLOSE_AUDIT_ACTIONS: new Set(["audit.export.completed"]),
  recordAuditEvent: vi.fn(async (input: any) => ({ eventId: input.eventId || "01TEST", status: "queued" })),
}));

describe("audit event helpers", () => {
  afterEach(() => {
    delete process.env.TRUST_PROXY;
  });

  it("normalizes actor and request context", () => {
    expect(auditActor({ id: "7", name: "Alice", email: "alice@example.com", role: "admin", groupId: 3 })).toEqual({
      actorType: "user",
      actorUserId: 7,
      actorName: "Alice",
      actorEmail: "alice@example.com",
      actorRole: "admin",
      actorOrgId: null,
      actorDepartmentId: "3",
    });

    const req = {
      headers: {
        "user-agent": "test-agent",
        "x-request-id": "req-1",
        "x-forwarded-for": "203.0.113.10",
      },
      socket: { remoteAddress: "127.0.0.1" },
    } as any;
    expect(auditRequest(req)).toEqual({ ip: "127.0.0.1", userAgent: "test-agent", requestId: "req-1" });

    process.env.TRUST_PROXY = "true";
    const proxiedReq = { ...req, ip: undefined, socket: undefined, connection: undefined };
    expect(auditRequest(proxiedReq)).toEqual({ ip: "203.0.113.10", userAgent: "test-agent", requestId: "req-1" });
  });

  it("records best effort events in async mode", async () => {
    const result = await recordAuditBestEffort({ action: "auth.login.success" });
    expect(result).toEqual(expect.objectContaining({ status: "queued" }));
  });

  it("rejects fail-close actions in best-effort mode", async () => {
    await expect(recordAuditBestEffort({ action: "audit.export.completed" })).rejects.toThrow(/cannot use recordAuditBestEffort for fail-close/);
  });

  it("turns errors into compact metadata", () => {
    expect(auditErrorMetadata(new TypeError("bad"))).toEqual({ error: "bad", errorName: "TypeError" });
  });
});
