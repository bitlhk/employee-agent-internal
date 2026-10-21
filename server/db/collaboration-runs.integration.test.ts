import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  collaborationRuns,
  collaborationWaits,
  clawCollabRequests,
} from "../../drizzle/schema";
import { getDb, closeDbConnection } from "./connection";
import {
  createCollaborationGoal,
  claimCollaborationRun,
  finishCollaborationTurn,
  validateCollaborationLease,
  watchCollaborationResource,
  notifyCollaborationResource,
  getCollaborationRun,
  createRunCollaborationRequest,
  ensureRecipientRun,
  createConversationCollaborationRequest,
  requestConversationContinuation,
  cancelCollaborationRun,
} from "./collaboration-runs";
const suite =
  process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const ids: string[] = [];
const requests: number[] = [];
const adoptId = `lgj-runs-test-${randomUUID().slice(0, 8)}`;
async function goal() {
  const run = await createCollaborationGoal({
    userId: 1_900_100_000,
    adoptId,
    requestKey: randomUUID(),
    taskType: "scheduling",
    objective: "test only",
    expectedEffect: "calendar_write",
    sourceSessionId: "test",
    sourceConversationId: null,
  });
  ids.push(run.id);
  return run;
}
suite("durable continuation leases and independent exchanges", () => {
  it("atomically waits for a direct request, then resumes its original conversation once", async () => {
    const requestId = await createConversationCollaborationRequest(
      {
        requesterAdoptId: `${adoptId}-reply`,
        requesterUserId: 1_900_100_000,
        targetAdoptId: "test-target",
        targetUserId: 1_900_100_001,
        taskType: "scheduling",
        taskSummary: "询问忙闲",
        status: "pending",
        requestKey: randomUUID(),
      },
      { sourceSessionId: "verified-origin", sourceConversationId: "original" }
    );
    requests.push(requestId);
    const run = await requestConversationContinuation(requestId);
    expect(run).toMatchObject({
      status: "waiting",
      sourceSessionId: "verified-origin",
      expectedEffect: "read",
      requestCount: 1,
    });
    ids.push(run!.id);
    expect(await claimCollaborationRun(run!.id)).toBeNull();
    await notifyCollaborationResource(
      run!.id,
      "request",
      String(requestId),
      "completed"
    );
    const claim = await claimCollaborationRun(run!.id);
    expect(claim).toBeTruthy();
    expect(await claimCollaborationRun(run!.id)).toBeNull();
    await finishCollaborationTurn(run!.id, claim!.token, {
      status: "completed",
      publicMessage: "对方有空",
    });
    await notifyCollaborationResource(
      run!.id,
      "request",
      String(requestId),
      "completed"
    );
    expect((await getCollaborationRun(run!.id))?.status).toBe("completed");
  });
  afterAll(async () => {
    const db = await getDb();
    if (db && ids.length) {
      await db
        .delete(collaborationWaits)
        .where(inArray(collaborationWaits.runId, ids));
      await db
        .delete(collaborationRuns)
        .where(inArray(collaborationRuns.id, ids));
    }
    if (db && requests.length)
      await db
        .delete(clawCollabRequests)
        .where(inArray(clawCollabRequests.id, requests));
    await closeDbConnection();
  });
  it("claims once, rejects forged/stale capabilities and resumes after process loss", async () => {
    const run = await goal();
    const [a, b] = await Promise.all([
      claimCollaborationRun(run.id),
      claimCollaborationRun(run.id),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const first = (a || b)!;
    await expect(validateCollaborationLease(run.id, "forged")).rejects.toThrow(
      "失效"
    );
    const db = (await getDb())!;
    await db
      .update(collaborationRuns)
      .set({ leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(collaborationRuns.id, run.id));
    const second = (await claimCollaborationRun(run.id))!;
    expect(second.run.turn).toBe(2);
    expect(
      await finishCollaborationTurn(run.id, first.token, {
        status: "completed",
      })
    ).toBe(false);
    expect(
      await finishCollaborationTurn(run.id, second.token, { status: "waiting" })
    ).toBe(true);
  });
  it("does not lose a result arriving during execution and deduplicates repeated wakeups", async () => {
    const run = await goal();
    await watchCollaborationResource(run.id, "request", "12345");
    const claim = (await claimCollaborationRun(run.id))!;
    await notifyCollaborationResource(
      run.id,
      "request",
      "12345",
      "released-result-v1"
    );
    await finishCollaborationTurn(run.id, claim.token, { status: "waiting" });
    expect((await getCollaborationRun(run.id))?.status).toBe("ready");
    const next = (await claimCollaborationRun(run.id))!;
    await finishCollaborationTurn(run.id, next.token, { status: "waiting" });
    await notifyCollaborationResource(
      run.id,
      "request",
      "12345",
      "released-result-v1"
    );
    expect((await getCollaborationRun(run.id))?.status).toBe("waiting");
    await notifyCollaborationResource(
      run.id,
      "request",
      "12345",
      "released-result-v2"
    );
    expect((await getCollaborationRun(run.id))?.status).toBe("ready");
  });
  it("reserves the shared request budget atomically and keeps child exchanges independent", async () => {
    const run = await goal();
    const payload = {
      requesterAdoptId: adoptId,
      requesterUserId: run.userId,
      targetAdoptId: `${adoptId}-b`,
      targetUserId: run.userId + 1,
      taskType: "scheduling",
      taskSummary: "B asks its own question",
      status: "approved" as const,
      approvalMode: "auto" as const,
      requestKey: randomUUID(),
    };
    const requestId = await createRunCollaborationRequest(run.id, payload);
    requests.push(requestId);
    const db = (await getDb())!;
    const [request] = await db
      .select()
      .from(clawCollabRequests)
      .where(eq(clawCollabRequests.id, requestId));
    await ensureRecipientRun(request, run);
    await ensureRecipientRun(request, run);
    const children = await db
      .select()
      .from(collaborationRuns)
      .where(eq(collaborationRuns.requestId, requestId));
    expect(children).toHaveLength(1);
    ids.push(children[0].id);
    expect(children[0].adoptId).toBe(payload.targetAdoptId);
    expect(children[0].budgetRootId).toBe(run.id);
    expect((await getCollaborationRun(run.id))?.status).toBe("ready");
    await db
      .update(collaborationRuns)
      .set({ requestCount: 32 })
      .where(eq(collaborationRuns.id, run.id));
    await expect(
      createRunCollaborationRequest(run.id, {
        ...payload,
        requestKey: randomUUID(),
      })
    ).rejects.toThrow("上限");
    const stored = await db
      .select()
      .from(clawCollabRequests)
      .where(eq(clawCollabRequests.requesterAdoptId, adoptId));
    expect(stored).toHaveLength(1);
    await cancelCollaborationRun(run.userId, run.id, adoptId);
    expect((await getCollaborationRun(children[0].id))?.status).toBe(
      "cancelled"
    );
    const [cancelled] = await db
      .select()
      .from(clawCollabRequests)
      .where(eq(clawCollabRequests.id, requestId));
    expect(cancelled.status).toBe("cancelled");
  });
  it("cancellation revokes in-flight capabilities without claiming calendar reversal", async () => {
    const run = await goal();
    const claim = (await claimCollaborationRun(run.id))!;
    expect(await cancelCollaborationRun(run.userId + 1, run.id, adoptId)).toBe(
      false
    );
    expect(await cancelCollaborationRun(run.userId, run.id, adoptId)).toBe(
      true
    );
    await expect(
      validateCollaborationLease(run.id, claim.token)
    ).rejects.toThrow("失效");
    expect(
      await finishCollaborationTurn(run.id, claim.token, {
        status: "completed",
      })
    ).toBe(false);
  });
});
