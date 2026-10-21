import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "dotenv";
import { and, eq, inArray, like } from "drizzle-orm";
import superjson from "superjson";
import * as s from "../drizzle/schema";
import { getDb } from "../server/db/connection";
import { sdk, sessionAuthVersion } from "../server/_core/sdk";
import { COOKIE_NAME } from "../shared/const";
import { calendarUrl } from "../server/_core/scheduling/calendar";
import {
  saveCalendarBinding,
  getCalendarBinding,
} from "../server/db/scheduling";
import { cancelMeeting } from "../server/_core/scheduling/meeting-service";
import { meetingPayloadSchema } from "../shared/scheduling";
import { resolveEffectiveRoleAssets } from "../server/db";
import { resolveAgentRoleTemplate } from "../server/_core/role-templates";
import { getRoleRuntimeAdapter } from "../server/routers/role-runtime-adapters";
import { reconcileRoleRuntimeAssets } from "../server/_core/role-runtime-adapter";
import { resolveRuntimeAgentId } from "../server/_core/helpers";

export async function localFixtureDatabase() {
  assert(
    process.argv.includes("--local") && process.env.NODE_ENV === "development"
  );
  for (const value of [
    process.env.NEXTCLOUD_BASE_URL,
    process.env.DATABASE_URL,
  ])
    assert(
      value && ["127.0.0.1", "localhost"].includes(new URL(value).hostname)
    );
  const db = await getDb();
  assert(db);
  const users = await db
    .select()
    .from(s.users)
    .where(inArray(s.users.id, [2, 3]));
  assert(users.some(u => u.id === 2 && u.name === "日程演示用户A"));
  assert(users.some(u => u.id === 3 && u.name === "日程演示用户B"));
  return db;
}

