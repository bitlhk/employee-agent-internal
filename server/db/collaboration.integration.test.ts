import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../_core/collaboration/authority", () => ({
  assertCollaborationAuthority: vi.fn(),
  CollaborationAuthorityRevoked: class extends Error {},
}));
import {
  clawAdoptions,
  clawCollabRequests,
  clawCollabSettings,
  collaborationRuns,
  collaborationWaits,
  lxCollabSpaces,
  lxCollabUserProfiles,
} from "../../drizzle/schema";
import { closeDbConnection, getDb } from "./connection";
import {
  getCollabRequest,
  updateCollabRequest,
  upsertCollabSettings,
} from "./collab";
import { sendCollaborationRequest } from "../_core/collaboration/request-service";
import { replyToCollaboration } from "../_core/collaboration/reply-service";
import { handleCollaborationTool } from "../_core/collaboration/platform-tools";
import { recoverCollaborationWork } from "../_core/collaboration/worker";
import {
  createCollaborationGoal,
  getCollaborationRun,
  notifyCollaborationResource,
} from "./collaboration-runs";
import { handleCollaborationGoalTool } from "../_core/collaboration/goal-tools";

const suite =
  process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const prefix = `lgj-collab-test-${randomUUID().slice(0, 8)}`;
const adopts = ["A", "B", "C"].map(name => `${prefix}-${name}`);
const owner = 1_900_000_000 + Math.floor(Math.random() * 100_000);
const adoptionIds: number[] = [];
const requestIds: number[] = [];
const runIds: string[] = [];
let spaceId: number;
const decode = (result: Awaited<ReturnType<typeof handleCollaborationTool>>) =>
  JSON.parse(result.content[0].text);

