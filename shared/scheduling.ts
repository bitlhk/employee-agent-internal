import { z } from "zod";

export const schedulingRangeSchema = z
  .object({
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine(({ start, end }) => {
    const duration = Date.parse(end) - Date.parse(start);
    return duration > 0 && duration <= 31 * 86_400_000;
  }, "查询范围必须大于零且不超过31天");

export const calendarBindingSchema = z
  .object({
    userId: z.number().int().positive(),
    username: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[^/\\?#\s]+$/)
      .refine(value => ![".", ".."].includes(value)),
    calendarName: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[^/\\?#\s]+$/)
      .refine(value => ![".", ".."].includes(value)),
    appPassword: z.string().min(1).max(512),
    enabled: z.boolean(),
    discoverable: z.boolean().default(false),
    writeEnabled: z.boolean().default(false),
    autoAvailability: z.boolean().default(false),
    calendarEmail: z
      .union([z.string().email().max(320), z.literal("")])
      .default(""),
  })
  .strict();

export type SchedulingRange = z.infer<typeof schedulingRangeSchema>;
export type CalendarParticipant = {
  userId?: number;
  name: string;
  email: string;
};
export type CalendarEvent = {
  organizer?: CalendarParticipant;
  participants?: CalendarParticipant[];
  canEdit?: boolean;
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  busy: boolean;
  resourceId?: string;
  version?: string;
};

export const personalEventSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    location: z.string().trim().max(300).default(""),
    time: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("timed"),
          start: z.string().datetime({ offset: true }),
          end: z.string().datetime({ offset: true }),
        })
        .strict(),
      z
        .object({
          type: z.literal("allDay"),
          start: z.string().date(),
          end: z.string().date(),
        })
        .strict(),
    ]),
  })
  .strict()
  .refine(
    ({ time }) =>
      Math.floor(Date.parse(time.end) / 1000) >
        Math.floor(Date.parse(time.start) / 1000) &&
      Date.parse(time.end) - Date.parse(time.start) <= 31 * 86_400_000,
    "日程结束必须晚于开始，且不超过31天"
  );

const resourceId = z.string().regex(/^ea-(?:event|meeting)-[a-f0-9]{64}\.ics$/);
export const participantIdsSchema = z
  .array(z.number().int().positive())
  .max(100)
  .refine(ids => new Set(ids).size === ids.length, "参与人不能重复");
export const calendarWriteSchema = z.discriminatedUnion("action", [
  z
    .object({
      operationId: z.string().uuid().optional(),
      action: z.literal("create"),
      event: personalEventSchema,
      participantIds: participantIdsSchema.optional(),
    })
    .strict(),
  z
    .object({
      operationId: z.string().uuid().optional(),
      action: z.literal("update"),
      resourceId,
      version: z.string().min(1).max(256),
      event: personalEventSchema,
      participantIds: participantIdsSchema.optional(),
    })
    .strict(),
  z
    .object({
      operationId: z.string().uuid().optional(),
      action: z.literal("delete"),
      resourceId,
      version: z.string().min(1).max(256),
      title: z.string().trim().min(1).max(200),
    })
    .strict(),
]);
export type CalendarWrite = z.infer<typeof calendarWriteSchema>;

export const coordinationInputSchema = z
  .object({
    requestKey: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    participantIds: z.array(z.number().int().positive()).min(1).max(9),
    slots: z.array(schedulingRangeSchema).min(1).max(6),
  })
  .strict()
  .refine(input => {
    const starts = input.slots.map(slot => Date.parse(slot.start));
    const ends = input.slots.map(slot => Date.parse(slot.end));
    return (
      Math.max(...ends) - Math.min(...starts) <= 31 * 86_400_000 &&
      input.slots.every(
        slot => Date.parse(slot.end) - Date.parse(slot.start) <= 8 * 3_600_000
      ) &&
      new Set(input.participantIds).size === input.participantIds.length
    );
  }, "候选时段跨度不超过31天，单场不超过8小时，参与人不能重复");
export type CoordinationInput = z.infer<typeof coordinationInputSchema>;
export type Availability = "free" | "busy" | "unknown";
export const availabilityReplySchema = z
  .array(z.enum(["free", "busy", "unknown"]))
  .min(1)
  .max(6);

export const meetingPayloadSchema = z
  .object({
    event: personalEventSchema,
    organizer: z.object({
      userId: z.number().int().positive(),
      name: z.string(),
      username: z.string(),
      email: z.string().email(),
    }),
    attendees: z
      .array(
        z.object({
          userId: z.number().int().positive(),
          name: z.string(),
          username: z.string(),
          email: z.string().email(),
        })
      )
      .max(100),
  })
  .refine(input => {
    const people = [input.organizer, ...input.attendees];
    return (
      new Set(people.map(person => person.userId)).size === people.length &&
      new Set(people.map(person => person.email.toLowerCase())).size ===
        people.length
    );
  }, "会议参与人及日历邀请地址必须唯一");
export type MeetingPayload = z.infer<typeof meetingPayloadSchema>;

export const directMeetingSchema = z
  .object({
    requestKey: z.string().uuid(),
    event: personalEventSchema,
    participantIds: participantIdsSchema,
  })
  .strict();
