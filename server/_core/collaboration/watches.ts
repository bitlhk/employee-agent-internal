import { watchCollaborationResource } from "../../db/collaboration-runs";
import type { CollaborationRun } from "../../../drizzle/schema";
import type { ResourceKind } from "./resources";
export async function watchPreparedCollaborationResource(
  run: CollaborationRun,
  name: string,
  result: { content?: readonly { type: string; text?: string }[] }
) {
  const kinds: Record<string, ResourceKind> = {
    prepare_personal_schedule_write: "draft",
    prepare_meeting_invitation: "meeting",
    prepare_meeting_reschedule: "reschedule",
    prepare_schedule_cascade: "cascade",
    coordinate_meeting_times: "coordination",
  };
  const kind = kinds[name];
  if (!kind) return;
  const raw = result.content?.find(item => item.type === "text")?.text;
  if (!raw) throw new Error("未获得可恢复的草稿回执");
  const value = JSON.parse(raw);
  const id = value.draftId || value.meetingId || value.id;
  if (typeof id !== "string") throw new Error("草稿回执缺少编号");
  await watchCollaborationResource(run.id, kind, id);
}
