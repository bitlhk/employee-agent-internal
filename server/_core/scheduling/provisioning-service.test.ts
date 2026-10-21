import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  binding: vi.fn(),
  saved: vi.fn(),
  status: vi.fn(),
  provision: vi.fn(),
  user: vi.fn(),
  save: vi.fn(),
  read: vi.fn(),
  query: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("../../db", () => ({ getUserById: m.user }));
vi.mock("../../db/scheduling", () => ({
  getCalendarBinding: m.binding,
  saveCalendarBinding: m.save,
}));
vi.mock("../../db/calendar-provisioning", () => ({
  getCalendarProvisioning: m.provision,
  saveCalendarProvisioning: m.saved,
  setCalendarProvisioningStatus: m.status,
}));
vi.mock("./calendar", async importOriginal => ({
  ...(await importOriginal<typeof import("./calendar")>()),
  readOwnCalendar: m.read,
}));
vi.mock("../audit-events", () => ({ recordAuditRequired: m.audit }));
vi.mock("mysql2/promise", () => ({
  default: { createConnection: async () => ({ query: m.query, end: vi.fn() }) },
}));
import { ensureOwnCalendar } from "./provisioning-service";
import { encryptSecret } from "../secret-protection";
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXTCLOUD_AUTO_PROVISION", "true");
  vi.stubEnv("NEXTCLOUD_BASE_URL", "http://127.0.0.1:8088");
  vi.stubEnv("NEXTCLOUD_PROVISION_USERNAME", "service");
  vi.stubEnv("NEXTCLOUD_PROVISION_PASSWORD", "admin-secret");
  vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", "test-only-key");
  m.binding.mockResolvedValue(null);
  m.provision.mockResolvedValue(null);
  m.query.mockResolvedValue([[{ acquired: 1 }]]);
  m.user.mockResolvedValue({ id: 42, name: "测试人员" });
  m.saved.mockResolvedValue({
    userId: 42,
    username: "employee-agent-42",
    encryptedPassword: encryptSecret("persisted-password"),
  });
});
const identity = (id = "employee-agent-42") =>
  Response.json({
    ocs: {
      meta: { statuscode: 200 },
      data: { id, email: `${id}@calendar.local.invalid` },
    },
  });
describe("managed personal calendar provisioning", () => {
  it("preserves existing bindings and revoked access without contacting the provider", async () => {
    const transport = vi.fn();
    m.binding.mockResolvedValue({ enabled: true, username: "external" });
    expect(await ensureOwnCalendar(42, transport)).toEqual({
      state: "ready",
      managed: false,
    });
    m.binding.mockResolvedValue({ enabled: false, username: "external" });
    expect((await ensureOwnCalendar(42, transport)).state).toBe("disabled");
    expect(transport).not.toHaveBeenCalled();
    expect(m.save).not.toHaveBeenCalled();
  });
  it("creates an owner-specific account, verifies identity and calendar access before binding", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({ ocs: { meta: { statuscode: 100 } } })
      )
      .mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    expect(await ensureOwnCalendar(42, transport)).toEqual({
      state: "ready",
      managed: true,
    });
    expect(m.saved).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 42,
        encryptedPassword: expect.stringMatching(/^enc:v1:/),
      })
    );
    const body = transport.mock.calls[1][1].body as URLSearchParams;
    expect(body.get("password")).toBe("persisted-password");
    expect(m.read).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ userId: 42 }),
      expect.anything(),
      transport
    );
    expect(m.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 42,
        writeEnabled: true,
        autoAvailability: true,
        discoverable: false,
      })
    );
  });
  it("recovers a previously created account with its persisted credentials, without POST or password reset", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(new Response(null, { status: 405 }));
    expect((await ensureOwnCalendar(42, transport)).state).toBe("ready");
    expect(transport.mock.calls.some(call => call[1].method === "POST")).toBe(
      false
    );
  });
  it("fails closed on collisions, wrong provider identity and network errors without exposing secrets", async () => {
    for (const transport of [
      vi.fn().mockResolvedValue(identity("someone-else")),
      vi.fn().mockRejectedValue(new Error("provider secret")),
    ]) {
      const result = await ensureOwnCalendar(42, transport);
      expect(result).toEqual({ state: "retry", managed: true });
      expect(JSON.stringify(result)).not.toMatch(/secret|password|username/);
    }
    expect(m.save).not.toHaveBeenCalled();
  });
  it("requires deployment configuration and serializes attempts with owner writes", async () => {
    vi.stubEnv("NEXTCLOUD_AUTO_PROVISION", "false");
    const transport = vi.fn();
    expect((await ensureOwnCalendar(42, transport)).state).toBe(
      "not_configured"
    );
    vi.stubEnv("NEXTCLOUD_AUTO_PROVISION", "true");
    m.query.mockResolvedValue([[{ acquired: 0 }]]);
    expect((await ensureOwnCalendar(42, transport)).state).toBe("retry");
    expect(m.query).toHaveBeenCalledWith("SELECT GET_LOCK(?, 0) AS acquired", [
      "calendar-write:42",
    ]);
    expect(transport).not.toHaveBeenCalled();
  });
});