// Reusable local demo account, never a real person's identity or credentials.
export async function ensureThirdDemoUser(
  db: Awaited<ReturnType<typeof localFixtureDatabase>>
) {
  const openId = "local-scheduling-e2e-c";
  let [user] = await db
    .select()
    .from(s.users)
    .where(eq(s.users.openId, openId));
  if (!user) {
    await db
      .insert(s.users)
      .values({ openId, name: "日程验收用户C", loginMethod: "local-fixture" });
    [user] = await db.select().from(s.users).where(eq(s.users.openId, openId));
  }
  assert(user?.name === "日程验收用户C");
  if (await getCalendarBinding(user.id)) return user.id;
  const base = process.env.NEXTCLOUD_BASE_URL!;
  const config = parse(readFileSync("deploy/calendar/nextcloud/.env"));
  const auth = Buffer.from(
    `${config.NEXTCLOUD_ADMIN_USER}:${config.NEXTCLOUD_ADMIN_PASSWORD}`
  ).toString("base64");
  const credentialFile =
    "C:/ProgramData/MySQL/EmployeeAgent/calendar-accounts.json";
  const accounts: Record<string, { username: string; password: string }> =
    JSON.parse(readFileSync(credentialFile, "utf8"));
  let account = accounts[String(user.id)];
  if (!account) {
    account = {
      username: `ea-user-${user.id}`,
      password: randomBytes(24).toString("hex"),
    };
    const response = await fetch(`${base}/ocs/v1.php/cloud/users?format=json`, {
      method: "POST",
      headers: {
        authorization: `Basic ${auth}`,
        "OCS-APIRequest": "true",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        userid: account.username,
        password: account.password,
        displayName: user.name,
        email: `${account.username}@calendar.local.invalid`,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const result = (await response.json()) as {
      ocs?: { meta?: { statuscode?: number } };
    };
    assert(
      response.ok && result.ocs?.meta?.statuscode === 100,
      "Demo C provisioning failed; existing remote credentials will not be reset"
    );
    accounts[String(user.id)] = account;
    writeFileSync(credentialFile, JSON.stringify(accounts, null, 2), {
      mode: 0o600,
    });
  }
  const response = await fetch(
    calendarUrl(base, account.username, "personal"),
    {
      method: "MKCALENDAR",
      headers: {
        authorization: `Basic ${Buffer.from(`${account.username}:${account.password}`).toString("base64")}`,
        "content-type": "application/xml",
      },
      body: '<c:mkcalendar xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:d="DAV:"><d:set><d:prop><d:displayname>验收日程</d:displayname></d:prop></d:set></c:mkcalendar>',
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }
  );
  assert([201, 405].includes(response.status));
  await saveCalendarBinding({
    userId: user.id,
    username: account.username,
    appPassword: account.password,
    calendarName: "personal",
    enabled: true,
    discoverable: true,
    writeEnabled: true,
    calendarEmail: `${account.username}@calendar.local.invalid`,
  });
  return user.id;
}

export async function ownerRpc(
  userId: number | null,
  method: string,
  input: unknown,
  expectError = false
) {
  const base =
    process.env.WORKFORCE_AGENT_INTERNAL_BASE_URL || "http://127.0.0.1:5174";
  assert(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (userId !== null) {
    const db = (await getDb())!;
    const [user] = await db
      .select()
      .from(s.users)
      .where(eq(s.users.id, userId));
    assert(
      user &&
        (user.name?.startsWith("日程演示用户") ||
          user.openId === "local-scheduling-e2e-c")
    );
    headers.cookie = `${COOKIE_NAME}=${await sdk.signSession({ userId, name: user.name!, authVersion: sessionAuthVersion(user) }, { expiresInMs: 3_600_000 })}`;
  }
  const response = await fetch(`${base}/api/trpc/scheduling.${method}`, {
    method: "POST",
    headers,
    body: JSON.stringify(superjson.serialize(input)),
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await response.json()) as {
    error?: unknown;
    result?: { data: ReturnType<typeof superjson.serialize> };
  };
  if (expectError) {
    assert(
      !response.ok && body.error,
      "Owner boundary unexpectedly accepted confirmation"
    );
    return;
  }
  assert(
    response.ok && !body.error && body.result,
    `Owner RPC ${method} failed (HTTP ${response.status})`
  );
  return superjson.deserialize(body.result.data);
}

export async function createDemoAssistants(
  db: Awaited<ReturnType<typeof localFixtureDatabase>>,
  userIds: number[],
  prefix: string
) {
  const result = [];
  for (const [i, userId] of userIds.entries()) {
    const adoptId = `lgj-eval-${prefix}-${i}`;
    await db.insert(s.clawAdoptions).values({
      userId,
      adoptId,
      agentId: `jiuwen_${adoptId}`,
      status: "active",
      permissionProfile: "plus",
      roleTemplate: "general-assistant",
      runtime: "jiuwenswarm",
      entryUrl: `/claw/${adoptId}`,
    });
    const [adoption] = await db
      .select()
      .from(s.clawAdoptions)
      .where(eq(s.clawAdoptions.adoptId, adoptId));
    await db.insert(s.clawCollabSettings).values({
      adoptionId: adoption.id,
      displayName: `${prefix}-${"ABC"[i]}`,
      visibilityMode: "public",
      acceptTask: "auto",
      allowedTaskTypes: '["scheduling"]',
      sharingPolicy: "result-only",
    });
    result.push(adoption);
  }
  await syncDemoAssistantAssets(
    db,
    result.map(row => row.adoptId)
  );
  return result;
}

// Use the production provisioning/reconciliation path for both new fixtures and
// existing manual-demo assistants. Database rows alone do not install skills.
export async function syncDemoAssistantAssets(
  db: Awaited<ReturnType<typeof localFixtureDatabase>>,
  adoptIds: string[]
) {
  const synced = [];
  for (const adoptId of adoptIds) {
    assert(/^lgj-eval-model-e2e-[0-9a-f]{8}-[012]$/.test(adoptId));
    const [owner] = await db
      .select()
      .from(s.clawAdoptions)
      .where(eq(s.clawAdoptions.adoptId, adoptId));
    assert(
      owner &&
        owner.roleTemplate === "general-assistant" &&
        owner.runtime === "jiuwenswarm" &&
        owner.status === "active"
    );
    const [user] = await db
      .select()
      .from(s.users)
      .where(eq(s.users.id, owner.userId));
    assert(
      user?.name?.startsWith("日程演示用户") ||
        user?.openId === "local-scheduling-e2e-c"
    );
    const role = resolveAgentRoleTemplate(owner.roleTemplate);
    const agentId = resolveRuntimeAgentId(adoptId, String(owner.agentId || ""));
    const effectiveAssets = await resolveEffectiveRoleAssets(role.id);
    assert(
      effectiveAssets.skills.default.includes("scheduling-assistant"),
      "Scheduling reference skill must be deployed through the existing installer first"
    );
    const adapter = getRoleRuntimeAdapter(role.runtime);
    assert(
      owner.permissionProfile === "starter" ||
        owner.permissionProfile === "plus" ||
        owner.permissionProfile === "internal"
    );
    const provision = await adapter.provision({
      adoptId,
      agentId,
      userId: owner.userId,
      permissionProfile: owner.permissionProfile,
      ttlDays: owner.ttlDays,
      role,
      effectiveAssets,
    });
    assert(provision.ok, provision.message);
    const result = await reconcileRoleRuntimeAssets(adapter, {
      adoptId,
      agentId,
      role,
      effectiveAssets,
    });
    assert(result.ok, result.reason);
    await adapter.refreshCapabilities(adoptId, agentId);
    synced.push({ adoptId, changed: result.changed, refreshed: true });
  }
  return synced;
}

export async function cleanupDemoScenario(
  db: Awaited<ReturnType<typeof localFixtureDatabase>>,
  prefix: string,
  adoptIds: string[],
  ownerIds: number[]
) {
  assert(/^model-e2e-[0-9a-f]{8}$/.test(prefix));
  const runs = adoptIds.length
    ? await db
        .select()
        .from(s.collaborationRuns)
        .where(inArray(s.collaborationRuns.adoptId, adoptIds))
    : [];
  if (runs.length) {
    const ids = runs.map(r => r.id);
    await db
      .update(s.collaborationRuns)
      .set({ status: "cancelled", leaseToken: null, leaseUntil: null })
      .where(inArray(s.collaborationRuns.id, ids));
    await db
      .delete(s.collaborationWaits)
      .where(inArray(s.collaborationWaits.runId, ids));
    await db
      .delete(s.collaborationRuns)
      .where(inArray(s.collaborationRuns.id, ids));
  }
  if (adoptIds.length) {
    await db
      .delete(s.clawCollabRequests)
      .where(inArray(s.clawCollabRequests.requesterAdoptId, adoptIds));
    const adoptions = await db
      .select()
      .from(s.clawAdoptions)
      .where(inArray(s.clawAdoptions.adoptId, adoptIds));
    if (adoptions.length)
      await db.delete(s.clawCollabSettings).where(
        inArray(
          s.clawCollabSettings.adoptionId,
          adoptions.map(a => a.id)
        )
      );
    await db
      .delete(s.clawAdoptions)
      .where(inArray(s.clawAdoptions.adoptId, adoptIds));
  }
  const plans = await db
    .select()
    .from(s.calendarCascades)
    .where(
      and(
        inArray(s.calendarCascades.userId, ownerIds),
        eq(s.calendarCascades.title, prefix)
      )
    );
  if (plans.length)
    await db
      .update(s.calendarCascades)
      .set({ stopRequested: true })
      .where(
        inArray(
          s.calendarCascades.id,
          plans.map(p => p.id)
        )
      );
  const meetings = await db
    .select()
    .from(s.calendarMeetings)
    .where(
      and(
        inArray(s.calendarMeetings.creatorUserId, ownerIds),
        like(s.calendarMeetings.payload, `%${prefix}%`)
      )
    );
  // Retain all receipts if remote cancellation fails; never discard unknown writes.
  for (const meeting of meetings) {
    assert(
      meetingPayloadSchema.parse(meeting.payload).event.title.startsWith(prefix)
    );
    await cancelMeeting(meeting.creatorUserId, meeting.id);
  }
  if (plans.length) {
    await db.delete(s.calendarReschedules).where(
      inArray(
        s.calendarReschedules.cascadeId,
        plans.map(p => p.id)
      )
    );
    await db.delete(s.calendarCascades).where(
      inArray(
        s.calendarCascades.id,
        plans.map(p => p.id)
      )
    );
  }
  if (meetings.length)
    await db.delete(s.calendarMeetings).where(
      inArray(
        s.calendarMeetings.id,
        meetings.map(m => m.id)
      )
    );
  const coordinations = await db
    .select()
    .from(s.calendarCoordinations)
    .where(
      and(
        inArray(s.calendarCoordinations.creatorUserId, ownerIds),
        like(s.calendarCoordinations.payload, `%${prefix}%`)
      )
    );
  if (coordinations.length) {
    const ids = coordinations.map(c => c.id);
    await db
      .delete(s.calendarAvailabilityTasks)
      .where(inArray(s.calendarAvailabilityTasks.coordinationId, ids));
    await db
      .delete(s.calendarCoordinations)
      .where(inArray(s.calendarCoordinations.id, ids));
  }
}
