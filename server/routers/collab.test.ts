vi.mock("../db/coop-identity", () => ({ assertCoopParticipants: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../_core/context";
const store = vi.hoisted(() => ({ getClawByAdoptId: vi.fn(), getCollabSettings: vi.fn(), getCollabRequest: vi.fn(), updateCollabRequest: vi.fn(), listOutgoingCollabRequests: vi.fn(), listCollabDisplayNames: vi.fn() }));
vi.mock("../db", () => store);
vi.mock("../_core/coop-runtime-executor", () => ({ getCoopRuntimeExecutor: () => ({ protocol: "runtime-retired" }) }));
import { collabRouter } from "./collab";
const caller = (id: number | null) => collabRouter.createCaller({ user: id ? { id } : null, req: { headers: {} }, res: {} } as TrpcContext);
beforeEach(() => {
  vi.resetAllMocks();
  store.getClawByAdoptId.mockImplementation(async adoptId => ({ userId: adoptId === "A" ? 10 : 20, adoptId, runtime: "jiuwenswarm" }));
  store.getCollabRequest.mockResolvedValue({ id: 1, requesterAdoptId: "A", targetAdoptId: "B", status: "pending" });
  store.listCollabDisplayNames.mockResolvedValue(new Map());
});
describe("legacy collaboration API regression", () => {
  it("applies scheduling-only sharing policy to calendar results without exposing private envelopes", async () => {
    store.listOutgoingCollabRequests.mockResolvedValue([{ id: 1, targetAdoptId: "B", targetUserId: 20, taskType: "scheduling", resultSummary: "bounded availability", resultMeta: '{"structured_outputs":{"private":true}}' }]);
    store.getCollabSettings.mockResolvedValue({ sharingPolicy: "result-only", schedulingSharingPolicy: "none" });
    const [withheld] = await caller(10).outgoing({ adoptId: "A" });
    expect(withheld.resultSummary).toBe("");
    expect(withheld.resultEnvelope).toEqual({ deliverMode: "none" });
    store.getCollabSettings.mockResolvedValue({ sharingPolicy: "none", schedulingSharingPolicy: "result-only" });
    const [released] = await caller(10).outgoing({ adoptId: "A" });
    expect(released.resultSummary).toBe("bounded availability");
    expect(JSON.stringify(released)).not.toContain("private");
  });
  it("keeps authentication and recipient owner approval checks", async () => {
    await expect(caller(null).reviewRequest({ adoptId: "B", requestId: 1, action: "approve" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller(10).reviewRequest({ adoptId: "B", requestId: 1, action: "approve" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(store.updateCollabRequest).not.toHaveBeenCalled();
  });
  it("keeps an approval approved when there is no supported execution adapter", async () => {
    const result = await caller(20).reviewRequest({ adoptId: "B", requestId: 1, action: "approve" });
    expect(result).toMatchObject({ success: true, autoExecutionAvailable: false });
    expect(store.updateCollabRequest).toHaveBeenCalledTimes(1);
    expect(store.updateCollabRequest).toHaveBeenCalledWith(1, expect.objectContaining({ status: "approved", approvedBy: 20 }));
  });
  it("accepts an owner's legacy result during approved or running execution", async () => {
    for (const status of ["approved", "running"]) {
      store.getCollabRequest.mockResolvedValue({ id: 1, targetAdoptId: "B", status });
      await expect(caller(20).submitResult({ adoptId: "B", requestId: 1, status: "completed", resultEnvelope: { status: "success", summary: "旧版摘要" } })).resolves.toEqual({ success: true });
    }
    expect(store.updateCollabRequest).toHaveBeenCalledTimes(2);
  });
  it("does not expose a withheld legacy envelope through outgoing results", async () => {
    store.listOutgoingCollabRequests.mockResolvedValue([{ id: 1, targetAdoptId: "B", resultSummary: "private summary", resultMeta: '{"deliverMode":"none","structured_outputs":{"private":true}}' }]);
    const [result] = await caller(10).outgoing({ adoptId: "A" });
    expect(result.resultSummary).toBe("");
    expect(result.resultEnvelope).toEqual({ deliverMode: "none" });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("retains full historical envelopes when no delivery restriction was set", async () => {
    store.listOutgoingCollabRequests.mockResolvedValue([{ id: 1, targetAdoptId: "B", taskType: "old-custom-type", resultSummary: "legacy", resultMeta: '{"structured_outputs":{"count":3}}' }]);
    const [result] = await caller(10).outgoing({ adoptId: "A" });
    expect(result).toMatchObject({ taskType: "old-custom-type", resultSummary: "legacy", resultEnvelope: { structured_outputs: { count: 3 } } });
  });
});
