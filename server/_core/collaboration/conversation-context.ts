import { createHash, createHmac } from "node:crypto";
import { and, eq, gt, isNull, inArray } from "drizzle-orm";
import {
  collaborationRuns,
  clawCollabRequests,
  clawAdoptions,
  calendarAvailabilityTasks,
  calendarCoordinations,
} from "../../../drizzle/schema";
import { getDb } from "../../db/connection";
import { getClawByAdoptId } from "../../db";
import { buildJiuwenAgentId, buildJiuwenSessionId } from "../jiuwenclaw-bridge";
import { readSessionRegistry } from "../helpers";
import { collaborationRuntimeCommand } from "./runtime-readiness";
import { canCollaborate } from "../../db/coop-identity";
import { getCollabSettings } from "../../db/collab";
import { collaborationSettingsForTask } from "../../../shared/scheduling-collaboration-policy";
import { projectCollaborationConclusion } from "./result-projection";
import { requestConversationContinuation } from "../../db/collaboration-runs";

export type ConversationAction = {
  kind:
    | "draft"
    | "meeting"
    | "reschedule"
    | "cascade"
    | "goal"
    | "request"
    | "availability"
    | "coordination";
  id: string;
  adoptId?: string;
};
const delivered = new Set<string>();
export async function appendConversationContext(input: {
  adoptId: string;
  userId: number;
  sessionId?: string | null;
  resource: string;
  content: string;
  timestamp: Date;
  actions?: ConversationAction[];
  presentation?: "context-only";
}) {
  const owner = await getClawByAdoptId(input.adoptId);
  if (
    !owner ||
    owner.userId !== input.userId ||
    !["active", "expiring"].includes(owner.status)
  )
    return;
  const agentId = buildJiuwenAgentId(owner);
  const sessionId =
    input.sessionId ||
    buildJiuwenSessionId(owner, agentId, {
      channel: "web",
      conversationId: "calendar",
    });
  if (
    input.sessionId &&
    !Object.entries(readSessionRegistry()).some(
      ([key, value]) =>
        key.startsWith(`${input.adoptId}:`) && value?.sessionKey === sessionId
    )
  )
    return;
  const context = { resource: input.resource, actions: input.actions || [], ...(input.presentation ? { presentation: input.presentation } : {}) };
  const messageId = `ea-context-${createHash("sha256")
    .update(JSON.stringify([input.adoptId, sessionId, context, input.content]))
    .digest("hex")}`;
  if (delivered.has(messageId)) return;
  const secret = process.env.INTERNAL_RUNTIME_TOKEN_SECRET;
  if (!secret) throw new Error("运行服务的内部签名尚未配置");
  const payload = JSON.stringify({
    adoptId: input.adoptId,
    sessionId,
    messageId,
    content: input.content.slice(0, 12000),
    timestamp: input.timestamp.getTime() / 1000,
    issuedAt: Date.now() / 1000,
    context,
  });
  const result = await collaborationRuntimeCommand({
    action: "ea-conversation-append",
    ea_payload: payload,
    ea_signature: createHmac("sha256", secret).update(payload).digest("hex"),
  });
  if (result.persisted !== true) throw new Error("对话记录尚未写入");
  if (delivered.size >= 2000)
    delivered.delete(delivered.values().next().value!);
  delivered.add(messageId);
}

export async function appendWorkspaceContext(
  userId: number,
  resource: string,
  content: string,
  timestamp: Date,
  actions: ConversationAction[] = []
) {
  const db = await getDb();
  if (!db) return;
  const [owner] = await db
    .select()
    .from(clawAdoptions)
    .where(
      and(
        eq(clawAdoptions.userId, userId),
        eq(clawAdoptions.roleTemplate, "general-assistant"),
        inArray(clawAdoptions.status, ["active", "expiring"])
      )
    )
    .orderBy(clawAdoptions.id)
    .limit(1);
  // Do not replay work predating a newly created workspace assistant.
  if (owner && timestamp.getTime() >= owner.createdAt.getTime())
    await appendConversationContext({
      userId,
      adoptId: owner.adoptId,
      resource,
      content,
      timestamp,
      actions,
    });
}

