import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../_core/context";

const store = vi.hoisted(() => ({
  getCalendarBinding: vi.fn(), getCalendarCredentials: vi.fn(), saveCalendarBinding: vi.fn(), searchSchedulingPeople: vi.fn(), readOwnCalendar: vi.fn(),
}));
const additions = vi.hoisted(() => ({ ensure: vi.fn() }));
vi.mock("../_core/scheduling/provisioning-service", () => ({ ensureOwnCalendar: additions.ensure }));
vi.mock("../db/scheduling", () => store);
vi.mock("../_core/scheduling/calendar", () => ({ readOwnCalendar: store.readOwnCalendar }));
vi.mock("../_core/audit-events", () => ({ auditActor: () => ({}), auditRequest: () => ({}), recordAuditRequired: vi.fn() }));
import { schedulingRouter } from "./scheduling";

function caller(id: number | null) {
  return schedulingRouter.createCaller({ user: id ? { id, role: "user" } : null, req: { headers: {} }, res: {} } as TrpcContext);
}
beforeEach(() => vi.clearAllMocks());
describe("Scheduling authenticated API", () => {
  it("provisions only for the authenticated owner", async () => {
    additions.ensure.mockResolvedValue({ state: "ready", managed: true });
    await expect(caller(null).ensureCalendar()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await caller(42).ensureCalendar();
    expect(additions.ensure).toHaveBeenCalledWith(42);
  });
  it("requires authentication", async () => {
    await expect(caller(null).status()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("uses only the logged-in owner for credentials and reads", async () => {
    const credentials = { userId: 42, username: "alice", calendarName: "personal", appPassword: "private" };
    store.getCalendarCredentials.mockResolvedValue(credentials);
    store.readOwnCalendar.mockResolvedValue([]);
    await caller(42).events({ start: "2026-10-12T00:00:00Z", end: "2026-10-13T00:00:00Z" });
    expect(store.getCalendarCredentials).toHaveBeenCalledWith(42);
    expect(store.readOwnCalendar.mock.calls[0].slice(0, 2)).toEqual([42, credentials]);
  });
  it("never returns credentials from status", async () => {
    store.getCalendarBinding.mockResolvedValue({ enabled: true, discoverable: false, encryptedPassword: "secret", username: "alice" });
    expect(await caller(42).status()).toEqual({ configured: Boolean(process.env.NEXTCLOUD_BASE_URL), bound: true, enabled: true, discoverable: false, writeEnabled: false, autoAvailability: false, timeZone: "" });
  });
  it("rejects ordinary-user binding changes", async () => {
    await expect(caller(42).saveBinding({ userId: 43, username: "bob", calendarName: "personal", appPassword: "private", enabled: true, discoverable: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(store.saveCalendarBinding).not.toHaveBeenCalled();
  });
});
