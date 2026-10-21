import { assertCoopMember } from "../../db/coop-identity";
import { z } from "zod";
import type { CollaborationRun } from "../../../drizzle/schema";
import {
  createCollaborationGoal,
  finishCollaborationTurn,
  getCollaborationRun,
  watchCollaborationResource,
} from "../../db/collaboration-runs";
import { readSessionRegistry } from "../helpers";
import {
  collaborationResource,
  collaborationWaitingResources,
  assertCollaborationReadyToAnswer,
} from "./resources";
import { recordAuditRequired } from "../audit-events";
import { getClawByAdoptId } from "../../db";

export const COLLABORATION_GOAL_TOOLS = [
  {
    name: "get_collaboration_goal",
    description:
      "Read this conversation's own delegated goal status and released progress. Use the goalId returned by start_collaboration_goal before reporting progress or proposing duplicate work. It never exposes other assistants' internal exchanges or checkpoints.",
    inputSchema: {
      type: "object",
      properties: { goalId: { type: "string", format: "uuid" } },
      required: ["goalId"],
      additionalProperties: false,
    },
  },
  {
    name: "start_collaboration_goal",
    description:
      "Delegate the current owner's overall goal to durable background execution. This is NOT a collaboration exchange. Include the full objective and relevant constraints, not private history. expectedEffect calendar_write requires verified owner-confirmed writes. After success, acknowledge the delegation in the originating chat; do not duplicate its requests or drafts. Continuation is automatic on released results and confirmed calendar receipts.",
    inputSchema: {
      type: "object",
      properties: {
        requestKey: { type: "string", format: "uuid" },
        objective: { type: "string", maxLength: 4000 },
        taskType: { type: "string", enum: ["scheduling"] },
        expectedEffect: { type: "string", enum: ["read", "calendar_write"] },
      },
      required: ["requestKey", "objective", "taskType", "expectedEffect"],
      additionalProperties: false,
    },
  },
  {
    name: "checkpoint_collaboration_goal",
    description:
      "Save the current isolated execution's own progress, remaining constraints, next action and resource references. This does not complete a goal or a request. Do not store another assistant's private history. Waiting for children releases execution capacity and resumes on their replies.",
    inputSchema: {
      type: "object",
      properties: {
        checkpoint: { type: "string", maxLength: 6000 },
        message: { type: "string", maxLength: 2000 },
      },
      required: ["checkpoint", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "finish_collaboration_goal",
    description:
      "Complete the current owner's overall goal explicitly, after checking all constraints. A completed exchange alone never completes an arrangement. Calendar-write goals require completed owner-bound execution evidence; drafts or free/busy replies are insufficient. This cannot complete another person's goal or bypass confirmations.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", maxLength: 2000, description: "The actual reply shown directly to the user in their original conversation. Address the user naturally with the result. Do not write an internal execution report, raw JSON fields, or claim a separate reply has already been sent." },
        evidence: {
          type: "array",
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["draft", "meeting", "reschedule", "cascade"],
              },
              id: { type: "string", format: "uuid" },
            },
            required: ["kind", "id"],
            additionalProperties: false,
          },
        },
      },
      required: ["message", "evidence"],
      additionalProperties: false,
    },
  },
] as const;
export type CollaborationToolContext = {
  sessionId?: string;
  run?: CollaborationRun;
  leaseToken?: string;
  authorizationSnapshotId?: string;
};
const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
export function conversationForRuntime(adoptId: string, sessionId: string) {
  for (const [key, record] of Object.entries(readSessionRegistry())) {
    if (key.startsWith(`${adoptId}:`) && record?.sessionKey === sessionId) {
      const marker = key.indexOf(":web:");
      if (marker >= 0) return key.slice(marker + 5);
    }
  }
  return null;
}
export async function handleCollaborationGoalTool(
  userId: number,
  adoptId: string,
  name: string,
  args: Record<string, unknown>,
  context: CollaborationToolContext
) {
  const owner = await getClawByAdoptId(adoptId);
  if (
    !owner ||
    owner.userId !== userId ||
    owner.permissionProfile === "starter" ||
    !["active", "expiring"].includes(owner.status)
  )
    throw new Error("当前智能体没有协作权限");
  if (name === "get_collaboration_goal") {
    const { goalId } = z
      .object({ goalId: z.string().uuid() })
      .strict()
      .parse(args);
    const goal = await getCollaborationRun(goalId);
    const conversation = context.sessionId
      ? conversationForRuntime(adoptId, context.sessionId)
      : null;
    if (
      !goal ||
      goal.kind !== "goal" ||
      goal.userId !== userId ||
      goal.adoptId !== adoptId ||
      (context.run
        ? context.run.id !== goal.id
        : !context.sessionId ||
          (goal.sourceSessionId !== context.sessionId &&
            (!conversation || conversation !== goal.sourceConversationId)))
    )
      throw new Error("只能查询本人当前会话的协作目标");
    return text({
      goalId: goal.id,
      status: goal.status,
      objective: goal.objective,
      message: goal.publicMessage || "",
      updatedAt: goal.updatedAt,
      confirmation: { kind: "goal", placement: "conversation" },
    });
  }
  if (name === "start_collaboration_goal") {
    await assertCoopMember(userId);
    if (context.run || !context.sessionId)
      throw new Error("必须从本人已验证的原始会话发起目标");
    if (
      !Object.entries(readSessionRegistry()).some(
        ([key, record]) =>
          key.startsWith(`${adoptId}:`) &&
          record?.sessionKey === context.sessionId
      )
    )
      throw new Error("只能从本人已注册的原始会话发起目标");
    const input = z
      .object({
        requestKey: z.string().uuid(),
        objective: z.string().trim().min(1).max(4000),
        taskType: z.literal("scheduling"),
        expectedEffect: z.enum(["read", "calendar_write"]),
      })
      .strict()
      .parse(args);
    if (
      input.expectedEffect === "calendar_write" &&
      input.taskType !== "scheduling"
    )
      throw new Error("日历写入目标需要 scheduling 权限范围");
    const sourceConversationId = conversationForRuntime(
      adoptId,
      context.sessionId
    );
    await recordAuditRequired({
      action: "collaboration.goal.requested",
      actorType: "agent",
      actorUserId: userId,
      targetType: "claw_adoption",
      targetId: adoptId,
      metadata: {
        requestKey: input.requestKey,
        taskType: input.taskType,
        expectedEffect: input.expectedEffect,
      },
    });
    const run = await createCollaborationGoal({
      ...input,
      userId,
      adoptId,
      sourceSessionId: context.sessionId,
      sourceConversationId,
      authorizationSnapshotId: context.authorizationSnapshotId,
    });
    return text({
      goalId: run.id,
      status: run.status,
      note: "目标已保存；一次沟通的完成不代表整个目标完成",
    });
  }
  const run = context.run;
  if (
    !run ||
    !context.leaseToken ||
    run.userId !== userId ||
    run.adoptId !== adoptId
  )
    throw new Error("缺少受限目标执行上下文");
  if (name === "checkpoint_collaboration_goal") {
    const input = z
      .object({
        checkpoint: z.string().max(6000),
        message: z.string().max(2000),
      })
      .strict()
      .parse(args);
    const { saveCollaborationCheckpoint } = await import(
      "../../db/collaboration-runs"
    );
    await saveCollaborationCheckpoint(
      run.id,
      context.leaseToken,
      input.checkpoint,
      input.message
    );
    const waiting = (await collaborationWaitingResources(run)).some(
      resource => !resource.terminal
    );
    if (
      waiting &&
      !(await finishCollaborationTurn(run.id, context.leaseToken, {
        status: "waiting",
        publicMessage: input.message,
      }))
    )
      throw new Error("目标执行状态已变化");
    return text({ saved: true, waiting });
  }
  if (name === "finish_collaboration_goal") {
    if (run.kind !== "goal") throw new Error("接收方不能结束发起方的目标");
    const input = z
      .object({
        message: z.string().min(1).max(2000),
        evidence: z
          .array(
            z
              .object({
                kind: z.enum(["draft", "meeting", "reschedule", "cascade"]),
                id: z.string().uuid(),
              })
              .strict()
          )
          .max(12),
      })
      .strict()
      .parse(args);
    if (run.expectedEffect === "calendar_write" && !input.evidence.length)
      throw new Error("缺少实际写入成功凭据，不能将草稿或协作回复当作安排完成");
    await assertCollaborationReadyToAnswer(run);
    const watched = await collaborationWaitingResources(run);
    if (
      run.expectedEffect === "calendar_write" &&
      watched.some(
        wait =>
          wait.resourceKind === "cascade" &&
          ["partial", "failed", "compensating", "compensated"].includes(
            wait.state
          )
      )
    )
      throw new Error(
        "关联调整尚未全部成功，不能将部分完成或恢复原安排报告为目标完成"
      );
    for (const evidence of input.evidence) {
      if (
        !watched.some(
          wait =>
            wait.resourceKind === evidence.kind &&
            wait.resourceId === evidence.id
        )
      )
        throw new Error("不能使用本目标之外的历史回执作为完成依据");
      if (
        !(await collaborationResource(run, evidence.kind, evidence.id))
          .completed
      )
        throw new Error("写入尚未完成、已取消或不属于本人");
      await watchCollaborationResource(run.id, evidence.kind, evidence.id);
    }
    await recordAuditRequired({
      action: "collaboration.goal.completion.confirmed",
      actorType: "agent",
      actorUserId: userId,
      targetType: "collaboration_run",
      targetId: run.id,
      metadata: { evidence: input.evidence },
    });
    if (
      !(await finishCollaborationTurn(run.id, context.leaseToken, {
        status: "completed",
        publicMessage: input.message,
      }))
    )
      throw new Error("目标执行状态已变化");
    return text({ completed: true });
  }
  throw new Error("Unknown collaboration goal tool");
}
