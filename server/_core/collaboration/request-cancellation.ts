import { and, eq, inArray, isNull } from "drizzle-orm";
import { clawCollabRequests } from "../../../drizzle/schema";
import { getDb } from "../../db/connection";
export async function cancelStandaloneCollaboration(
  userId: number,
  adoptId: string,
  requestId: number,
  recipient = false
) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [result] = await db
    .update(clawCollabRequests)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(
      and(
        eq(clawCollabRequests.id, requestId),
        eq(
          recipient
            ? clawCollabRequests.targetAdoptId
            : clawCollabRequests.requesterAdoptId,
          adoptId
        ),
        eq(
          recipient
            ? clawCollabRequests.targetUserId
            : clawCollabRequests.requesterUserId,
          userId
        ),
        isNull(clawCollabRequests.sessionId),
        inArray(clawCollabRequests.status, ["pending", "approved", "running"])
      )
    );
  if (!result.affectedRows)
    throw new Error("只能撤回本人仍在进行的独立协作请求");
  return { cancelled: true, calendarReverted: false };
}
