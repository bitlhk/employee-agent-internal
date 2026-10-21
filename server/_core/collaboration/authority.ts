import { assertCoopParticipants, assertCoopMember } from "../../db/coop-identity";
import type { CollaborationRun } from "../../../drizzle/schema";
import { getClawByAdoptId, getCollabRequest } from "../../db";
import {
  bindCollaborationAuthority,
  getCollaborationRun,
  runSessionId,
} from "../../db/collaboration-runs";
import { authorizeClawRouteExecution } from "../governance/claw-route-execution-authority";
export class CollaborationAuthorityRevoked extends Error {}
export async function assertCollaborationAuthority(
  run: CollaborationRun,
  capture = false
) {
  const owner = await getClawByAdoptId(run.adoptId);
  if (
    !owner ||
    owner.userId !== run.userId ||
    owner.permissionProfile === "starter" ||
    !["active", "expiring"].includes(owner.status)
  )
    throw new CollaborationAuthorityRevoked("协作主体授权已失效");
  if (run.taskType === "scheduling") {
    try {
      await assertCoopMember(run.userId);
      if (run.requestId) {
        const request = await getCollabRequest(run.requestId);
        if (!request) throw new Error("协作请求不存在");
        await assertCoopParticipants(request.requesterUserId, [request.targetUserId]);
      }
    } catch (error) { throw new CollaborationAuthorityRevoked(error instanceof Error ? error.message : "组织权限已失效"); }
  }
  if (!run.authorizationSnapshotId && !capture)
    throw new CollaborationAuthorityRevoked("缺少协作任务授权快照");
  const result = await authorizeClawRouteExecution({
    claw: owner,
    source: "collaboration.runtime",
    taskAuthorizationSnapshotId: run.authorizationSnapshotId,
    sessionId: runSessionId(run.id, run.turn),
    operation: {
      capabilityId: "platform.mcp",
      operation: "collaboration.execute",
      sideEffect: "read",
      resource: `collaboration:${run.id}`,
    },
  });
  if (!result.allowed || !result.taskSnapshotId)
    throw new CollaborationAuthorityRevoked(
      result.reason || "协作执行授权已变化"
    );
  if (!run.authorizationSnapshotId) {
    await bindCollaborationAuthority(run.id, result.taskSnapshotId);
    run.authorizationSnapshotId = (await getCollaborationRun(
      run.id
    ))!.authorizationSnapshotId;
    if (run.authorizationSnapshotId !== result.taskSnapshotId)
      return assertCollaborationAuthority(run, false);
  }
  if (run.budgetRootId !== run.id) {
    const root = await getCollaborationRun(run.budgetRootId);
    if (!root || ["cancelled", "completed", "failed"].includes(root.status))
      throw new CollaborationAuthorityRevoked(
        "上游目标已结束，本次协作不能继续扩展"
      );
  }
  let parentId = run.parentRunId;
  for (let depth = 0; parentId && depth < 6; depth++) {
    const parent = await getCollaborationRun(parentId);
    const request = parent?.requestId
      ? await getCollabRequest(parent.requestId)
      : null;
    if (
      !parent ||
      ["cancelled", "completed", "failed"].includes(parent.status) ||
      (parent.requestId &&
        (!request ||
          ["cancelled", "completed", "failed", "rejected"].includes(
            request.status
          )))
    )
      throw new CollaborationAuthorityRevoked(
        "上游询问已结束，不能继续其后续协作"
      );
    parentId = parent.parentRunId;
  }
}
