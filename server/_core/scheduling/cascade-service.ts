import { randomUUID } from "node:crypto";
import {
  cascadeInputSchema,
  topologicalSteps,
  type CascadeInput,
  type CascadeStep,
} from "../../../shared/scheduling-cascade";
import { meetingPayloadSchema } from "../../../shared/scheduling";
import { getMeeting } from "../../db/calendar-meetings";
import { getReschedule } from "../../db/calendar-reschedules";
import {
  claimCascade,
  confirmCascadeRecord,
  getCascade,
  insertCascade,
  stopCascadeRecord,
  updateCascade,
} from "../../db/calendar-cascades";
import { prepareReschedule, confirmReschedule } from "./reschedule-service";
import { stableToolInputHash } from "../tool-governance";
import { recordAuditRequired } from "../audit-events";
import { collaborationOperationId } from "../collaboration/operation-id";

const overlaps = (
  a: { start: string; end: string },
  b: { start: string; end: string }
) =>
  Date.parse(a.start) < Date.parse(b.end) &&
  Date.parse(a.end) > Date.parse(b.start);
export async function prepareCascade(userId: number, raw: CascadeInput) {
  const input = cascadeInputSchema.parse(raw);
  const inputHash = stableToolInputHash(input);
  if (
    new Set(input.steps.map(step => step.meetingId)).size !== input.steps.length
  )
    throw new Error("同一会议不能在同一方案中重复调整");
  const snapshots: CascadeStep[] = [];
  for (const step of input.steps) {
    const meeting = await getMeeting(step.meetingId);
    if (
      !meeting ||
      meeting.creatorUserId !== userId ||
      meeting.status !== "invited"
    )
      throw new Error("级联方案只能包含本人有权组织的已邀请会议");
    const previous = meetingPayloadSchema.parse(meeting.payload);
    snapshots.push({
      ...step,
      previous: previous.event,
      participants: [previous.organizer, ...previous.attendees].map(person => ({
        userId: person.userId,
        name: person.name,
      })),
      draftId: "",
      state: "pending",
    });
  }
  // Moving into another included meeting's old slot depends on moving it away.
  for (const step of snapshots)
    for (const other of snapshots) {
      if (
        step.key !== other.key &&
        overlaps(step.event.time, other.previous.time) &&
        !step.dependsOn.includes(other.key)
      )
        step.dependsOn.push(other.key);
      if (step.key !== other.key && overlaps(step.event.time, other.event.time))
        throw new Error("调整后的会议仍相互冲突，需要重新协商时间");
    }
  topologicalSteps(snapshots);
  const row = await insertCascade({
    id: randomUUID(),
    userId,
    requestKey: input.requestKey,
    title: input.title,
    inputHash,
    planHash: "preparing",
    steps: snapshots,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  if (row.inputHash !== inputHash)
    throw new Error("同一方案编号不能用于不同的调整");
  if (row.status !== "drafting") return publicCascade(row);
  const claim = await claimCascade(userId, row.id, true);
  if (!claim) throw new Error("方案正在准备，请使用同一编号重试");
  try {
    if (row.expiresAt.getTime() <= Date.now())
      throw new Error("方案已过期，请重新准备");
    for (const step of claim.plan.steps) {
      if (!step.draftId) {
        const draft = await prepareReschedule(
          userId,
          step.meetingId,
          step.event,
          row.id,
          collaborationOperationId(
            row.id,
            `cascade:${step.key}`,
            input.requestKey
          )
        );
        const stored = await getReschedule(userId, draft.draftId);
        if (
          !stored ||
          stableToolInputHash(
            meetingPayloadSchema.parse(stored.previous).event
          ) !== stableToolInputHash(step.previous)
        )
          throw new Error("原会议已变化，需要重新准备整个方案");
        step.draftId = draft.draftId;
        await updateCascade(userId, row.id, claim.token, {
          steps: claim.plan.steps,
        });
      }
    }
    const planHash = stableToolInputHash(
      claim.plan.steps.map(({ state: _state, ...step }) => step)
    );
    await recordAuditRequired({
      action: "calendar.cascade.prepared",
      actorType: "agent",
      actorUserId: userId,
      targetType: "calendar_cascade",
      targetId: row.id,
      metadata: { planHash },
    });
    const stopped = (await getCascade(userId, row.id))?.stopRequested;
    await updateCascade(
      userId,
      row.id,
      claim.token,
      { status: stopped ? "cancelled" : "pending", planHash },
      true
    );
    return publicCascade((await getCascade(userId, row.id))!);
  } catch (error) {
    await updateCascade(
      userId,
      row.id,
      claim.token,
      { status: "failed", errorCode: "PREPARE_FAILED" },
      true
    );
    throw error;
  }
}
export function publicCascade(
  plan: NonNullable<Awaited<ReturnType<typeof getCascade>>>
) {
  return {
    id: plan.id,
    title: plan.title,
    planHash: plan.planHash,
    status: plan.status,
    errorCode: plan.errorCode,
    expiresAt: plan.expiresAt,
    stopRequested: plan.stopRequested,
    steps: plan.steps.map(step => ({
      key: step.key,
      meetingId: step.meetingId,
      previous: step.previous,
      event: step.event,
      dependsOn: step.dependsOn,
      state: step.state,
      compensated: Boolean(step.compensated),
      participants: step.participants || [],
    })),
    confirmation: { kind: "cascade", placement: "conversation" },
  };
}
export async function confirmCascade(
  userId: number,
  id: string,
  hash: string,
  compensate = false
) {
  const plan = await getCascade(userId, id);
  if (!plan || plan.planHash !== hash)
    throw new Error("方案不存在或版本已变化");
  if (compensate && !plan.steps.some(step => step.state === "completed"))
    throw new Error("没有可恢复的已完成步骤");
  await recordAuditRequired({
    action: compensate
      ? "calendar.cascade.compensation.confirmed"
      : "calendar.cascade.confirmed",
    actorType: "user",
    actorUserId: userId,
    targetType: "calendar_cascade",
    targetId: id,
    metadata: { planHash: hash },
  });
  const accepted = await confirmCascadeRecord(userId, id, hash, compensate);
  if (
    !accepted &&
    !(
      compensate
        ? ["compensating", "compensated"]
        : ["confirmed", "running", "waiting", "completed"]
    ).includes((await getCascade(userId, id))?.status || "")
  )
    throw new Error("方案已过期、已取消或不能确认");
  await advanceCascade(userId, id);
  return publicCascade((await getCascade(userId, id))!);
}
export async function stopCascade(userId: number, id: string) {
  if (!(await stopCascadeRecord(userId, id)))
    throw new Error("方案已结束，不能停止后续步骤");
  await advanceCascade(userId, id);
  return { requested: true };
}
export async function advanceCascade(userId: number, id: string) {
  const before = await getCascade(userId, id);
  if (!before) return;
  if (before.stopRequested && ["drafting", "pending"].includes(before.status)) {
    // Pending unconfirmed drafts never execute. Cancellation is a DB-only transition.
    const { cancelUnconfirmedCascade } = await import(
      "../../db/calendar-cascades"
    );
    await cancelUnconfirmedCascade(userId, id);
    return;
  }
  const claim = await claimCascade(userId, id);
  if (!claim) return;
  const { plan, token } = claim;
  const compensation = plan.status === "compensating";
  try {
    if (!plan.confirmedAt || (compensation && !plan.compensationConfirmedAt))
      throw new Error("Missing confirmation");
    await updateCascade(userId, id, token, {
      status: compensation ? "compensating" : "running",
    });
    const order = topologicalSteps(plan.steps);
    if (compensation) order.reverse();
    for (const step of order) {
      if (
        compensation
          ? step.state !== "completed" || step.compensated
          : step.state === "completed"
      )
        continue;
      const latest = await getCascade(userId, id);
      if (!latest || latest.leaseToken !== token) throw new Error("Lease lost");
      const currentDraft = await getReschedule(
        userId,
        compensation ? step.compensationDraftId || "" : step.draftId
      );
      if (
        !compensation &&
        latest.stopRequested &&
        !["unknown", "executing", "completed"].includes(
          currentDraft?.status || ""
        )
      ) {
        await updateCascade(
          userId,
          id,
          token,
          {
            status: plan.steps.some(s => s.state === "completed")
              ? "partial"
              : "cancelled",
            steps: plan.steps,
          },
          true
        );
        return;
      }
      if (compensation && !step.compensationDraftId) {
        const meeting = await getMeeting(step.meetingId);
        if (
          !meeting ||
          stableToolInputHash(
            meetingPayloadSchema.parse(meeting.payload).event
          ) !== stableToolInputHash(step.event)
        )
          throw new Error("Meeting changed after cascade");
        step.compensationDraftId = (
          await prepareReschedule(
            userId,
            step.meetingId,
            step.previous,
            id,
            collaborationOperationId(
              id,
              `compensation:${step.key}`,
              plan.requestKey
            )
          )
        ).draftId;
        await updateCascade(userId, id, token, { steps: plan.steps });
      }
      const draftId = compensation ? step.compensationDraftId! : step.draftId;
      const result = await confirmReschedule(userId, draftId, {
        cascadeId: id,
        leaseToken: token,
        ...(!compensation && latest.stopRequested
          ? { reconcileOnly: true }
          : {}),
      });
      if (result.status !== "completed") {
        step.state = compensation ? step.state : "waiting";
        await updateCascade(
          userId,
          id,
          token,
          {
            status: compensation ? "compensating" : "waiting",
            steps: plan.steps,
          },
          true
        );
        return;
      }
      if (compensation) step.compensated = true;
      else step.state = "completed";
      await updateCascade(userId, id, token, { steps: plan.steps });
    }
    await updateCascade(
      userId,
      id,
      token,
      {
        status: compensation ? "compensated" : "completed",
        steps: plan.steps,
        errorCode: null,
      },
      true
    );
  } catch {
    const uncertain = await Promise.all(
      plan.steps.map(step =>
        getReschedule(
          userId,
          compensation ? step.compensationDraftId || "" : step.draftId
        )
      )
    );
    const unknown = uncertain.some(
      row => row?.status === "unknown" || row?.status === "executing"
    );
    await updateCascade(
      userId,
      id,
      token,
      {
        status: unknown
          ? compensation
            ? "compensating"
            : "waiting"
          : plan.steps.some(step => step.state === "completed")
            ? "partial"
            : "failed",
        steps: plan.steps,
        errorCode: unknown ? "VERIFY_REQUIRED" : "REPLAN_REQUIRED",
      },
      true
    ).catch(() => undefined);
  }
}
