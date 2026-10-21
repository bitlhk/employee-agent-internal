import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import * as schema from "../drizzle/schema";
import { getDb, closeDbConnection } from "../server/db/connection";
import { getCalendarCredentials } from "../server/db/scheduling";
import { startCoordination } from "../server/_core/scheduling/coordination-service";
import {
  prepareMeeting,
  confirmMeeting,
  cancelMeeting,
} from "../server/_core/scheduling/meeting-service";
import {
  prepareCascade,
  confirmCascade,
  advanceCascade,
} from "../server/_core/scheduling/cascade-service";
import {
  loadOwnMeeting,
  matchesMeeting,
} from "../server/_core/scheduling/meeting-calendar";
import { getMeeting } from "../server/db/calendar-meetings";
import { getCascade } from "../server/db/calendar-cascades";
import { meetingPayloadSchema } from "../shared/scheduling";

async function cleanupFixture(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  prefix: string
) {
  assert(/^cascade-test-[0-9a-f]{8}$/.test(prefix));
  const meetings = await db
    .select()
    .from(schema.calendarMeetings)
    .where(
      and(
        eq(schema.calendarMeetings.creatorUserId, 2),
        like(schema.calendarMeetings.payload, `%${prefix}%`)
      )
    );
  // Keep DB receipts if remote cancellation cannot be verified.
  for (const meeting of meetings) {
    assert.equal(
      meetingPayloadSchema.parse(meeting.payload).event.title,
      prefix
    );
    await cancelMeeting(2, meeting.id);
  }
  const plans = await db
    .select({ id: schema.calendarCascades.id })
    .from(schema.calendarCascades)
    .where(
      and(
        eq(schema.calendarCascades.userId, 2),
        eq(schema.calendarCascades.title, prefix)
      )
    );
  if (plans.length) {
    const ids = plans.map(plan => plan.id);
    await db
      .delete(schema.calendarReschedules)
      .where(inArray(schema.calendarReschedules.cascadeId, ids));
    await db
      .delete(schema.calendarCascades)
      .where(inArray(schema.calendarCascades.id, ids));
  }
  if (meetings.length)
    await db.delete(schema.calendarMeetings).where(
      inArray(
        schema.calendarMeetings.id,
        meetings.map(row => row.id)
      )
    );
  const coordinations = await db
    .select({ id: schema.calendarCoordinations.id })
    .from(schema.calendarCoordinations)
    .where(
      and(
        eq(schema.calendarCoordinations.creatorUserId, 2),
        like(schema.calendarCoordinations.payload, `%${prefix}%`)
      )
    );
  if (coordinations.length) {
    const ids = coordinations.map(row => row.id);
    await db
      .delete(schema.calendarAvailabilityTasks)
      .where(inArray(schema.calendarAvailabilityTasks.coordinationId, ids));
    await db
      .delete(schema.calendarCoordinations)
      .where(inArray(schema.calendarCoordinations.id, ids));
  }
}

