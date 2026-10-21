import { appendWorkspaceContext } from "../collaboration/conversation-context";
import { createHash } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import {
  calendarBindings,
} from "../../../drizzle/schema";
import { getDb } from "../../db/connection";
import { getCalendarCredentials } from "../../db/scheduling";
import { readOwnCalendar } from "./calendar";
import { bindingFingerprint } from "./write-calendar";
import { recordAuditRequired } from "../audit-events";

export function dueReminderEvents(
  events: Awaited<ReturnType<typeof readOwnCalendar>>,
  now: number
) {
  return events.filter(
    event =>
      !event.allDay &&
      event.busy &&
      Date.parse(event.start) > now &&
      Date.parse(event.start) <= now + 15 * 60_000
  );
}
let cursor = 0;
export async function dispatchCalendarReminders(now = Date.now()) {
  const startedAt = Date.now();
  const db = await getDb();
  if (!db) return;
  let bindings = await db
    .select()
    .from(calendarBindings)
    .where(
      and(
        eq(calendarBindings.enabled, true),
        gt(calendarBindings.userId, cursor)
      )
    )
    .orderBy(calendarBindings.userId)
    .limit(25);
  if (!bindings.length) {
    cursor = 0;
    bindings = await db
      .select()
      .from(calendarBindings)
      .where(eq(calendarBindings.enabled, true))
      .orderBy(calendarBindings.userId)
      .limit(25);
  }
  for (const binding of bindings) {
    cursor = binding.userId;
    try {
      const credentials = await getCalendarCredentials(binding.userId);
      if (!credentials) continue;
      const scanNow = now + Date.now() - startedAt;
      await recordAuditRequired({
        action: "calendar.reminder.read",
        actorType: "agent",
        actorUserId: binding.userId,
        targetType: "calendar",
        targetId: String(binding.userId),
      });
      const events = await readOwnCalendar(binding.userId, credentials, {
        start: new Date(scanNow).toISOString(),
        end: new Date(scanNow + 15 * 60_000).toISOString(),
      });
      const current = await getCalendarCredentials(binding.userId);
      if (
        !current ||
        bindingFingerprint(current) !== bindingFingerprint(credentials)
      )
        continue;
      for (const event of dueReminderEvents(
        events,
        now + Date.now() - startedAt
      )) {
        const eventKey = createHash("sha256")
          .update(
            JSON.stringify([
              credentials.username,
              credentials.calendarName,
              event.id,
              event.start,
            ])
          )
          .digest("hex");
        await appendWorkspaceContext(binding.userId, `reminder:${eventKey}`,
          `日程提醒：${event.title}\n开始时间：${event.start}\n结束时间：${event.end}${event.location ? `\n地点：${event.location}` : ""}`, new Date(scanNow));
      }
    } catch {
      /* Do not send external notifications or fabricate reminders after read failures. */
    }
  }
}
