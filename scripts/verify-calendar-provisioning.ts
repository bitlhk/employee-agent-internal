import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import superjson from "superjson";
import { getDb, closeDbConnection } from "../server/db/connection";
import {
  users,
  calendarBindings,
  calendarProvisioning,
} from "../drizzle/schema";
import {
  getCalendarCredentials,
  getCalendarBinding,
} from "../server/db/scheduling";
import { getCalendarProvisioning } from "../server/db/calendar-provisioning";
import { readOwnCalendar } from "../server/_core/scheduling/calendar";
import { sdk, sessionAuthVersion } from "../server/_core/sdk";
import { COOKIE_NAME } from "../shared/const";

async function main() {
  assert(
    process.argv.includes("--local") && process.env.NODE_ENV === "development"
  );
  for (const url of [process.env.NEXTCLOUD_BASE_URL, process.env.DATABASE_URL])
    assert(url && ["127.0.0.1", "localhost"].includes(new URL(url).hostname));
  const db = (await getDb())!;
  const openId = `calendar-test-${randomUUID()}`;
  await db
    .insert(users)
    .values({ openId, name: "日历开通验收", loginMethod: "local-fixture" });
  const [user] = await db.select().from(users).where(eq(users.openId, openId));
  let remoteRemoved = false;
  try {
    const cookie = `${COOKIE_NAME}=${await sdk.signSession({ userId: user.id, name: user.name!, authVersion: sessionAuthVersion(user) }, { expiresInMs: 600_000 })}`;
    const invoke = async () => {
      const response = await fetch(
        "http://127.0.0.1:5174/api/trpc/scheduling.ensureCalendar",
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ json: { userId: 1 } }),
          signal: AbortSignal.timeout(90_000),
        }
      );
      assert(response.ok);
      const body = (await response.json()) as {
        result: { data: ReturnType<typeof superjson.serialize> };
      };
      return superjson.deserialize<{ state: string; managed: boolean }>(
        body.result.data
      );
    };
    const original = await getCalendarBinding(1);
    const results = await Promise.all([invoke(), invoke()]);
    assert(results.some(r => r.state === "ready"));
    assert(results.every(r => ["ready", "retry"].includes(r.state)));
    const binding = (await getCalendarBinding(user.id))!;
    const provision = (await getCalendarProvisioning(user.id))!;
    assert.equal(provision.status, "ready");
    assert.equal(binding.username, provision.username);
    assert.equal(binding.autoAvailability, true);
    assert.equal(binding.discoverable, false);
    assert.equal(binding.writeEnabled, true);
    assert(provision.encryptedPassword.startsWith("enc:v1:"));
    assert.deepEqual(await invoke(), { state: "ready", managed: true });
    assert.equal(
      (await getCalendarBinding(user.id))!.grantId,
      binding.grantId,
      "Repeat entry must not rotate the calendar grant"
    );
    assert.equal(
      (await getCalendarBinding(1))!.grantId,
      original!.grantId,
      "Client-selected userId must be ignored"
    );
    const now = Date.now();
    assert.deepEqual(
      await readOwnCalendar(user.id, (await getCalendarCredentials(user.id))!, {
        start: new Date(now).toISOString(),
        end: new Date(now + 86_400_000).toISOString(),
      }),
      []
    );
    console.log(
      "Real authenticated API + Nextcloud: automatic owner-specific provisioning, concurrent retries, encrypted durable credentials, repeat entry without grant rotation, no cross-owner effects and default privacy passed."
    );
  } finally {
    const provision = await getCalendarProvisioning(user.id);
    if (provision) {
      assert.equal(
        provision.username,
        `${process.env.NEXTCLOUD_ACCOUNT_PREFIX || "employee-agent"}-${user.id}`
      );
      const response = await fetch(
        `${process.env.NEXTCLOUD_BASE_URL}/ocs/v1.php/cloud/users/${encodeURIComponent(provision.username)}?format=json`,
        {
          method: "DELETE",
          headers: {
            authorization: `Basic ${Buffer.from(`${process.env.NEXTCLOUD_PROVISION_USERNAME}:${process.env.NEXTCLOUD_PROVISION_PASSWORD}`).toString("base64")}`,
            "OCS-APIRequest": "true",
          },
          signal: AbortSignal.timeout(30_000),
        }
      );
      const result = (await response.json()) as {
        ocs?: { meta?: { statuscode?: number } };
      };
      remoteRemoved = response.ok && result.ocs?.meta?.statuscode === 100;
      assert(
        remoteRemoved,
        "Keep provisioning receipts if provider cleanup cannot be confirmed"
      );
      await db
        .delete(calendarBindings)
        .where(eq(calendarBindings.userId, user.id));
      await db
        .delete(calendarProvisioning)
        .where(eq(calendarProvisioning.userId, user.id));
    }
    if (!provision || remoteRemoved)
      await db.delete(users).where(eq(users.id, user.id));
    console.log("Disposable provisioning fixture cleaned");
  }
}
main()
  .catch(error => {
    console.error(
      error instanceof Error ? error.message : "Provisioning acceptance failed"
    );
    process.exitCode = 1;
  })
  .finally(closeDbConnection);