// Reuse durable work records as retry sources. No notification/outbox table.
// Keyset scans keep old failures retryable without starving new work; the runtime
// transcript deduplicates after process restarts and after an acknowledgement loss.
let runCursor = "";
let requestCursor = 0;
let availabilityCursor = "";
export async function publishCollaborationContext() {
  const db = await getDb();
  if (!db) return;
  const runs = await db
    .select()
    .from(collaborationRuns)
    .where(
      and(
        gt(collaborationRuns.id, runCursor),
        inArray(collaborationRuns.status, [
          "waiting",
          "waiting_user",
          "completed",
          "failed",
          "cancelled",
        ])
      )
    )
    .orderBy(collaborationRuns.id)
    .limit(25);
  runCursor = runs.length === 25 ? runs[runs.length - 1].id : "";
  for (const run of runs) {
    try {
      if (!run.publicMessage) continue;
      await appendConversationContext({
        userId: run.userId,
        adoptId: run.adoptId,
        sessionId: run.kind === "goal" ? run.sourceSessionId : null,
        resource: `run:${run.id}`,
        content: run.publicMessage,
        timestamp: run.updatedAt,
        // The original goal/request card polls durable state. Keep intermediate
        // observations for model context without another visible chat message.
        presentation: run.kind !== "goal" || !["completed", "failed", "cancelled"].includes(run.status) ? "context-only" : undefined,
        actions: [],
      });
    } catch {
      /* Retry from the same durable run; never rerun a calendar write. */
    }
  }
  const requests = await db
    .select()
    .from(clawCollabRequests)
    .where(
      and(
        gt(clawCollabRequests.id, requestCursor),
        eq(clawCollabRequests.taskType, "scheduling"),
        isNull(clawCollabRequests.sessionId)
      )
    )
    .orderBy(clawCollabRequests.id)
    .limit(25);
  requestCursor = requests.length === 25 ? requests[requests.length - 1].id : 0;
  for (const request of requests) {
    try {
      if (
        !(await canCollaborate(request.requesterUserId, request.targetUserId))
          .ok
      )
        continue;
      const labels: Record<string, string> = {
        pending: "需要你批准或拒绝本次协作",
        approved: "已批准，等待处理",
        running: "正在处理",
        rejected: "已拒绝",
        completed: "已完成",
        failed: "处理失败",
        cancelled: "已取消",
        partial_success: "部分完成",
        waiting_input: "等待补充信息",
      };
      await appendConversationContext({
        userId: request.targetUserId,
        adoptId: request.targetAdoptId,
        resource: `request:${request.id}`,
        content: "收到一条组织内日程询问，处理进展见下方卡片。",
        timestamp: request.createdAt,
        actions: [
                {
                  kind: "request",
                  id: String(request.id),
                  adoptId: request.targetAdoptId,
                },
              ],
      });
      await appendConversationContext({ userId: request.targetUserId, adoptId: request.targetAdoptId, resource: `request:${request.id}`, content: `组织内的日程协作请求：${request.taskSummary}\n${labels[request.status]}。`, timestamp: request.updatedAt, presentation: "context-only" });
      if (
        [
          "completed",
          "partial_success",
          "waiting_input",
          "rejected",
          "failed",
          "cancelled",
        ].includes(request.status)
      ) {
        // The existing goal worker replies in the originating conversation.
        if (await requestConversationContinuation(request.id)) continue;
        const target = await getClawByAdoptId(request.targetAdoptId);
        if (target?.userId !== request.targetUserId) continue;
        const settings = collaborationSettingsForTask(
          await getCollabSettings(target.id),
          request.taskType
        );
        const result = projectCollaborationConclusion(
          request,
          settings?.sharingPolicy === "result-only"
        );
        await appendConversationContext({
          userId: request.requesterUserId,
          adoptId: request.requesterAdoptId,
          resource: `request:${request.id}`,
          content: `你发出的日程协作请求${labels[request.status]}。${result.summary ? `\n${result.summary}` : ""}`,
          timestamp: request.updatedAt,
        });
      }
    } catch {
      /* The existing request remains the recovery source. */
    }
  }
  const tasks = await db
    .select({
      task: calendarAvailabilityTasks,
      coordination: calendarCoordinations,
    })
    .from(calendarAvailabilityTasks)
    .innerJoin(
      calendarCoordinations,
      eq(calendarAvailabilityTasks.coordinationId, calendarCoordinations.id)
    )
    .where(gt(calendarAvailabilityTasks.id, availabilityCursor))
    .orderBy(calendarAvailabilityTasks.id)
    .limit(25);
  availabilityCursor =
    tasks.length === 25 ? tasks[tasks.length - 1].task.id : "";
  for (const { task, coordination } of tasks) {
    try {
      if (
        task.targetUserId === coordination.creatorUserId ||
        !(await canCollaborate(coordination.creatorUserId, task.targetUserId))
          .ok
      )
        continue;
      const pending =
        task.status === "pending" &&
        coordination.status === "collecting" &&
        coordination.expiresAt > new Date();
      const content = pending
        ? "收到组织内的忙闲查询，需要你决定是否查询本人日历并回复。"
        : task.status === "replied"
          ? "组织内的忙闲查询已回复。"
          : task.status === "declined"
            ? "已拒绝本次组织内的忙闲查询。"
            : task.status === "running" &&
                coordination.status === "collecting" &&
                coordination.expiresAt > new Date()
              ? "正在处理组织内的忙闲查询。"
              : "本次组织内的忙闲查询已结束，无需再回复。";
      await appendWorkspaceContext(
        task.targetUserId,
        `availability:${task.id}`,
        content,
        task.updatedAt,
        pending ? [{ kind: "availability", id: task.id }] : []
      );
    } catch {
      /* The pending availability task remains retryable. */
    }
  }
}
