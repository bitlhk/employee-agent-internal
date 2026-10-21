import type { ClawCollabRequest } from "../../../drizzle/schema";
import { getCollabSettings } from "../../db/collab";
import { getCalendarBinding } from "../../db/scheduling";
import { CollaborationAuthorityRevoked } from "./authority";
import { collaborationSettingsForTask } from "../../../shared/scheduling-collaboration-policy";
export async function assertAutomaticCollaborationConsent(
  request: ClawCollabRequest,
  adoptionId: number
) {
  if (
    request.taskType !== "scheduling" ||
    request.approvalMode !== "auto" ||
    request.approvedBy != null
  )
    return;
  const [settings, binding] = await Promise.all([
    getCollabSettings(adoptionId).then(settings => collaborationSettingsForTask(settings, request.taskType)),
    getCalendarBinding(request.targetUserId),
  ]);
  let allowed: unknown = [];
  try {
    allowed = JSON.parse(settings?.allowedTaskTypes || "[]");
  } catch {
    /* Malformed grants fail closed. */
  }
  if (
    settings?.acceptTask !== "auto" ||
    !Array.isArray(allowed) ||
    !allowed.includes("scheduling") ||
    !binding?.enabled ||
    !binding.autoAvailability
  )
    throw new CollaborationAuthorityRevoked(
      "自动日程回复授权已撤销，需要本人重新批准"
    );
}
