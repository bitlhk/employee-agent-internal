import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarCascade } from "../../../drizzle/schema";
import { topologicalSteps } from "../../../shared/scheduling-cascade";
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  claim: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
  confirm: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  meeting: vi.fn(),
  draft: vi.fn(),
  prepare: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("../../db/calendar-cascades", () => ({
  getCascade: mocks.get,
  claimCascade: mocks.claim,
  updateCascade: mocks.update,
  insertCascade: mocks.insert,
  confirmCascadeRecord: mocks.confirm,
  stopCascadeRecord: mocks.stop,
  cancelUnconfirmedCascade: mocks.cancel,
}));
vi.mock("../../db/calendar-meetings", () => ({ getMeeting: mocks.meeting }));
vi.mock("../../db/calendar-reschedules", () => ({
  getReschedule: mocks.draft,
}));
vi.mock("./reschedule-service", () => ({
  prepareReschedule: mocks.prepare,
  confirmReschedule: mocks.execute,
}));
vi.mock("../audit-events", () => ({ recordAuditRequired: vi.fn() }));
import {
  advanceCascade,
  prepareCascade,
  confirmCascade,
} from "./cascade-service";
const event = (hour: number) => ({
  title: "meeting",
  location: "",
  time: {
    type: "timed" as const,
    start: `2099-10-20T${hour}:00:00+08:00`,
    end: `2099-10-20T${hour}:30:00+08:00`,
  },
});
const payload = (e: ReturnType<typeof event>) => ({
  event: e,
  organizer: { userId: 1, username: "a", email: "a@test.invalid", name: "A" },
  attendees: [{ userId: 2, username: "b", email: "b@test.invalid", name: "B" }],
});
let plan: CalendarCascade;
beforeEach(() => {
  vi.resetAllMocks();
  plan = {
    id: randomUUID(),
    userId: 1,
    requestKey: randomUUID(),
    title: "move",
    planHash: "hash",
    status: "confirmed",
    confirmedAt: new Date(),
    compensationConfirmedAt: null,
    stopRequested: false,
    expiresAt: new Date(Date.now() + 60_000),
    leaseToken: "lease",
    steps: [
      {
        key: "a",
        meetingId: randomUUID(),
        draftId: "draft-a",
        previous: event(10),
        event: event(11),
        dependsOn: ["b"],
        state: "pending",
      },
      {
        key: "b",
        meetingId: randomUUID(),
        draftId: "draft-b",
        previous: event(11),
        event: event(12),
        dependsOn: [],
        state: "pending",
      },
    ],
  } as CalendarCascade;
  mocks.get.mockImplementation(async () => plan);
  mocks.claim.mockImplementation(async () => ({
    plan: structuredClone(plan),
    token: "lease",
  }));
  mocks.update.mockImplementation(async (_u, _id, _lease, data) => {
    Object.assign(plan, structuredClone(data));
  });
  mocks.execute.mockResolvedValue({ status: "completed" });
  mocks.draft.mockResolvedValue({ status: "pending" });
});
describe("dependent calendar changes", () => {
  it("executes dependencies first, persists receipts and completes only after every step", async () => {
    await advanceCascade(1, plan.id);
    expect(mocks.execute.mock.calls.map(call => call[1])).toEqual([
      "draft-b",
      "draft-a",
    ]);
    expect(plan.status).toBe("completed");
    expect(plan.steps.every(step => step.state === "completed")).toBe(true);
  });
  it("yields while a dependency waits, then resumes without executing a successful step again", async () => {
    mocks.execute.mockResolvedValueOnce({ status: "checking" });
    await advanceCascade(1, plan.id);
    expect(plan.status).toBe("waiting");
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    await advanceCascade(1, plan.id);
    expect(plan.status).toBe("completed");
    plan.status = "running";
    await advanceCascade(1, plan.id);
    expect(mocks.execute).toHaveBeenCalledTimes(3);
  });
  it("records partial success and does not silently undo earlier writes", async () => {
    mocks.execute
      .mockResolvedValueOnce({ status: "completed" })
      .mockRejectedValueOnce(new Error("ETag changed"));
    await advanceCascade(1, plan.id);
    expect(plan.status).toBe("partial");
    expect(plan.steps.find(step => step.key === "b")?.state).toBe("completed");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it("retains unknown writes for reconciliation instead of reporting failure or cancellation", async () => {
    plan.stopRequested = true;
    mocks.draft.mockResolvedValue({ status: "unknown" });
    mocks.execute.mockRejectedValue(new Error("lost response"));
    await advanceCascade(1, plan.id);
    expect(mocks.execute).toHaveBeenCalledWith(
      1,
      "draft-b",
      expect.objectContaining({ reconcileOnly: true })
    );
    expect(plan.status).toBe("waiting");
    expect(plan.errorCode).toBe("VERIFY_REQUIRED");
  });
  it("stops successors while keeping the already successful step visible", async () => {
    mocks.execute.mockImplementationOnce(async () => {
      plan.stopRequested = true;
      return { status: "completed" };
    });
    await advanceCascade(1, plan.id);
    expect(plan.status).toBe("partial");
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it("requires separate compensation consent and restores in reverse dependency order", async () => {
    plan.status = "compensating";
    plan.steps.forEach(step => {
      step.state = "completed";
      step.compensationDraftId = `restore-${step.key}`;
    });
    await advanceCascade(1, plan.id);
    expect(mocks.execute).not.toHaveBeenCalled();
    plan.compensationConfirmedAt = new Date();
    plan.status = "compensating";
    await advanceCascade(1, plan.id);
    expect(mocks.execute.mock.calls.map(call => call[1])).toEqual([
      "restore-a",
      "restore-b",
    ]);
    expect(plan.status).toBe("compensated");
    expect(plan.steps.every(step => step.compensated)).toBe(true);
  });
  it("refuses changed plan hashes and confirmation expiry", async () => {
    await expect(confirmCascade(1, plan.id, "different")).rejects.toThrow(
      "版本"
    );
    plan.status = "pending";
    mocks.confirm.mockResolvedValue(false);
    await expect(confirmCascade(1, plan.id, "hash")).rejects.toThrow("过期");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("infers dependencies and saves deterministic drafts before any calendar execution", async () => {
    mocks.meeting.mockImplementation(async id => ({
      creatorUserId: 1,
      status: "invited",
      payload: payload(
        plan.steps.find(step => step.meetingId === id)!.previous
      ),
    }));
    mocks.insert.mockImplementation(
      async input => (plan = { ...plan, ...input, status: "drafting" })
    );
    mocks.prepare.mockImplementation(
      async (_u, _meeting, _event, _cascade, operation) => ({
        draftId: operation,
      })
    );
    mocks.draft.mockImplementation(async (_u, id) => {
      const call = mocks.prepare.mock.calls.find(call => call[4] === id)!;
      return {
        previous: payload(
          plan.steps.find(step => step.meetingId === call[1])!.previous
        ),
      };
    });
    await prepareCascade(1, {
      requestKey: plan.requestKey,
      title: "move",
      steps: plan.steps.map(step => ({
        key: step.key,
        meetingId: step.meetingId,
        event: step.event,
        dependsOn: [],
      })),
    });
    expect(plan.steps[0].dependsOn).toEqual(["b"]);
    expect(plan.status).toBe("pending");
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(
      mocks.prepare.mock.calls.every(call => /^[0-9a-f-]{36}$/.test(call[4]))
    ).toBe(true);
  });
  it("rejects cycles, duplicate keys and absent dependencies before running", () => {
    expect(() =>
      topologicalSteps([
        { key: "a", dependsOn: ["b"] },
        { key: "b", dependsOn: ["a"] },
      ])
    ).toThrow("循环");
    expect(() =>
      topologicalSteps([{ key: "a", dependsOn: ["missing"] }])
    ).toThrow("不存在");
    expect(() =>
      topologicalSteps([
        { key: "a", dependsOn: [] },
        { key: "a", dependsOn: [] },
      ])
    ).toThrow("重复");
  });
});