async function main() {
  if (
    !process.argv.includes("--local") ||
    process.env.NODE_ENV !== "development" ||
    !["localhost", "127.0.0.1"].includes(
      new URL(process.env.NEXTCLOUD_BASE_URL!).hostname
    ) ||
    !["localhost", "127.0.0.1"].includes(
      new URL(process.env.DATABASE_URL!).hostname
    )
  )
    throw new Error(
      "Requires explicit --local and loopback development services"
    );
  const db = (await getDb())!;
  const users = await db
    .select()
    .from(schema.users)
    .where(inArray(schema.users.id, [2, 3]));
  assert(
    users.some(u => u.id === 2 && u.name === "日程演示用户A") &&
      users.some(u => u.id === 3 && u.name === "日程演示用户B"),
    "Only controlled demo accounts may be used"
  );
  const cleanupPrefix = process.argv
    .find(arg => arg.startsWith("--cleanup-prefix="))
    ?.slice(17);
  if (cleanupPrefix) {
    await cleanupFixture(db, cleanupPrefix);
    console.log("Controlled local fixture cancelled and cleaned");
    return;
  }
  const bindings = await db
    .select()
    .from(schema.calendarBindings)
    .where(inArray(schema.calendarBindings.userId, [2, 3]));
  assert.equal(bindings.length, 2);
  const prefix = `cascade-test-${randomUUID().slice(0, 8)}`;
  const meetings: string[] = [];
  const date = new Date(
    Date.now() + (20 + Math.floor(Math.random() * 200)) * 86_400_000
  )
    .toISOString()
    .slice(0, 10);
  const event = (hour: number) => ({
    title: prefix,
    location: "local test",
    time: {
      type: "timed" as const,
      start: `${date}T${hour}:00:00+08:00`,
      end: `${date}T${hour}:30:00+08:00`,
    },
  });
  const creds = (await getCalendarCredentials(2))!;
  try {
    await db
      .update(schema.calendarBindings)
      .set({ enabled: true, discoverable: true, autoAvailability: true })
      .where(inArray(schema.calendarBindings.userId, [2, 3]));
    for (const hour of [10, 11]) {
      const e = event(hour);
      const coordination = await startCoordination(2, {
        requestKey: randomUUID(),
        title: prefix,
        participantIds: [3],
        slots: [{ start: e.time.start, end: e.time.end }],
      });
      assert.deepEqual(coordination.commonIndices, [0]);
      const draft = await prepareMeeting(2, coordination.id, 0, e.location);
      meetings.push(draft.meetingId);
      assert.equal(
        (await confirmMeeting(2, draft.meetingId)).status,
        "invited"
      );
    }
    const original = await Promise.all(
      meetings.map(id => loadOwnMeeting(2, creds, id))
    );
    assert(original.every(Boolean));
    const plan = await prepareCascade(2, {
      requestKey: randomUUID(),
      title: prefix,
      steps: [
        { key: "a", meetingId: meetings[0], event: event(11), dependsOn: [] },
        { key: "b", meetingId: meetings[1], event: event(12), dependsOn: [] },
      ],
    });
    assert.deepEqual(plan.steps[0].dependsOn, ["b"]);
    assert.equal(
      (await loadOwnMeeting(2, creds, meetings[0]))!.version,
      original[0]!.version,
      "Preparation must never write"
    );
    await assert.rejects(confirmCascade(3, plan.id, plan.planHash));
    await assert.rejects(confirmCascade(2, plan.id, "wrong-version"));
    await confirmCascade(2, plan.id, plan.planHash);
    for (
      let i = 0;
      i < 6 && (await getCascade(2, plan.id))?.status === "waiting";
      i++
    )
      await advanceCascade(2, plan.id);
    assert.equal((await getCascade(2, plan.id))?.status, "completed");
    const moved = await Promise.all(
      meetings.map(id => loadOwnMeeting(2, creds, id))
    );
    for (const [i, current] of moved.entries()) {
      const row = (await getMeeting(meetings[i]))!;
      assert(
        matchesMeeting(
          current!.component,
          meetingPayloadSchema.parse(row.payload)
        )
      );
      assert.equal(
        current!.component.getFirstPropertyValue("uid"),
        original[i]!.component.getFirstPropertyValue("uid")
      );
      assert.notEqual(current!.version, original[i]!.version);
    }
    await confirmCascade(2, plan.id, plan.planHash);
    assert.equal(
      (await loadOwnMeeting(2, creds, meetings[0]))!.version,
      moved[0]!.version,
      "Repeated confirmation must not repeat PUT"
    );
    await confirmCascade(2, plan.id, plan.planHash, true);
    for (
      let i = 0;
      i < 6 && (await getCascade(2, plan.id))?.status === "compensating";
      i++
    )
      await advanceCascade(2, plan.id);
    assert.equal((await getCascade(2, plan.id))?.status, "compensated");
    for (const [i, id] of meetings.entries())
      assert.equal(
        (await loadOwnMeeting(2, creds, id))!.component
          .getFirstPropertyValue("dtstart")
          .toString(),
        original[i]!.component.getFirstPropertyValue("dtstart").toString()
      );
    console.log(
      "Real Nextcloud: inferred dependencies, owner/hash confirmation, two-step forward changes, stable UID, ETag change, repeat confirmation without PUT and separately confirmed reverse compensation passed."
    );
  } finally {
    try {
      await cleanupFixture(db, prefix);
    } finally {
      for (const binding of bindings) {
        const { userId, ...values } = binding;
        await db
          .update(schema.calendarBindings)
          .set(values)
          .where(eq(schema.calendarBindings.userId, userId));
      }
    }
  }
}
main()
  .catch(error => {
    console.error(
      error instanceof Error ? error.message : "Calendar verification failed"
    );
    process.exitCode = 1;
  })
  .finally(closeDbConnection);
