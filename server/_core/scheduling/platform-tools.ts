import { TRPCError } from "@trpc/server";
import { conversationConfirmation } from "./confirmation-receipt";
import { z } from "zod";
import { schedulingRangeSchema } from "../../../shared/scheduling";
import {
  getCalendarCredentials,
  searchSchedulingPeople,
} from "../../db/scheduling";
import { recordAuditRequired } from "../audit-events";
import { readOwnCalendar } from "./calendar";
import { calendarWriteSchema } from "../../../shared/scheduling";
import { prepareCalendarWrite } from "./write-service";
import {
  prepareMeeting,
  prepareDirectMeeting,
  listMeetings,
} from "./meeting-service";
import { prepareReschedule } from "./reschedule-service";
import {
  personalEventSchema,
  directMeetingSchema,
} from "../../../shared/scheduling";
import { candidateInputSchema, recommendOwnCandidates } from "./candidates";

export const SCHEDULING_PLATFORM_TOOLS = [
  {
    name: "recommend_own_candidates",
    description:
      "Read the authenticated owner's calendar internally and return up to six verified-free future meeting slots, spread across dates. For a recommendation-only request, call this once without a separate query_own_schedules call. It returns slots, not the event list; if the user also asks to see existing arrangements, query_own_schedules supplies that separate result. Does not query other people or create schedules.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: {
          type: "string",
          format: "date",
          description:
            "First local calendar date, inclusive, YYYY-MM-DD in timeZone.",
        },
        endDate: {
          type: "string",
          format: "date",
          description:
            "Last local calendar date, inclusive. Must be on/after startDate; at most 31 calendar dates including both ends. Unlike query_own_schedules.end, this is not exclusive.",
        },
        timeZone: {
          type: "string",
          maxLength: 100,
          description:
            "IANA zone used for dates and daily working hours, e.g. Asia/Shanghai; not a UTC offset.",
        },
        durationMinutes: {
          type: "integer",
          minimum: 5,
          maximum: 480,
          description: "Requested meeting duration in minutes, e.g. 30.",
        },
        dayStart: {
          type: "string",
          pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
          default: "09:00",
          description:
            "Earliest local meeting start each day, HH:mm in timeZone. Omit for 09:00.",
        },
        dayEnd: {
          type: "string",
          pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
          default: "18:00",
          description:
            "Latest local meeting end each day, HH:mm; must be later than dayStart. Omit for 18:00.",
        },
        weekdays: {
          type: "array",
          minItems: 1,
          maxItems: 7,
          items: { type: "integer", minimum: 0, maximum: 6 },
          default: [1, 2, 3, 4, 5],
          description:
            "Allowed local weekdays: 0=Sunday, 1=Monday, ..., 6=Saturday. Omit for Monday-Friday; use [0,1,2,3,4,5,6] to include weekends.",
        },
      },
      required: ["startDate", "endDate", "timeZone", "durationMinutes"],
      additionalProperties: false,
    },
  },
  {
    name: "prepare_meeting_reschedule",
    description:
      "Prepare a reschedule of a meeting organized by the current user. Preserves original UID and participants. Only saves a draft; explicit confirmation updates the original meeting. Query availability separately only when requested. Never claim executed.",
    inputSchema: {
      type: "object",
      properties: {
        meetingId: { type: "string", format: "uuid" },
        event: {
          type: "object",
          properties: {
            title: { type: "string" },
            location: { type: "string" },
            time: {
              type: "object",
              properties: {
                type: { type: "string", const: "timed" },
                start: { type: "string" },
                end: { type: "string" },
              },
              required: ["type", "start", "end"],
              additionalProperties: false,
            },
          },
          required: ["title", "time"],
          additionalProperties: false,
        },
      },
      required: ["meetingId", "event"],
      additionalProperties: false,
    },
  },
  {
    name: "prepare_meeting_invitation",
    description:
      "Prepare a schedule with organization participants, either from explicit event/participantIds/requestKey or a selected coordinationId/slotIndex. Only saves an immutable draft; the user confirms using the inline confirmation card in this conversation. Creation does not check availability or require participant responses. Never claim created or accepted at draft time.",
    inputSchema: {
      type: "object",
      properties: {
        requestKey: { type: "string", format: "uuid" },
        event: z.toJSONSchema(personalEventSchema),
        participantIds: {
          type: "array",
          items: { type: "integer", minimum: 1 },
          maxItems: 100,
        },
        coordinationId: { type: "string", format: "uuid" },
        slotIndex: { type: "integer", minimum: 0, maximum: 5 },
        location: { type: "string" },
      },
      anyOf: [
        { required: ["coordinationId", "slotIndex"] },
        { required: ["requestKey", "event", "participantIds"] },
      ],
      additionalProperties: false,
    },
  },
  {
    name: "list_meeting_invitations",
    description:
      "List shared schedules involving the current user, with participants. Creation does not depend on invitation replies. No other person's private calendar is queried.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "prepare_personal_schedule_write",
    description:
      "Prepare a create/update/delete of the current user's personal schedule. Returns a draft; the user must confirm it using the inline confirmation card in this conversation before it executes. Never claim it has executed. Optional participantIds must resolve to members of the current owner's organization. Saving does not check availability; use coordination tools only when requested. Recurrence is unsupported. Reuse the returned draft, do not generate another after a timeout.",
    inputSchema: {
      type: "object",
      properties: {
        participantIds: {
          type: "array",
          items: { type: "integer", minimum: 1 },
          maxItems: 100,
        },
        action: { type: "string", enum: ["create", "update", "delete"] },
        resourceId: { type: "string" },
        version: { type: "string" },
        title: {
          type: "string",
          description: "Required for delete; exact event title from query",
        },
        event: {
          type: "object",
          properties: {
            title: { type: "string" },
            location: { type: "string" },
            time: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["timed", "allDay"] },
                start: { type: "string" },
                end: { type: "string" },
              },
              required: ["type", "start", "end"],
              additionalProperties: false,
            },
          },
          required: ["title", "time"],
          additionalProperties: false,
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "query_own_schedules",
    description:
      "List the authenticated owner's existing timed/all-day events for a requested range. Use this alone when the user asks to see arrangements; it does not recommend slots. Recommendation-only requests should use recommend_own_candidates directly, which already reads the calendar. If both event details and recommendations are explicitly requested, call each tool once for their respective results. Never read another person's calendar; errors mean unknown availability, not free.",
    inputSchema: {
      type: "object",
      properties: {
        start: {
          type: "string",
          format: "date-time",
          description:
            "Inclusive range start: full ISO 8601 timestamp with Z or explicit UTC offset, e.g. 2026-10-22T00:00:00+08:00. Do not pass a date-only string.",
        },
        end: {
          type: "string",
          format: "date-time",
          description:
            "Exclusive range end: ISO 8601 with Z or UTC offset; later than start and at most 31 elapsed days after start. To query through October 26 inclusive, use October 27 00:00 in the same zone.",
        },
      },
      required: ["start", "end"],
      additionalProperties: false,
    },
  },
  {
    name: "search_scheduling_people",
    description:
      "Find users only within the current owner's organization. Without organization access, instruct the user to contact their administrator. If several people match, ask the user to choose a stable userId. Does not read their calendars or start coordination.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
] as const;

