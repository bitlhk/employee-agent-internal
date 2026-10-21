import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { recordAuditRequired } from "../audit-events";
const state = vi.hoisted(() => ({
  credentials: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  claim: vi.fn(),
  finish: vi.fn(),
  write: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
}));
vi.mock("mysql2/promise", () => ({
  default: {
    createConnection: vi.fn(async () => ({
      query: state.query,
      end: state.end,
    })),
  },
}));
vi.mock("../../db/scheduling", () => ({
  getCalendarCredentials: state.credentials,
}));
vi.mock("../../db/calendar-drafts", () => ({
  createCalendarDraft: state.create,
  getCalendarDraft: state.get,
  claimCalendarDraft: state.claim,
  finishCalendarDraft: state.finish,
}));
vi.mock("../audit-events", () => ({ recordAuditRequired: vi.fn() }));
vi.mock("./write-calendar", () => ({
  bindingFingerprint: () => "binding",
  executeCalendarWrite: state.write,
}));
import { confirmCalendarWrite, prepareCalendarWrite } from "./write-service";
const event = {
  title: "Meeting",
  location: "",
  time: {
    type: "timed" as const,
    start: "2026-10-13T09:00:00Z",
    end: "2026-10-13T10:00:00Z",
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXTCLOUD_BASE_URL = "http://127.0.0.1:8088";
  state.query.mockResolvedValue([[{ acquired: 1 }]]);
  state.credentials.mockResolvedValue({ userId: 42, writeEnabled: true });
  state.claim.mockResolvedValue(true);
  state.get.mockResolvedValue({
    id: "draft",
    status: "pending",
    payload: { action: "create", event },
    bindingFingerprint: "binding",
    expiresAt: new Date(Date.now() + 60_000),
  });
  state.write.mockResolvedValue({ resourceId: "resource" });
});
describe("Stored owner-bound confirmation", () => {
  it("prepares without executing", async () => {
    state.create.mockResolvedValue("draft");
    expect(
      await prepareCalendarWrite(42, { action: "create", event })
    ).toMatchObject({ draftId: "draft" });
    expect(state.write).not.toHaveBeenCalled();
    expect(state.create).toHaveBeenCalledWith(42, "binding", {
      action: "create",
      event,
    });
  });
  it("rejects another owner's unavailable draft", async () => {
    state.get.mockResolvedValue(null);
    await expect(confirmCalendarWrite(43, "draft")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(state.get).toHaveBeenCalledWith(43, "draft");
    expect(state.write).not.toHaveBeenCalled();
  });
  it("rejects expired drafts and revoked write authority", async () => {
    state.get.mockResolvedValue({ status: "pending", expiresAt: new Date(0) });
    await expect(confirmCalendarWrite(42, "draft")).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    state.get.mockResolvedValue({
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
      bindingFingerprint: "binding",
    });
    state.credentials.mockResolvedValue({ userId: 42, writeEnabled: false });
    await expect(confirmCalendarWrite(42, "draft")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(state.write).not.toHaveBeenCalled();
  });
  it("rejects a changed binding", async () => {
    state.get.mockResolvedValue({
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
      bindingFingerprint: "another-binding",
    });
    await expect(confirmCalendarWrite(42, "draft")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(state.write).not.toHaveBeenCalled();
  });
  it("executes only the stored payload once and returns completion on repeat", async () => {
    await expect(confirmCalendarWrite(42, "draft")).resolves.toEqual({
      completed: true,
    });
    expect(state.write).toHaveBeenCalledWith(42, expect.anything(), "draft", {
      action: "create",
      event,
    });
    expect(state.finish).toHaveBeenCalledWith(42, "draft", "completed");
    state.get.mockResolvedValue({ status: "completed" });
    await confirmCalendarWrite(42, "draft");
    expect(state.write).toHaveBeenCalledTimes(1);
  });
  it("marks uncertain results for reconciliation and releases the owner lock", async () => {
    state.write.mockRejectedValue(new Error("timeout"));
    await expect(confirmCalendarWrite(42, "draft")).rejects.toThrow("timeout");
    expect(state.finish).toHaveBeenCalledWith(42, "draft", "unknown");
    expect(state.query).toHaveBeenCalledWith("SELECT RELEASE_LOCK(?)", [
      "calendar-write:42",
    ]);
    expect(state.end).toHaveBeenCalled();
  });
  it("cannot execute concurrently for the same owner", async () => {
    state.query.mockResolvedValue([[{ acquired: 0 }]]);
    await expect(confirmCalendarWrite(42, "draft")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(state.write).not.toHaveBeenCalled();
  });
  it("keeps a successful calendar write recoverable if subsequent bookkeeping fails", async () => {
    vi.mocked(recordAuditRequired)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new TRPCError({ code: "FORBIDDEN" }));
    await expect(confirmCalendarWrite(42, "draft")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(state.write).toHaveBeenCalledOnce();
    expect(state.finish).toHaveBeenCalledWith(42, "draft", "unknown");
  });
});
