import { canCollaborate } from "../../db/coop-identity";
import { collaborationSettingsForTask } from "../../../shared/scheduling-collaboration-policy";
import {
  getCollabRequest,
  getClawByAdoptId,
  getCollabSettings,
} from "../../db";
import { getCalendarDraft } from "../../db/calendar-drafts";
import { getMeeting } from "../../db/calendar-meetings";
import { getReschedule } from "../../db/calendar-reschedules";
import { getCascade } from "../../db/calendar-cascades";
import { projectCollaborationConclusion } from "./result-projection";
import type { CollaborationRun } from "../../../drizzle/schema";
import { getCoordination } from "../../db/calendar-coordination";
import { getCoordinationView } from "../scheduling/coordination-service";
import { collaborationWaits } from "../../../drizzle/schema";
import { getDb } from "../../db/connection";
import { eq } from "drizzle-orm";
import { CollaborationAwaitingResources } from "./errors";
export type ResourceKind =
  | "request"
  | "draft"
  | "meeting"
  | "reschedule"
  | "cascade"
  | "coordination";
function calendarState(
  row: { status: string; expiresAt: Date } | null | undefined,
  successful: string[],
  terminal: string[]
) {
  if (!row) return { state: "unavailable", terminal: true, completed: false };
  if (successful.includes(row.status))
    return { state: row.status, terminal: true, completed: true };
  if (terminal.includes(row.status))
    return { state: row.status, terminal: true, completed: false };
  if (row.expiresAt.getTime() <= Date.now())
    return {
      state: [
        "unknown",
        "executing",
        "creating",
        "waiting",
        "running",
        "compensating",
      ].includes(row.status)
        ? "verify_required"
        : "expired",
      terminal: true,
      completed: false,
    };
  return { state: row.status, terminal: false, completed: false };
}

export async function collaborationResource(
  run: CollaborationRun,
  kind: ResourceKind,
  id: string
) {
  if (kind === "coordination") {
    const row = await getCoordination(id);
    if (!row || row.creatorUserId !== run.userId)
      return { state: "unavailable", terminal: true, completed: false };
    if (row.expiresAt.getTime() <= Date.now())
      return { state: "expired", terminal: true, completed: false };
    const view = await getCoordinationView(run.userId, id);
    return {
      state: view.status,
      terminal: view.status !== "collecting",
      completed: false,
      commonIndices: view.commonIndices,
    };
  }
  if (kind === "request") {
    const request = await getCollabRequest(Number(id));
    if (
      !request ||
      request.requesterAdoptId !== run.adoptId ||
      request.requesterUserId !== run.userId
    )
      return { state: "unavailable", terminal: true, completed: false };
    if (request.taskType === "scheduling" && !(await canCollaborate(request.requesterUserId, request.targetUserId)).ok) return { state: "unavailable", terminal: true, completed: false };
    const terminal = [
      "completed",
      "failed",
      "cancelled",
      "rejected",
      "partial_success",
      "waiting_input",
    ].includes(request.status);
    const target = await getClawByAdoptId(request.targetAdoptId);
    const sharing =
      target && target.userId === request.targetUserId
        ? await getCollabSettings(target.id)
        : null;
    let result: { shared: boolean; summary: string; expired?: boolean } =
      target?.userId === request.targetUserId
        ? projectCollaborationConclusion(
            request,
            collaborationSettingsForTask(sharing, request.taskType)?.sharingPolicy === "result-only"
          )
        : { shared: false, summary: "" };
    if (request.taskType === "scheduling" && request.status === "completed" && result.shared && result.summary) {
      try {
        if (
          Date.parse(JSON.parse(result.summary).validUntil) <= Date.now() ||
          !Number.isFinite(Date.parse(JSON.parse(result.summary).validUntil))
        )
          result = { shared: true, summary: "结论已过期，需要重新询问", expired: true };
      } catch {
        result = { shared: true, summary: "忙闲结论未知，需要重新询问" };
      }
    }
    return {
      state: request.status,
      terminal,
      completed: request.status === "completed",
      result: terminal ? result : undefined,
    };
  }
  if (kind === "draft")
    return calendarState(
      await getCalendarDraft(run.userId, id),
      ["completed"],
      ["cancelled", "failed"]
    );
  if (kind === "reschedule")
    return calendarState(
      await getReschedule(run.userId, id),
      ["completed"],
      ["cancelled"]
    );
  if (kind === "cascade")
    return calendarState(
      await getCascade(run.userId, id),
      ["completed"],
      ["partial", "compensated", "cancelled", "failed"]
    );
  const row = await getMeeting(id);
  if (!row || row.creatorUserId !== run.userId)
    return { state: "unavailable", terminal: true, completed: false };
  return calendarState(row, ["invited"], ["cancelled"]);
}
export async function collaborationWaitingResources(run: CollaborationRun) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const waits = await db
    .select()
    .from(collaborationWaits)
    .where(eq(collaborationWaits.runId, run.id));
  return Promise.all(
    waits.map(async wait => ({
      ...wait,
      ...(await collaborationResource(run, wait.resourceKind, wait.resourceId)),
    }))
  );
}
export async function assertCollaborationReadyToAnswer(run: CollaborationRun) {
  if (
    (await collaborationWaitingResources(run)).some(
      resource => !resource.terminal || resource.state === "verify_required"
    )
  )
    throw new CollaborationAwaitingResources();
}
