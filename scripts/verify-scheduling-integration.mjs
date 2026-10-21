import "dotenv/config";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import * as s from "../drizzle/schema.ts";
import { getDb, closeDbConnection } from "../server/db/connection.ts";
import { schedulingRouter } from "../server/routers/scheduling.ts";
import {
  prepareDirectMeeting,
  confirmMeeting,
  cancelMeeting,
} from "../server/_core/scheduling/meeting-service.ts";
import { writeResourceId } from "../server/_core/scheduling/write-calendar.ts";

assert(
  process.argv.includes("--local") && process.env.NODE_ENV === "development"
);
for (const key of ["DATABASE_URL", "NEXTCLOUD_BASE_URL"])
  assert(
    ["127.0.0.1", "localhost", "[::1]"].includes(
      new URL(process.env[key]).hostname
    )
  );
const db = await getDb();
assert(db);
const users = await db
  .select()
  .from(s.users)
  .where(inArray(s.users.id, [2, 3]));
assert(users.some(u => u.id === 2 && u.name === "日程演示用户A"));
assert(users.some(u => u.id === 3 && u.name === "日程演示用户B"));
const profiles = await db
  .select()
  .from(s.lxCollabUserProfiles)
  .where(inArray(s.lxCollabUserProfiles.userId, [2, 3]));
const bindings = await db
  .select()
  .from(s.calendarBindings)
  .where(inArray(s.calendarBindings.userId, [2, 3]));
assert(
  bindings.length === 2 &&
    bindings.every(b => b.enabled && b.writeEnabled && b.calendarEmail)
);
const callers = new Map(
  users.map(user => [
    user.id,
    schedulingRouter.createCaller({ user, req: { headers: {} }, res: {} }),
  ])
);
const owner = callers.get(2),
  peer = callers.get(3);
const prefix = `calendar-crud-${randomUUID()}`;
const fixtureBackup = `data/${prefix}-backup.json`;
writeFileSync(
  fixtureBackup,
  JSON.stringify({
    profiles,
    bindings: bindings.map(b => ({
      userId: b.userId,
      discoverable: b.discoverable,
    })),
  })
);
const range = {
  start: new Date(Date.now() + 86400000).toISOString(),
  end: new Date(Date.now() + 90000000).toISOString(),
};
const event = {
  title: prefix,
  location: "fixture",
  time: { type: "timed", ...range },
};
const drafts = [],
  resources = [],
  meetings = [];