export async function handleSchedulingTool(
  userId: number,
  name: string,
  args: Record<string, unknown>,
  operationId?: string
) {
  try {
    if (!Number.isInteger(userId) || userId <= 0)
      throw new Error("Missing trusted user");
    const credentials = await getCalendarCredentials(userId);
    if (!credentials)
      return {
        content: [
          {
            type: "text",
            text: "本人日历未启用，请先连接本人的日历账号后再重试。",
          },
        ],
        isError: true,
      };
    await recordAuditRequired({
      action: "calendar.tool.requested",
      actorType: "agent",
      actorUserId: userId,
      targetType: "calendar",
      targetId: String(userId),
      toolName: name,
    });
    if (name === "recommend_own_candidates")
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await recommendOwnCandidates(
                userId,
                candidateInputSchema.parse(args)
              )
            ),
          },
        ],
      };
    if (name === "prepare_meeting_reschedule") {
      const input = z
        .object({ meetingId: z.string().uuid(), event: personalEventSchema })
        .strict()
        .parse(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              conversationConfirmation(
                "reschedule",
                operationId
                  ? await prepareReschedule(
                      userId,
                      input.meetingId,
                      input.event,
                      undefined,
                      operationId
                    )
                  : await prepareReschedule(
                      userId,
                      input.meetingId,
                      input.event
                    )
              )
            ),
          },
        ],
      };
    }
    if (name === "prepare_meeting_invitation") {
      const input = z
        .union([
          directMeetingSchema,
          z
            .object({
              coordinationId: z.string().uuid(),
              slotIndex: z.number().int().min(0).max(5),
              location: z.string().trim().max(300).default(""),
            })
            .strict(),
        ])
        .parse(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              conversationConfirmation(
                "meeting",
                "event" in input
                  ? await prepareDirectMeeting(userId, input)
                  : await prepareMeeting(
                      userId,
                      input.coordinationId,
                      input.slotIndex,
                      input.location
                    )
              )
            ),
          },
        ],
      };
    }
    if (name === "list_meeting_invitations") {
      z.object({}).strict().parse(args);
      return {
        content: [
          { type: "text", text: JSON.stringify(await listMeetings(userId)) },
        ],
      };
    }
    const data =
      name === "query_own_schedules"
        ? await readOwnCalendar(
            userId,
            credentials,
            schedulingRangeSchema.parse(args)
          )
        : name === "search_scheduling_people"
          ? await searchSchedulingPeople(
              userId,
              z
                .object({ query: z.string().trim().min(1).max(100) })
                .strict()
                .parse(args).query
            )
          : name === "prepare_personal_schedule_write"
            ? conversationConfirmation(
                "draft",
                operationId
                  ? await prepareCalendarWrite(
                      userId,
                      calendarWriteSchema.parse(args),
                      operationId
                    )
                  : await prepareCalendarWrite(
                      userId,
                      calendarWriteSchema.parse(args)
                    )
              )
            : (() => {
                throw new Error("Unknown scheduling tool");
              })();
    return { content: [{ type: "text", text: JSON.stringify({ data }) }] };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text:
            error instanceof TRPCError
              ? error.message
              : "日程操作未完成，请检查连接与权限",
        },
      ],
      isError: true,
    };
  }
}