suite("persisted independent collaboration exchanges", () => {
  beforeAll(async () => {
    const db = await getDb();
    if (!db) throw new Error("DATABASE_URL is required");
    const [space] = await db
      .insert(lxCollabSpaces)
      .values({ name: prefix, status: "active" });
    spaceId = Number(space.insertId);
    await db
      .insert(lxCollabUserProfiles)
      .values(
        adopts.map((_, index) => ({
          userId: owner + index,
          spaceId,
          status: "active" as const,
        }))
      );
    for (const [index, adoptId] of adopts.entries()) {
      const [insert] = await db.insert(clawAdoptions).values({
        userId: owner + index,
        adoptId,
        agentId: `agent-${adoptId}`,
        status: "active",
        permissionProfile: "plus",
        roleTemplate: "general-assistant",
        runtime: "jiuwenswarm",
        entryUrl: `/claw/${adoptId}`,
      });
      adoptionIds.push(Number(insert.insertId));
      await upsertCollabSettings(Number(insert.insertId), {
        acceptTask: "approval",
        schedulingAcceptTask: "approval",
        sharingPolicy: "result-only",
        visibilityMode: "private",
      });
    }
  });
  afterAll(async () => {
    const db = await getDb();
    if (db) {
      const jobs = await db
        .select({ id: collaborationRuns.id })
        .from(collaborationRuns)
        .where(inArray(collaborationRuns.adoptId, adopts));
      runIds.push(...jobs.map(row => row.id));
      if (runIds.length) {
        await db
          .delete(collaborationWaits)
          .where(inArray(collaborationWaits.runId, runIds));
        await db
          .delete(collaborationRuns)
          .where(inArray(collaborationRuns.id, runIds));
      }
      if (requestIds.length)
        await db
          .delete(clawCollabRequests)
          .where(inArray(clawCollabRequests.id, requestIds));
      if (adoptionIds.length)
        await db
          .delete(clawCollabSettings)
          .where(inArray(clawCollabSettings.adoptionId, adoptionIds));
      await db
        .delete(clawAdoptions)
        .where(inArray(clawAdoptions.adoptId, adopts));
      await db
        .delete(lxCollabUserProfiles)
        .where(eq(lxCollabUserProfiles.spaceId, spaceId));
      await db.delete(lxCollabSpaces).where(eq(lxCollabSpaces.id, spaceId));
    }
    await closeDbConnection();
  });

  it("persists A→B and B→C separately, and releases only B's conclusion to A", async () => {
    const send = async (from: number, to: number, summary: string) => {
      const result = await sendCollaborationRequest(owner + from, {
        requesterAdoptId: adopts[from],
        targetAdoptId: adopts[to],
        taskType: "scheduling",
        taskSummary: summary,
        requestKey: randomUUID(),
      });
      requestIds.push(result.id);
      return result;
    };
    const ab = await send(0, 1, "明天下午是否有空？");
    const bc = await send(1, 2, "我们的原安排能否调整？");
    expect(ab.status).toBe("pending");
    expect(bc.status).toBe("pending");
    await expect(
      replyToCollaboration(owner + 1, adopts[1], {
        requestId: ab.id,
        scheduling: {
          availability: "unknown",
          slots: [],
          validUntil: new Date(Date.now() + 300_000).toISOString(),
        },
      })
    ).rejects.toThrow("尚未批准");
    await updateCollabRequest(bc.id, { status: "approved" });
    const scheduling = {
      availability: "conditional" as const,
      slots: [],
      validUntil: new Date(Date.now() + 300_000).toISOString(),
    };
    await replyToCollaboration(owner + 2, adopts[2], {
      requestId: bc.id,
      scheduling,
    });
    expect((await getCollabRequest(ab.id))?.status).toBe("pending");
    expect((await getCollabRequest(ab.id))?.sessionId).toBeNull();
    await expect(
      handleCollaborationTool(owner, adopts[0], "get_collaboration_result", {
        requestId: bc.id,
      })
    ).rejects.toThrow("只能查询");
    await updateCollabRequest(ab.id, { status: "approved" });
    await replyToCollaboration(owner + 1, adopts[1], {
      requestId: ab.id,
      scheduling,
    });
    const released = decode(
      await handleCollaborationTool(
        owner,
        adopts[0],
        "get_collaboration_result",
        { requestId: ab.id }
      )
    );
    expect(released).toMatchObject({
      requestId: ab.id,
      status: "completed",
      shared: true,
    });
    expect(JSON.parse(released.summary)).toMatchObject({
      availability: "conditional",
      calendarChanged: false,
    });
    expect(JSON.stringify(released)).not.toContain(adopts[2]);
    const followup = await send(0, 1, "那下一个时间呢？");
    expect(followup.id).not.toBe(ab.id);
    expect(followup.status).toBe("pending");
  });

  it("uses a database unique key to deduplicate concurrent retries and detects changed input", async () => {
    const input = {
      requesterAdoptId: adopts[0],
      targetAdoptId: adopts[1],
      taskType: "general",
      taskSummary: "独立重试测试",
      requestKey: randomUUID(),
    };
    const results = await Promise.all(
      Array.from({ length: 4 }, () => sendCollaborationRequest(owner, input))
    );
    const ids = [...new Set(results.map(row => row.id))];
    requestIds.push(...ids);
    expect(ids).toHaveLength(1);
    await expect(
      sendCollaborationRequest(owner, { ...input, taskSummary: "不同提议" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("automatically wakes C then B then A, while one exchange never completes the whole goal", async () => {
    const root = await createCollaborationGoal({
      userId: owner,
      adoptId: adopts[0],
      requestKey: randomUUID(),
      taskType: "scheduling",
      objective: "自动续办验证",
      expectedEffect: "read",
      sourceSessionId: "test",
      sourceConversationId: null,
    });
    runIds.push(root.id);
    const turns: string[] = [];
    let ab = 0;
    let bc = 0;
    const execute = async (
      run: import("../../drizzle/schema").CollaborationRun,
      token: string,
      prompt: string
    ) => {
      turns.push(run.adoptId);
      const context = { run, leaseToken: token };
      if ((run.id === root.id && !ab) || (run.adoptId === adopts[1] && !bc)) {
        const index = run.id === root.id ? 0 : 1;
        const request = await sendCollaborationRequest(
          owner + index,
          {
            requesterAdoptId: adopts[index],
            targetAdoptId: adopts[index + 1],
            taskType: "scheduling",
            taskSummary: index ? "C的独立问题，不向A发布" : "B是否可用",
            requestKey: randomUUID(),
          },
          run.id
        );
        requestIds.push(request.id);
        await updateCollabRequest(request.id, { status: "approved" });
        if (index) bc = request.id;
        else ab = request.id;
        await handleCollaborationGoalTool(
          run.userId,
          run.adoptId,
          "checkpoint_collaboration_goal",
          { checkpoint: "等待我发出的本次询问", message: "正在等待" },
          context
        );
      } else if (run.requestId) {
        await handleCollaborationTool(
          run.userId,
          run.adoptId,
          "reply_collaboration_request",
          {
            requestId: run.requestId,
            scheduling: {
              availability: "unknown",
              slots: [],
              validUntil: new Date(Date.now() + 60_000).toISOString(),
            },
          },
          context
        );
      } else {
        expect(prompt).not.toContain("C的独立问题");
        expect(prompt).not.toContain(adopts[2]);
        await handleCollaborationGoalTool(
          run.userId,
          run.adoptId,
          "finish_collaboration_goal",
          { message: "已完成询问，可用性未知", evidence: [] },
          context
        );
      }
      return "turn ended";
    };
    const errors: string[] = [];
    const checkedExecute: typeof execute = async (...args) => {
      try {
        return await execute(...args);
      } catch (error) {
        errors.push(String(error));
        throw error;
      }
    };
    await recoverCollaborationWork(checkedExecute, { adoptIds: adopts });
    expect((await getCollaborationRun(root.id))?.status).toBe("waiting");
    for (
      let i = 0;
      i < 8 && (await getCollaborationRun(root.id))?.status !== "completed";
      i++
    )
      await recoverCollaborationWork(checkedExecute, { adoptIds: adopts });
    expect(errors).toEqual([]);
    expect(
      (await getCollaborationRun(root.id))?.status,
      JSON.stringify({ turns })
    ).toBe("completed");
    expect(turns.filter(id => id === adopts[0])).toHaveLength(2);
    expect(turns.filter(id => id === adopts[1])).toHaveLength(2);
    expect(turns.filter(id => id === adopts[2])).toHaveLength(1);
    expect((await getCollabRequest(ab))?.status).toBe("completed");
    expect((await getCollabRequest(bc))?.status).toBe("completed");
  });

  it("returns only unknown when a recipient pauses without an answer, never its private runtime output", async () => {
    const root = await createCollaborationGoal({
      userId: owner,
      adoptId: adopts[0],
      requestKey: randomUUID(),
      taskType: "scheduling",
      objective: "接收方无法答复时不要卡住",
      expectedEffect: "read",
      sourceSessionId: "test",
      sourceConversationId: null,
    });
    runIds.push(root.id);
    let requestId = 0;
    const execute = async (
      run: import("../../drizzle/schema").CollaborationRun,
      token: string
    ) => {
      if (run.id === root.id && !requestId) {
        const request = await sendCollaborationRequest(
          owner,
          {
            requesterAdoptId: adopts[0],
            targetAdoptId: adopts[1],
            taskType: "scheduling",
            taskSummary: "是否可用",
            requestKey: randomUUID(),
          },
          root.id
        );
        requestId = request.id;
        requestIds.push(request.id);
        await updateCollabRequest(request.id, { status: "approved" });
        await handleCollaborationGoalTool(
          owner,
          adopts[0],
          "checkpoint_collaboration_goal",
          { checkpoint: "等待", message: "等待回复" },
          { run, leaseToken: token }
        );
      }
      return "私人日历内容和接收方内部模型文本，不得给A";
    };
    await recoverCollaborationWork(execute, { adoptIds: adopts });
    await recoverCollaborationWork(execute, { adoptIds: adopts });
    const request = (await getCollabRequest(requestId))!;
    expect(request.status).toBe("waiting_input");
    expect(JSON.parse(request.resultSummary!)).toMatchObject({
      availability: "unknown",
      calendarChanged: false,
    });
    expect(request.resultSummary).not.toContain("私人日历");
    expect((await getCollaborationRun(root.id))?.status).not.toBe("completed");
  });

  it("does not release an unknown reply when an arriving result makes the finishing recipient runnable again", async () => {
    const root = await createCollaborationGoal({
      userId: owner,
      adoptId: adopts[0],
      requestKey: randomUUID(),
      taskType: "scheduling",
      objective: "结果与轮次结束竞态",
      expectedEffect: "read",
      sourceSessionId: "race",
      sourceConversationId: null,
    });
    runIds.push(root.id);
    const ab = await sendCollaborationRequest(
      owner,
      {
        requesterAdoptId: adopts[0],
        targetAdoptId: adopts[1],
        taskType: "scheduling",
        taskSummary: "B内部协调后答复",
        requestKey: randomUUID(),
      },
      root.id
    );
    requestIds.push(ab.id);
    await updateCollabRequest(ab.id, { status: "approved" });
    let recipientId = "";
    await recoverCollaborationWork(
      async run => {
        recipientId = run.id;
        const bc = await sendCollaborationRequest(
          owner + 1,
          {
            requesterAdoptId: adopts[1],
            targetAdoptId: adopts[2],
            taskType: "scheduling",
            taskSummary: "内部询问",
            requestKey: randomUUID(),
          },
          run.id
        );
        requestIds.push(bc.id);
        await updateCollabRequest(bc.id, { status: "approved" });
        await replyToCollaboration(owner + 2, adopts[2], {
          requestId: bc.id,
          scheduling: {
            availability: "unknown",
            slots: [],
            validUntil: new Date(Date.now() + 60_000).toISOString(),
          },
        });
        await notifyCollaborationResource(
          run.id,
          "request",
          String(bc.id),
          "result-arrived-during-turn"
        );
        return "旧轮次仍认为在等待，平台应继续办理";
      },
      { adoptIds: [adopts[1]] }
    );
    expect((await getCollaborationRun(recipientId))?.status).toBe("ready");
    expect((await getCollabRequest(ab.id))?.status).toBe("approved");
    expect((await getCollabRequest(ab.id))?.resultSummary).toBeNull();
    // This fixture is intentionally left runnable; finish it before the next
    // dispatch test so it cannot consume that test's slots.
    const db = (await getDb())!;
    await db
      .update(collaborationRuns)
      .set({ status: "cancelled" })
      .where(inArray(collaborationRuns.id, [root.id, recipientId]));
    await updateCollabRequest(ab.id, { status: "cancelled" });
  });

  it("dispatches new work while an earlier model is blocked and caps detached turns at three", async () => {
    const gates = new Map<string, () => void>();
    const entered: string[] = [];
    const jobs: string[] = [];
    let active = 0;
    let peak = 0;
    const create = async () => {
      const run = await createCollaborationGoal({
        userId: owner + 2,
        adoptId: adopts[2],
        requestKey: randomUUID(),
        taskType: "scheduling",
        objective: "并发派发验证",
        expectedEffect: "read",
        sourceSessionId: "test",
        sourceConversationId: null,
      });
      runIds.push(run.id);
      jobs.push(run.id);
      return run;
    };
    const execute = async (
      run: import("../../drizzle/schema").CollaborationRun,
      token: string
    ) => {
      active++;
      peak = Math.max(peak, active);
      entered.push(run.id);
      try {
        await new Promise<void>(resolve => gates.set(run.id, resolve));
        await handleCollaborationGoalTool(
          run.userId,
          run.adoptId,
          "finish_collaboration_goal",
          { message: "并发验证完成", evidence: [] },
          { run, leaseToken: token }
        );
        return "done";
      } finally {
        active--;
      }
    };
    const options = { adoptIds: [adopts[2]], detachExecution: true };
    try {
      const first = await create();
      await recoverCollaborationWork(execute, options);
      await vi.waitFor(() => expect(entered).toContain(first.id));
      await create();
      await create();
      await create();
      await recoverCollaborationWork(execute, options);
      await vi.waitFor(() => expect(entered).toHaveLength(3));
      expect((await getCollaborationRun(first.id))?.status).toBe("running");
      await recoverCollaborationWork(execute, options);
      const fourth = jobs.find(id => !entered.includes(id))!;
      expect(fourth).toBeTruthy();
      gates.get(first.id)!();
      await vi.waitFor(async () =>
        expect((await getCollaborationRun(first.id))?.status).toBe("completed")
      );
      await recoverCollaborationWork(execute, options);
      await vi.waitFor(() => expect(entered).toContain(fourth));
      expect(peak).toBe(3);
    } finally {
      for (const release of gates.values()) release();
      await vi.waitFor(() => expect(active).toBe(0));
    }
    for (const id of jobs)
      expect((await getCollaborationRun(id))?.status).toBe("completed");
  });
});
