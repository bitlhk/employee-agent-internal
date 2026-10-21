import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ save: vi.fn(), revoke: vi.fn(), read: vi.fn(), query: vi.fn(), owner: vi.fn() }));
vi.mock("../../db/scheduling", () => ({ saveCalendarBinding: mocks.save, revokeCalendarConnection: mocks.revoke, getCalendarBinding: vi.fn(), calendarAccountOwner: mocks.owner }));
vi.mock("./calendar", async original => ({ ...await original<typeof import("./calendar")>(), readOwnCalendar: mocks.read }));
vi.mock("../audit-events", () => ({ recordAuditRequired: vi.fn() }));
vi.mock("mysql2/promise", () => ({ default: { createConnection: async () => ({ query: mocks.query, end: vi.fn() }) } }));
import { connectOwnCalendar, disconnectOwnCalendar, selfConnectionSchema } from "./connection-service";
const input = { username: "alice", calendarName: "personal", appPassword: "private", writeEnabled: false, discoverable: true };
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("NEXTCLOUD_BASE_URL", "http://127.0.0.1:8088"); mocks.owner.mockResolvedValue(null); mocks.read.mockResolvedValue([]); mocks.save.mockResolvedValue(undefined); mocks.query.mockResolvedValue([[{ acquired: 1 }]]); });
describe("Self-authorized calendar access", () => {
  it("verifies provider identity and binds only the authenticated platform owner", async () => {
    const transport = vi.fn(async () => Response.json({ ocs: { meta: { statuscode: 200 }, data: { id: "alice", email: "a@local.invalid" } } }));
    await connectOwnCalendar(42, input, transport);
    expect(mocks.read).toHaveBeenCalledWith(42, expect.objectContaining({ userId: 42 }), expect.any(Object), transport);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ userId: 42, autoAvailability: true, writeEnabled: false, calendarEmail: "a@local.invalid" }));
    expect(selfConnectionSchema.safeParse({ ...input, userId: 99 }).success).toBe(false);
  });
  it("refuses an identity mismatch, failed credentials or inaccessible calendar before saving", async () => {
    const mismatch = vi.fn(async () => Response.json({ ocs: { meta: { statuscode: 200 }, data: { id: "bob" } } }));
    await expect(connectOwnCalendar(42, input, mismatch)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(connectOwnCalendar(42, input, vi.fn(async () => new Response(null, { status: 401 })))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("does not transfer an account bound to someone else", async () => {
    mocks.save.mockRejectedValue(new Error("duplicate username"));
    await expect(connectOwnCalendar(42, input, vi.fn(async () => Response.json({ ocs: { meta: { statuscode: 100 }, data: { id: "alice" } } })))).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("rejects another owner's connected account before any provider or calendar access", async () => {
    mocks.owner.mockResolvedValue(99); const transport = vi.fn();
    await expect(connectOwnCalendar(42, input, transport)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(transport).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("serializes disconnect with writes and revokes only the authenticated user's grant", async () => {
    await disconnectOwnCalendar(42);
    expect(mocks.revoke).toHaveBeenCalledWith(42);
    expect(mocks.query).toHaveBeenCalledWith("SELECT GET_LOCK(?, 0) AS acquired", ["calendar-write:42"]);
    mocks.query.mockResolvedValue([[{ acquired: 0 }]]); mocks.revoke.mockClear();
    await expect(disconnectOwnCalendar(42)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
});
