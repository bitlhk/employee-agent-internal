import { getClawByAdoptId, getCollabRequest, getUserById } from "../../db";
import { getCollaborationRun } from "../../db/collaboration-runs";
import { collaborationWaitingResources } from "./resources";
import { getCalendarCredentials } from "../../db/scheduling";
import { readOwnCalendar } from "../scheduling/calendar";
import { availabilityForSlots } from "../scheduling/availability";
import { canCollaborate } from "../../db/coop-identity";
import {
  availabilityCell,
  releasedAvailability,
  requestedSlots,
  slotKey,
  type AvailabilityMatrix,
  type CandidateSlot,
  type AvailabilityCell,
} from "../../../shared/scheduling-progress";
import { TRPCError } from "@trpc/server";

export async function goalAvailability(
  userId: number,
  adoptId: string,
  id: string
): Promise<AvailabilityMatrix> {
  const run = await getCollaborationRun(id);
  const owner = await getClawByAdoptId(adoptId);
  if (
    !run ||
    run.userId !== userId ||
    run.adoptId !== adoptId ||
    owner?.userId !== userId
  )
    throw new TRPCError({ code: "FORBIDDEN" });
  const resources = await collaborationWaitingResources(run);
  const requests: {
    request: NonNullable<Awaited<ReturnType<typeof getCollabRequest>>>;
    name: string;
    result: { shared: boolean; summary: string; expired?: boolean } | undefined;
    asked: CandidateSlot[];
  }[] = [];
  for (const resource of resources.filter(r => r.resourceKind === "request")) {
    const request = await getCollabRequest(Number(resource.resourceId));
    if (
      !request ||
      request.requesterUserId !== userId ||
      request.requesterAdoptId !== adoptId ||
      request.taskType !== "scheduling" ||
      !(await canCollaborate(userId, request.targetUserId)).ok
    )
      continue;
    const person = await getUserById(request.targetUserId);
    requests.push({
      request,
      name: person?.name || "组织成员",
      result: resource.result,
      asked: requestedSlots(request.inputPayload),
    });
  }
  const slots = new Map<string, CandidateSlot>();
  for (const item of requests) {
    const result = item.result?.shared
      ? releasedAvailability(item.result.summary)
      : null;
    for (const slot of [
      ...item.asked,
      ...(result?.slots || []),
      ...(result?.observations || []),
    ])
      slots.set(slotKey(slot), { start: slot.start, end: slot.end });
  }
  const candidates = [...slots.values()].sort(
    (a, b) => Date.parse(a.start) - Date.parse(b.start)
  );
  const people = [
    ...new Map(
      requests.map(item => [
        item.request.targetUserId,
        { id: String(item.request.targetUserId), name: item.name },
      ])
    ).values(),
  ];
  let own: AvailabilityCell[] = candidates.map(() => "unknown");
  if (
    candidates.length &&
    Date.parse(candidates.at(-1)!.end) - Date.parse(candidates[0].start) <=
      31 * 86400000
  ) {
    try {
      const credentials = await getCalendarCredentials(userId);
      if (credentials) {
        const events = await readOwnCalendar(userId, credentials, {
          start: candidates[0].start,
          end: new Date(
            Math.max(...candidates.map(s => Date.parse(s.end)))
          ).toISOString(),
        });
        own = availabilityForSlots(events, candidates, credentials.timeZone);
      }
    } catch {
      /* Unknown is not free; polling can recover. */
    }
  }
  return {
    people: [{ id: String(userId), name: "我" }, ...people],
    rows: candidates.map((slot, index) => {
      const cells: AvailabilityCell[] = [
        own[index],
        ...people.map(person => {
          const matches = requests
            .filter(
              item =>
                String(item.request.targetUserId) === person.id &&
                [
                  ...item.asked,
                  ...(releasedAvailability(item.result?.summary || "")?.slots ||
                    []),
                ].some(s => slotKey(s) === slotKey(slot))
            )
            .sort((a, b) => b.request.id - a.request.id);
          const item = matches[0];
          if (item?.result?.shared && item.result.expired && item.request.status === "completed") return "expired";
          return item
            ? availabilityCell(
                item.request.status,
                item.result?.shared === true,
                item.result?.summary || "",
                slot,
                item.asked
              )
            : "unasked";
        }),
      ];
      return { ...slot, cells, common: cells.every(cell => cell === "free") };
    }),
  };
}

export async function incomingSchedulingProgress(
  userId: number,
  adoptId: string,
  requestId: number
) {
  const owner = await getClawByAdoptId(adoptId);
  const request = await getCollabRequest(requestId);
  if (
    owner?.userId !== userId ||
    request?.targetUserId !== userId ||
    request.targetAdoptId !== adoptId ||
    request.taskType !== "scheduling"
  )
    throw new TRPCError({ code: "NOT_FOUND" });
  const requester = await getUserById(request.requesterUserId);
  const result = releasedAvailability(request.resultSummary || "");
  const slots = new Map(
    [
      ...requestedSlots(request.inputPayload),
      ...(result?.slots || []),
      ...(result?.observations || []),
    ].map(slot => [slotKey(slot), slot])
  );
  return {
    id: request.id,
    status: request.status,
    taskSummary: request.taskSummary,
    requesterName: requester?.name || "组织成员",
    reply: request.status === "completed" ? result : null,
    matrix: {
      people: [{ id: String(userId), name: "我" }],
      rows: [...slots.values()].map(slot => ({
        start: slot.start,
        end: slot.end,
        cells: [
          availabilityCell(
            request.status,
            true,
            request.resultSummary || "",
            slot,
            [...slots.values()]
          ),
        ],
        common: false,
      })),
    } satisfies AvailabilityMatrix,
  };
}
