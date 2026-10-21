import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  collaborationRuns,
  collaborationWaits,
  clawCollabRequests,
  type CollaborationRun,
} from "../../drizzle/schema";
import { getDb } from "./connection";
import type { createCollabRequest } from "./collab";
const active = ["ready", "running", "waiting", "waiting_user"] as const;
async function database() {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db;
}
export const runSessionId = (id: string, turn?: number) =>
  `ea_collab_${id}${turn === undefined ? "" : `_${turn}`}`;
export const leaseHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export async function getCollaborationRun(id: string) {
  const [run] = await (await database())
    .select()
    .from(collaborationRuns)
    .where(eq(collaborationRuns.id, id))
    .limit(1);
  return run || null;
}
export async function ownCollaborationRuns(
  userId: number,
  adoptId: string,
  conversationId?: string
) {
  return (await database())
    .select()
    .from(collaborationRuns)
    .where(
      and(
        eq(collaborationRuns.userId, userId),
        eq(collaborationRuns.adoptId, adoptId),
        eq(collaborationRuns.kind, "goal"),
        conversationId
          ? eq(collaborationRuns.sourceConversationId, conversationId)
          : undefined
      )
    )
    .orderBy(sql`${collaborationRuns.createdAt} DESC`)
    .limit(30);
}
export async function createCollaborationGoal(input: {
  userId: number;
  adoptId: string;
  requestKey: string;
  taskType: string;
  objective: string;
  expectedEffect: "read" | "calendar_write";
  sourceSessionId: string;
  sourceConversationId: string | null;
  authorizationSnapshotId?: string;
}) {
  const db = await database();
  const id = randomUUID();
  await db
    .insert(collaborationRuns)
    .values({
      ...input,
      id,
      kind: "goal",
      budgetRootId: id,
      status: "ready",
      deadline: new Date(Date.now() + 24 * 3_600_000),
    })
    .onDuplicateKeyUpdate({ set: { requestKey: input.requestKey } });
  const [run] = await db
    .select()
    .from(collaborationRuns)
    .where(
      and(
        eq(collaborationRuns.adoptId, input.adoptId),
        eq(collaborationRuns.requestKey, input.requestKey)
      )
    )
    .limit(1);
  if (
    !run ||
    run.userId !== input.userId ||
    run.taskType !== input.taskType ||
    run.objective !== input.objective ||
    run.expectedEffect !== input.expectedEffect ||
    run.sourceSessionId !== input.sourceSessionId
  )
    throw new Error("目标编号已用于不同的任务或会话");
  return run;
}
export async function watchCollaborationResource(
  runId: string,
  resourceKind: typeof collaborationWaits.$inferInsert.resourceKind,
  resourceId: string
) {
  await (await database())
    .insert(collaborationWaits)
    .values({ runId, resourceKind, resourceId, observedState: "new" })
    .onDuplicateKeyUpdate({ set: { resourceId } });
}
export async function attachCollaborationRequest(
  run: CollaborationRun,
  requestId: number
) {
  const db = await database();
  await db.transaction(async tx => {
    const [request] = await tx
      .select()
      .from(clawCollabRequests)
      .where(eq(clawCollabRequests.id, requestId))
      .limit(1);
    if (
      !request ||
      request.requesterAdoptId !== run.adoptId ||
      request.requesterUserId !== run.userId
    )
      throw new Error("请求不属于当前助手");
    const [existing] = await tx
      .select()
      .from(collaborationWaits)
      .where(
        and(
          eq(collaborationWaits.runId, run.id),
          eq(collaborationWaits.resourceKind, "request"),
          eq(collaborationWaits.resourceId, String(requestId))
        )
      )
      .limit(1);
    if (existing) return;
    const [reserved] = await tx
      .update(collaborationRuns)
      .set({ requestCount: sql`${collaborationRuns.requestCount}+1` })
      .where(
        and(
          eq(collaborationRuns.id, run.budgetRootId),
          inArray(collaborationRuns.status, [...active]),
          lt(collaborationRuns.requestCount, 32),
          gt(collaborationRuns.deadline, new Date())
        )
      );
    if (!reserved.affectedRows || run.depth >= 6)
      throw new Error("协商达到轮数或深度上限，需要本人调整目标后继续");
    await tx.insert(collaborationWaits).values({
      runId: run.id,
      resourceKind: "request",
      resourceId: String(requestId),
      observedState: "new",
    });
  });
}
export async function createRunCollaborationRequest(
  runId: string,
  payload: Parameters<typeof createCollabRequest>[0]
) {
  return (await database()).transaction(async tx => {
    const [run] = await tx
      .select()
      .from(collaborationRuns)
      .where(eq(collaborationRuns.id, runId))
      .for("update");
    if (
      !run ||
      run.taskType !== payload.taskType ||
      run.userId !== payload.requesterUserId ||
      run.adoptId !== payload.requesterAdoptId ||
      !active.includes(run.status as (typeof active)[number]) ||
      run.depth >= 6 ||
      run.deadline.getTime() <= Date.now()
    )
      throw new Error("当前协商上下文不可继续发送请求");
    const [budget] = await tx
      .update(collaborationRuns)
      .set({ requestCount: sql`${collaborationRuns.requestCount}+1` })
      .where(
        and(
          eq(collaborationRuns.id, run.budgetRootId),
          inArray(collaborationRuns.status, [...active]),
          lt(collaborationRuns.requestCount, 32)
        )
      );
    if (!budget.affectedRows)
      throw new Error("协商已达请求上限，需要本人决定是否继续");
    const [insert] = await tx.insert(clawCollabRequests).values(payload);
    const id = Number(insert.insertId);
    await tx.insert(collaborationWaits).values({
      runId,
      resourceKind: "request",
      resourceId: String(id),
      observedState: "new",
    });
    return id;
  });
}
export type ConversationContinuation = {
  sourceSessionId: string;
  sourceConversationId: string;
  authorizationSnapshotId?: string;
};