let spaceId;
async function prepare(caller, input) {
  const draft = await caller.prepareWrite(input);
  drafts.push(draft.draftId);
  return draft.draftId;
}
async function create(caller, userId, input) {
  const draftId = await prepare(caller, {
    operationId: randomUUID(),
    action: "create",
    ...input,
  });
  resources.push({ caller, resourceId: writeResourceId(userId, draftId) });
  await caller.confirmWrite({ draftId });
  return draftId;
}
try {
  await db
    .delete(s.lxCollabUserProfiles)
    .where(inArray(s.lxCollabUserProfiles.userId, [2, 3]));
  await assert.rejects(
    owner.searchPeople({ query: "日程演示用户B" }),
    e => e.code === "FORBIDDEN"
  );
  await create(owner, 2, { event });
  assert((await owner.events(range)).some(e => e.title === prefix));
  console.log(
    "PASS personal create/read without organization; organization search denied"
  );
  const [space] = await db
    .insert(s.lxCollabSpaces)
    .values({ name: prefix, status: "active" });
  spaceId = space.insertId;
  await db
    .insert(s.lxCollabUserProfiles)
    .values([2, 3].map(userId => ({ userId, spaceId, status: "active" })));
  await db
    .update(s.calendarBindings)
    .set({ discoverable: false })
    .where(inArray(s.calendarBindings.userId, [2, 3]));
  assert(
    (await owner.searchPeople({ query: "日程演示用户B" })).some(
      p => p.userId === 3
    )
  );
  await create(peer, 3, { event: { ...event, title: `${prefix}-busy` } });
  const operationId = randomUUID();
  const shared = {
    action: "create",
    operationId,
    event: { ...event, title: `${prefix}-shared` },
    participantIds: [3],
  };
  const sharedId = await prepare(owner, shared);
  assert.equal((await owner.prepareWrite(shared)).draftId, sharedId);
  resources.push({ caller: owner, resourceId: writeResourceId(2, sharedId) });
  await owner.confirmWrite({ draftId: sharedId });
  // Simulate a lost application ACK after the provider committed the write.
  await db
    .update(s.calendarWriteDrafts)
    .set({ status: "unknown" })
    .where(eq(s.calendarWriteDrafts.id, sharedId));
  await owner.confirmWrite({ draftId: sharedId });
  let mine = (await owner.events(range)).filter(
    e => e.title === shared.event.title
  );
  assert.equal(mine.length, 1);
  assert.equal(mine[0].participants[0].userId, 3);
  assert(mine[0].canEdit && mine[0].version);
  const received = (await peer.events(range)).find(
    e => e.title === shared.event.title
  );
  assert(received, "CalDAV must synchronize internal participants");
  assert.equal(received.canEdit, false);
  assert.equal(received.resourceId, undefined);
  console.log(
    "PASS shared event despite busy calendars; participant sync; recipient read-only; retry deduplication"
  );
  const updateId = await prepare(owner, {
    action: "update",
    resourceId: mine[0].resourceId,
    version: mine[0].version,
    event: { ...event, title: `${prefix}-updated` },
    participantIds: [],
  });
  await owner.confirmWrite({ draftId: updateId });
  mine = (await owner.events(range)).filter(
    e => e.resourceId === writeResourceId(2, sharedId)
  );
  assert.equal(mine.length, 1);
  assert.equal(mine[0].title, `${prefix}-updated`);
  assert.equal(mine[0].participants.length, 0);
  await assert.rejects(
    owner.prepareWrite({ action: "create", event, participantIds: [1] }),
    e => e.code === "FORBIDDEN"
  );
  const revokedId = await prepare(owner, {
    action: "create",
    event: { ...event, title: `${prefix}-revoked` },
    participantIds: [3],
  });
  await db
    .update(s.lxCollabUserProfiles)
    .set({ spaceId: null })
    .where(eq(s.lxCollabUserProfiles.userId, 3));
  await assert.rejects(
    owner.confirmWrite({ draftId: revokedId }),
    e => e.code === "FORBIDDEN"
  );
  assert(
    !(await owner.events(range)).some(e => e.title === `${prefix}-revoked`)
  );
  await db
    .update(s.lxCollabUserProfiles)
    .set({ spaceId })
    .where(eq(s.lxCollabUserProfiles.userId, 3));
  console.log(
    "PASS update/remove participants in-place; forged/cross-org IDs and revoked membership denied"
  );
  const direct = {
    requestKey: randomUUID(),
    event: { ...event, title: `${prefix}-direct` },
    participantIds: [3],
  };
  const meeting = await prepareDirectMeeting(2, direct);
  meetings.push(meeting.meetingId);
  assert.equal(
    (await prepareDirectMeeting(2, direct)).meetingId,
    meeting.meetingId
  );
  await confirmMeeting(2, meeting.meetingId);
  const [record] = await db
    .select()
    .from(s.calendarMeetings)
    .where(eq(s.calendarMeetings.id, meeting.meetingId));
  assert.equal(record.coordinationId, null);
  assert.equal(record.status, "invited");
  assert(
    (await owner.events(range)).some(
      e => e.title === direct.event.title && e.canEdit
    )
  );
  const directEvent = (await owner.events(range)).find(
    e => e.title === direct.event.title
  );
  const directUpdate = await prepare(owner, {
    action: "update",
    resourceId: directEvent.resourceId,
    version: directEvent.version,
    event: { ...direct.event, title: `${prefix}-direct-edited` },
    participantIds: [],
  });
  await owner.confirmWrite({ draftId: directUpdate });
  const [updatedMeeting] = await db
    .select()
    .from(s.calendarMeetings)
    .where(eq(s.calendarMeetings.id, meeting.meetingId));
  assert.equal(updatedMeeting.payload.event.title, `${prefix}-direct-edited`);
  assert.equal(updatedMeeting.payload.attendees.length, 0);
  console.log(
    "PASS direct meeting creation without coordination; nullable legacy linkage and request idempotency"
  );
} finally {
  for (const meetingId of meetings) await cancelMeeting(2, meetingId);
  for (const { caller, resourceId } of resources.reverse()) {
    const existing = (await caller.events(range)).find(
      e => e.resourceId === resourceId
    );
    if (existing) {
      const draftId = await prepare(caller, {
        action: "delete",
        resourceId,
        version: existing.version,
        title: existing.title,
      });
      await caller.confirmWrite({ draftId });
      assert(
        !(await caller.events(range)).some(e => e.resourceId === resourceId)
      );
    }
  }
  if (drafts.length)
    await db
      .delete(s.calendarWriteDrafts)
      .where(inArray(s.calendarWriteDrafts.id, drafts));
  if (meetings.length)
    await db
      .delete(s.calendarMeetings)
      .where(inArray(s.calendarMeetings.id, meetings));
  await db
    .delete(s.lxCollabUserProfiles)
    .where(inArray(s.lxCollabUserProfiles.userId, [2, 3]));
  if (profiles.length) await db.insert(s.lxCollabUserProfiles).values(profiles);
  if (spaceId)
    await db.delete(s.lxCollabSpaces).where(eq(s.lxCollabSpaces.id, spaceId));
  for (const binding of bindings)
    await db
      .update(s.calendarBindings)
      .set({ discoverable: binding.discoverable })
      .where(eq(s.calendarBindings.userId, binding.userId));
  unlinkSync(fixtureBackup);
  await closeDbConnection();
  console.log("PASS delete and restore demo fixtures");
}
