import type { Request } from "express";
import { getCollabRequest, getClawByAdoptId } from "../../db";
import {
  runSessionId,
  validateCollaborationLease,
} from "../../db/collaboration-runs";
import type { CollaborationRun } from "../../../drizzle/schema";
import { assertAutomaticCollaborationConsent } from "./consent";
import {
  assertCollaborationAuthority,
  CollaborationAuthorityRevoked,
} from "./authority";
import {
  assertCollaborationReadyToAnswer,
  collaborationWaitingResources,
} from "./resources";

const common = [
  "search_collaboration_people",
  "send_collaboration_request",
  "cancel_collaboration_request",
  "get_collaboration_result",
  "get_collaboration_goal",
  "reply_collaboration_request",
  "checkpoint_collaboration_goal",
  "finish_collaboration_goal",
];
const calendar = [
  "query_own_schedules",
  "recommend_own_candidates",
  "search_scheduling_people",
  "prepare_personal_schedule_write",
  "prepare_meeting_invitation",
  "list_meeting_invitations",
  "prepare_meeting_reschedule",
  "prepare_schedule_cascade",
  "list_schedule_cascades",
];
export const collaborationScopeTools = (taskType: string) =>
  new Set([...common, ...(taskType === "scheduling" ? calendar : [])]);
const header = (req: Request, name: string) =>
  String(req.headers[name] || "").trim();

export async function validateScopedTool(
  run: CollaborationRun,
  name: string,
  args: Record<string, unknown>
) {
  await assertCollaborationAuthority(run);
  if (!collaborationScopeTools(run.taskType).has(name))
    throw new Error("本次协作未授权该工具");
  if (run.kind === "goal" && run.requestKey?.startsWith("reply:") &&
    !["get_collaboration_result", "get_collaboration_goal", "checkpoint_collaboration_goal", "finish_collaboration_goal"].includes(name))
    throw new Error("本次续办仅用于回告协作结果，不能新增询问或日历操作");
  const owner = await getClawByAdoptId(run.adoptId);
  if (
    !owner ||
    owner.userId !== run.userId ||
    owner.permissionProfile === "starter" ||
    !["active", "expiring"].includes(owner.status)
  )
    throw new Error("协作主体授权已变化");
  if (run.requestId) {
    const request = await getCollabRequest(run.requestId);
    if (
      !request ||
      request.targetAdoptId !== run.adoptId ||
      request.targetUserId !== run.userId ||
      !["approved", "running"].includes(request.status)
    )
      throw new CollaborationAuthorityRevoked("协作请求已撤销或已完成");
    await assertAutomaticCollaborationConsent(request, owner.id);
  }
  if (
    name === "reply_collaboration_request" &&
    (!run.requestId || args.requestId !== run.requestId)
  )
    throw new Error("只能答复当前协作请求");
  if (
    name === "reply_collaboration_request" ||
    name === "finish_collaboration_goal"
  )
    await assertCollaborationReadyToAnswer(run);
  if (
    name.startsWith("prepare_") &&
    (await collaborationWaitingResources(run)).some(resource =>
      ["unknown", "executing", "creating", "verify_required"].includes(
        resource.state
      )
    )
  )
    throw new Error(
      "已有写入结果尚未核实，请保留原操作等待核对，不能重复准备写入"
    );
  if (name === "send_collaboration_request" && args.taskType !== run.taskType)
    throw new Error("不能通过下游协作扩大任务范围");
  if (name === "finish_collaboration_goal" && run.kind !== "goal")
    throw new Error("接收方应答复本次请求，不能代替发起人结束目标");
}
export async function scopedCollaborationForRequest(req: Request) {
  const id = header(req, "x-ea-collaboration-run-id");
  const sessionId =
    header(req, "x-linggan-session-id") || header(req, "x-jiuwen-session-id");
  if (!id) {
    if (sessionId.startsWith("ea_collab_"))
      throw new Error("缺少受限协作执行凭据");
    return null;
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("协作会话绑定不匹配");
  const run = await validateCollaborationLease(
    id,
    header(req, "x-ea-collaboration-capability")
  );
  if (sessionId !== runSessionId(id, run.turn))
    throw new Error("协作会话绑定不匹配");
  if (header(req, "x-jiuwen-channel-id") !== run.adoptId)
    throw new Error("协作主体不匹配");
  return run;
}
