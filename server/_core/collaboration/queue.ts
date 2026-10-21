import { and, eq } from "drizzle-orm";
import {
  collaborationWaits,
  type ClawCollabRequest,
} from "../../../drizzle/schema";
import { getDb } from "../../db/connection";
import {
  ensureRecipientRun,
  getCollaborationRun,
} from "../../db/collaboration-runs";
export async function queueApprovedCollaboration(request: ClawCollabRequest) {
  if (
    request.sessionId ||
    request.taskType !== "scheduling" ||
    !request.requestKey ||
    !["approved", "running"].includes(request.status)
  )
    throw new Error("仅支持已批准的独立协作请求");
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [wait] = await db
    .select()
    .from(collaborationWaits)
    .where(
      and(
        eq(collaborationWaits.resourceKind, "request"),
        eq(collaborationWaits.resourceId, String(request.id))
      )
    )
    .limit(1);
  await ensureRecipientRun(
    request,
    wait ? await getCollaborationRun(wait.runId) : null
  );
}
