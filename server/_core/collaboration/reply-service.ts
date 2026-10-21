import { assertCoopParticipants } from "../../db/coop-identity";
import { z } from "zod";
import { collaborationSettingsForTask } from "../../../shared/scheduling-collaboration-policy";
import {
  finishApprovedCollabRequest,
  getCollabRequest,
  getClawByAdoptId,
  getCollabSettings,
} from "../../db";
import { stableToolInputHash } from "../tool-governance";
import { parseCollaborationResultMeta } from "./result-projection";
import { getCalendarBinding, getCalendarCredentials } from "../../db/scheduling";
import { readOwnCalendar } from "../scheduling/calendar";
import { availabilityForSlots } from "../scheduling/availability";
import { recordAuditRequired } from "../audit-events";
import { requestedSlots } from "../../../shared/scheduling-progress";

const offsetDate = z.string().datetime({ offset: true });
const slot = z
  .object({ start: offsetDate, end: offsetDate })
  .strict()
  .refine(
    value => Date.parse(value.end) > Date.parse(value.start),
    "结束时间必须晚于开始时间"
  );
export const collaborationReplyInput = z
  .object({
    requestId: z.number().int().positive(),
    summary: z.string().max(2000).optional(),
    scheduling: z
      .object({
        availability: z.enum([
          "available",
          "unavailable",
          "conditional",
          "unknown",
        ]),
        slots: z.array(slot).max(6),
        validUntil: offsetDate,
      })
      .strict()
      .optional(),
  })
  .strict();

export async function replyToCollaboration(
  userId: number,
  adoptId: string,
  input: z.infer<typeof collaborationReplyInput>
) {
  const [owner, request] = await Promise.all([
    getClawByAdoptId(adoptId),
    getCollabRequest(input.requestId),
  ]);
  if (
    !owner ||
    owner.userId !== userId ||
    owner.permissionProfile === "starter" ||
    !["active", "expiring"].includes(owner.status) ||
    !request ||
    request.targetAdoptId !== adoptId ||
    request.targetUserId !== userId
  )
    throw new Error("只能回复发给本助手的协作");
  if (request.taskType === "scheduling") await assertCoopParticipants(request.requesterUserId, [userId]);
  const replyFingerprint = stableToolInputHash(input);
  if (!["approved", "running"].includes(request.status)) {
    if (
      request.status === "completed" &&
      parseCollaborationResultMeta(request.resultMeta).replyFingerprint ===
        replyFingerprint
    )
      return { requestId: request.id, status: "completed" };
    throw new Error("协作尚未批准、已经答复或已撤销");
  }
  let summary: string;
  const checkAutoConsent = async () => {
    if (request.taskType !== "scheduling" || request.approvalMode !== "auto" || request.approvedBy != null) return;
    const [settings, binding] = await Promise.all([getCollabSettings(owner.id).then(value => collaborationSettingsForTask(value, "scheduling")), getCalendarBinding(userId)]);
    let allowed: unknown = [];
    try { allowed = JSON.parse(settings?.allowedTaskTypes || "[]"); } catch { /* Invalid consent fails closed. */ }
    if (settings?.acceptTask !== "auto" || !Array.isArray(allowed) || !allowed.includes("scheduling") || !binding?.enabled || !binding.autoAvailability) throw new Error("自动日程回复授权已撤销，需要本人重新批准");
  };
  await checkAutoConsent();
  if (request.taskType === "scheduling") {
    if (!input.scheduling || input.summary)
      throw new Error(
        "日程回复只能包含忙闲结论和候选时间，不能包含私人日程详情"
      );
    const remaining = Date.parse(input.scheduling.validUntil) - Date.now();
    if (remaining <= 0 || remaining > 15 * 60_000)
      throw new Error("忙闲结论已过期或有效期超过15分钟，请重新查询本人日历");
    if (input.scheduling.availability === "available") {
      if (!input.scheduling.slots.length)
        throw new Error("有空的结论必须指定具体时段");
      const credentials = await getCalendarCredentials(userId);
      if (!credentials) throw new Error("本人日历未授权，不能回复有空");
      await recordAuditRequired({
        action: "calendar.collaboration.reply.checked",
        actorType: "agent",
        actorUserId: userId,
        targetType: "collaboration",
        targetId: String(request.id),
      });
      const range = {
        start: new Date(
          Math.min(
            ...input.scheduling.slots.map(value => Date.parse(value.start))
          )
        ).toISOString(),
        end: new Date(
          Math.max(
            ...input.scheduling.slots.map(value => Date.parse(value.end))
          )
        ).toISOString(),
      };
      const events = await readOwnCalendar(userId, credentials, range);
      const current = await getCalendarCredentials(userId);
      if (
        !current ||
        current.grantId !== credentials.grantId ||
        current.username !== credentials.username ||
        current.calendarName !== credentials.calendarName ||
        current.timeZone !== credentials.timeZone
      )
        throw new Error("本人日历授权已变化，请重新查询");
      if (
        availabilityForSlots(
          events,
          input.scheduling.slots,
          credentials.timeZone
        ).some(value => value !== "free")
      )
        throw new Error("本人日历存在冲突或忙闲未知，不能回复有空");
    }
    // A reply is a bounded, expiring observation, never evidence of a calendar write.
    const candidates = requestedSlots(request.inputPayload);
    let observations: { start: string; end: string; availability: "free" | "busy" | "unknown" }[] | undefined;
    if (candidates.length) {
      // Only the approved recipient's own calendar is consulted; publish no event details.
      let values: ("free" | "busy" | "unknown")[] = candidates.map(() => "unknown");
      try {
        const credentials = await getCalendarCredentials(userId);
        if (credentials) {
          const events = await readOwnCalendar(userId, credentials, { start: new Date(Math.min(...candidates.map(s => Date.parse(s.start)))).toISOString(), end: new Date(Math.max(...candidates.map(s => Date.parse(s.end)))).toISOString() });
          const current = await getCalendarCredentials(userId);
          if (current && current.grantId === credentials.grantId && current.username === credentials.username && current.calendarName === credentials.calendarName && current.timeZone === credentials.timeZone) values = availabilityForSlots(events, candidates, credentials.timeZone);
        }
      } catch { /* A failed read remains unknown, never free. */ }
      observations = candidates.map((slot, i) => ({ ...slot, availability: values[i] }));
    }
    summary = JSON.stringify({ ...input.scheduling, ...(observations ? { observations } : {}), calendarChanged: false });
  } else {
    if (!input.summary || input.scheduling)
      throw new Error("请提供本次协作的结果摘要");
    if (
      /session_id|memory_id|agent_id|user_id:|adoptId:|sessionKey|token:|password|secret/i.test(
        input.summary
      )
    )
      throw new Error("结果摘要包含禁止内容");
    summary = input.summary;
  }
  await checkAutoConsent();
  if (input.scheduling && Date.parse(input.scheduling.validUntil) <= Date.now()) throw new Error("忙闲结论已过期，请重新查询本人日历");
  if (request.taskType === "scheduling") await assertCoopParticipants(request.requesterUserId, [userId]);
  const saved = await finishApprovedCollabRequest(request.id, adoptId, {
    status: "completed",
    resultSummary: summary,
    completedAt: new Date(),
    resultMeta: JSON.stringify({
      status: "success",
      summary,
      replyFingerprint,
    }),
  });
  if (!saved) throw new Error("协作状态已变化，请刷新后重试");
  return { requestId: request.id, status: "completed" };
}