export async function requestConversationContinuation(requestId: number) {
  const [row] = await (
    await database()
  )
    .select({ run: collaborationRuns })
    .from(collaborationWaits)
    .innerJoin(
      collaborationRuns,
      eq(collaborationRuns.id, collaborationWaits.runId)
    )
    .where(
      and(
        eq(collaborationWaits.resourceKind, "request"),
        eq(collaborationWaits.resourceId, String(requestId)),
        eq(collaborationRuns.kind, "goal")
      )
    )
    .limit(1);
  return row?.run || null;
}

// Commit the request and its waiting continuation together, including for auto-approved requests.
export async function createConversationCollaborationRequest(
  payload: Parameters<typeof createCollabRequest>[0],
  source: ConversationContinuation,
  recipientLabel = "对方"
) {
  return (await database()).transaction(async tx => {
    const id = randomUUID();
    const [insert] = await tx.insert(clawCollabRequests).values(payload);
    const requestId = Number(insert.insertId);
    await tx.insert(collaborationRuns).values({
      id,
      kind: "goal",
      userId: payload.requesterUserId,
      adoptId: payload.requesterAdoptId,
      taskType: payload.taskType,
      expectedEffect: "read",
      status: "waiting",
      budgetRootId: id,
      requestCount: 1,
      requestKey: `reply:${requestId}`,
      ...source,
      objective: `你是发起询问的用户的助手，正在等待接收方“${recipientLabel}”对请求 ${requestId} 的最终答复。结果描述的是接收方的日历，不是发起用户本人的日历。通过 finish_collaboration_goal 的 message 直接向原对话用户回告对方的答复。message 就是用户实际收到的消息，请用日常语言说明接收方、所问时段和忙闲结论；不输出内部请求编号、字段名、JSON 或“已在原对话答复”等执行报告。原询问：${payload.taskSummary || "协作结果"}。这是一次询问的结果回告，不是安排会议的授权。结果未知、失败、拒绝或过期时如实说明；不要自行重新发起询问、准备日程或修改日历。`,
      deadline: new Date(Date.now() + 24 * 3_600_000),
    });
    await tx
      .insert(collaborationWaits)
      .values({
        runId: id,
        resourceKind: "request",
        resourceId: String(requestId),
        observedState: "new",
      });
    return requestId;
  });
}
export async function ensureRecipientRun(
  request: typeof clawCollabRequests.$inferSelect,
  parent: CollaborationRun | null
) {
  const db = await database();
  const id = randomUUID();
  await db
    .insert(collaborationRuns)
    .values({
      id,
      kind: "recipient",
      taskType: request.taskType,
      requestId: request.id,
      adoptId: request.targetAdoptId,
      userId: request.targetUserId,
      objective: request.taskSummary || "协作请求",
      parentRunId: parent?.id,
      budgetRootId: parent?.budgetRootId || id,
      depth: (parent?.depth ?? -1) + 1,
      deadline: parent?.deadline || new Date(Date.now() + 24 * 3_600_000),
    })
    .onDuplicateKeyUpdate({ set: { requestId: request.id } });
}
export async function claimCollaborationRun(id: string) {
  const token = randomUUID();
  const db = await database();
  const [result] = await db
    .update(collaborationRuns)
    .set({
      status: "running",
      leaseToken: leaseHash(token),
      leaseUntil: new Date(Date.now() + 5 * 60_000),
      turn: sql`${collaborationRuns.turn}+1`,
      wakeRequested: false,
    })
    .where(
      and(
        eq(collaborationRuns.id, id),
        gt(collaborationRuns.deadline, new Date()),
        lt(collaborationRuns.turn, 24),
        or(
          eq(collaborationRuns.status, "ready"),
          and(
            eq(collaborationRuns.status, "running"),
            lt(collaborationRuns.leaseUntil, new Date())
          )
        )
      )
    );
  return result.affectedRows
    ? { run: (await getCollaborationRun(id))!, token }
    : null;
}
export async function validateCollaborationLease(
  id: string,
  token: string
): Promise<CollaborationRun> {
  const run = await getCollaborationRun(id);
  const digest = leaseHash(token);
  if (
    !run ||
    run.status !== "running" ||
    !run.leaseToken ||
    !run.leaseUntil ||
    run.leaseUntil.getTime() <= Date.now() ||
    run.deadline.getTime() <= Date.now() ||
    !timingSafeEqual(Buffer.from(run.leaseToken), Buffer.from(digest))
  )
    throw new Error("协作执行上下文已失效");
  return run;
}
export async function finishCollaborationTurn(
  id: string,
  token: string,
  input: {
    status: "waiting" | "waiting_user" | "completed" | "failed";
    publicMessage?: string;
    checkpoint?: string;
  }
) {
  const [result] = await (
    await database()
  )
    .update(collaborationRuns)
    .set({
      ...input,
      status:
        input.status === "completed" || input.status === "failed"
          ? input.status
          : sql`IF(${collaborationRuns.wakeRequested}, 'ready', ${input.status})`,
      leaseToken: null,
      leaseUntil: null,
    })
    .where(
      and(
        eq(collaborationRuns.id, id),
        eq(collaborationRuns.leaseToken, leaseHash(token)),
        eq(collaborationRuns.status, "running"),
        gt(collaborationRuns.leaseUntil, new Date())
      )
    );
  return result.affectedRows === 1;
}
export async function notifyCollaborationResource(
  runId: string,
  kind: typeof collaborationWaits.$inferInsert.resourceKind,
  resourceId: string,
  state: string
) {
  const db = await database();
  await db.transaction(async tx => {
    const [updated] = await tx
      .update(collaborationWaits)
      .set({ observedState: state })
      .where(
        and(
          eq(collaborationWaits.runId, runId),
          eq(collaborationWaits.resourceKind, kind),
          eq(collaborationWaits.resourceId, resourceId),
          sql`${collaborationWaits.observedState} <> ${state}`
        )
      );
    if (updated.affectedRows)
      await tx
        .update(collaborationRuns)
        .set({
          wakeRequested: true,
          status: sql`IF(${collaborationRuns.status}='running','running','ready')`,
          // TIMESTAMP(0) may round JS milliseconds into the next second.
          // A result wake is runnable now, not a delayed retry.
          availableAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(
          and(
            eq(collaborationRuns.id, runId),
            inArray(collaborationRuns.status, [...active])
          )
        );
  });
}
export async function cancelCollaborationRun(
  userId: number,
  id: string,
  adoptId: string
) {
  return (await database()).transaction(async tx => {
    const [result] = await tx
      .update(collaborationRuns)
      .set({ status: "cancelled", leaseToken: null, leaseUntil: null })
      .where(
        and(
          eq(collaborationRuns.id, id),
          eq(collaborationRuns.userId, userId),
          eq(collaborationRuns.adoptId, adoptId),
          eq(collaborationRuns.kind, "goal"),
          inArray(collaborationRuns.status, [...active])
        )
      );
    if (!result.affectedRows) return false;
    const runs = await tx
      .select({ id: collaborationRuns.id })
      .from(collaborationRuns)
      .where(eq(collaborationRuns.budgetRootId, id));
    const waits = await tx
      .select({ id: collaborationWaits.resourceId })
      .from(collaborationWaits)
      .where(
        and(
          inArray(
            collaborationWaits.runId,
            runs.map(run => run.id)
          ),
          eq(collaborationWaits.resourceKind, "request")
        )
      );
    if (waits.length)
      await tx
        .update(clawCollabRequests)
        .set({ status: "cancelled", completedAt: new Date() })
        .where(
          and(
            inArray(
              clawCollabRequests.id,
              waits.map(wait => Number(wait.id))
            ),
            isNull(clawCollabRequests.sessionId),
            inArray(clawCollabRequests.status, [
              "pending",
              "approved",
              "running",
            ])
          )
        );
    await tx
      .update(collaborationRuns)
      .set({ status: "cancelled", leaseToken: null, leaseUntil: null })
      .where(
        and(
          eq(collaborationRuns.budgetRootId, id),
          inArray(collaborationRuns.status, [...active])
        )
      );
    // Calendar drafts and successful receipts are intentionally retained. Each
    // owner must separately decide whether to cancel/compensate their changes.
    return true;
  });
}
export async function saveCollaborationCheckpoint(
  id: string,
  token: string,
  checkpoint: string,
  publicMessage: string
) {
  const [result] = await (
    await database()
  )
    .update(collaborationRuns)
    .set({ checkpoint, publicMessage })
    .where(
      and(
        eq(collaborationRuns.id, id),
        eq(collaborationRuns.leaseToken, leaseHash(token)),
        eq(collaborationRuns.status, "running"),
        gt(collaborationRuns.leaseUntil, new Date())
      )
    );
  if (!result.affectedRows) throw new Error("协作执行状态已变化");
}
export async function deferCollaborationRun(
  run: CollaborationRun,
  token: string
) {
  await (
    await database()
  )
    .update(collaborationRuns)
    .set({
      status: "ready",
      leaseToken: null,
      leaseUntil: null,
      availableAt: new Date(
        Date.now() + Math.min(300_000, 15_000 * Math.max(1, run.turn))
      ),
      publicMessage: "运行连接未完成，已保留请求和草稿，正在等待恢复。",
    })
    .where(
      and(
        eq(collaborationRuns.id, run.id),
        eq(collaborationRuns.leaseToken, leaseHash(token)),
        eq(collaborationRuns.status, "running")
      )
    );
}
export async function bindCollaborationAuthority(
  id: string,
  snapshotId: string
) {
  await (
    await database()
  )
    .update(collaborationRuns)
    .set({ authorizationSnapshotId: snapshotId })
    .where(
      and(
        eq(collaborationRuns.id, id),
        isNull(collaborationRuns.authorizationSnapshotId)
      )
    );
}
export async function resumeCollaborationGoal(
  userId: number,
  adoptId: string,
  id: string,
  instruction: string
) {
  const [result] = await (
    await database()
  )
    .update(collaborationRuns)
    .set({
      status: "ready",
      turn: 0,
      requestCount: 0,
      availableAt: sql`CURRENT_TIMESTAMP`,
      deadline: new Date(Date.now() + 24 * 3_600_000),
      checkpoint: sql`RIGHT(CONCAT(COALESCE(${collaborationRuns.checkpoint}, ''), '\n本人补充：', ${instruction}), 12000)`,
      leaseToken: null,
      leaseUntil: null,
    })
    .where(
      and(
        eq(collaborationRuns.id, id),
        eq(collaborationRuns.userId, userId),
        eq(collaborationRuns.adoptId, adoptId),
        eq(collaborationRuns.kind, "goal"),
        inArray(collaborationRuns.status, ["waiting", "waiting_user", "failed"])
      )
    );
  if (!result.affectedRows)
    throw new Error("目标正在执行、已完成或不属于当前助手");
}
