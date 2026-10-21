import mysql from "mysql2/promise";
import { randomBytes } from "node:crypto";
import { getUserById } from "../../db";
import { getCalendarBinding, saveCalendarBinding } from "../../db/scheduling";
import {
  getCalendarProvisioning,
  saveCalendarProvisioning,
  setCalendarProvisioningStatus,
} from "../../db/calendar-provisioning";
import { encryptSecret, decryptSecret } from "../secret-protection";
import { calendarUrl, readOwnCalendar } from "./calendar";
import { recordAuditRequired } from "../audit-events";

export type CalendarServiceState = {
  state: "ready" | "disabled" | "not_configured" | "retry";
  managed: boolean;
};

export async function ensureOwnCalendar(
  userId: number,
  transport: typeof fetch = fetch
): Promise<CalendarServiceState> {
  const existing = await getCalendarBinding(userId);
  if (existing)
    return {
      state: existing.enabled ? "ready" : "disabled",
      managed:
        (await getCalendarProvisioning(userId))?.username === existing.username,
    };
  const base = process.env.NEXTCLOUD_BASE_URL;
  const adminUser = process.env.NEXTCLOUD_PROVISION_USERNAME;
  const adminPassword = process.env.NEXTCLOUD_PROVISION_PASSWORD;
  if (
    process.env.NEXTCLOUD_AUTO_PROVISION !== "true" ||
    !base ||
    !adminUser ||
    !adminPassword
  )
    return { state: "not_configured", managed: false };
  // Validate transport policy before even sending administrator credentials.
  calendarUrl(base, "validation", "personal");
  const prefix = process.env.NEXTCLOUD_ACCOUNT_PREFIX || "employee-agent";
  if (!/^[a-z0-9-]{1,60}$/.test(prefix))
    throw new Error("Invalid calendar account prefix");
  const connection = await mysql.createConnection(process.env.DATABASE_URL!);
  const lock = `calendar-write:${userId}`;
  let acquired = false;
  try {
    const [rows] = await connection.query<
      Array<{ acquired: number } & mysql.RowDataPacket>
    >("SELECT GET_LOCK(?, 0) AS acquired", [lock]);
    acquired = rows[0]?.acquired === 1;
    if (!acquired) return { state: "retry", managed: true };
    const binding = await getCalendarBinding(userId);
    if (binding)
      return { state: binding.enabled ? "ready" : "disabled", managed: false };
    const user = await getUserById(userId);
    if (!user) throw new Error("User unavailable");
    const saved = await saveCalendarProvisioning({
      userId,
      username: `${prefix}-${userId}`,
      encryptedPassword: encryptSecret(randomBytes(32).toString("base64url"), {
        maxStoredLength: null,
      }),
    });
    const password = decryptSecret(saved.encryptedPassword);
    const ownHeaders = {
      authorization: `Basic ${Buffer.from(`${saved.username}:${password}`).toString("base64")}`,
      "OCS-APIRequest": "true",
    };
    const who = () =>
      transport(
        new URL(
          "ocs/v2.php/cloud/user?format=json",
          `${base.replace(/\/$/, "")}/`
        ),
        {
          headers: ownHeaders,
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        }
      );
    let identity = await who();
    if (identity.status === 401 || identity.status === 404) {
      await recordAuditRequired({
        action: "calendar.provision.requested",
        actorType: "user",
        actorUserId: userId,
        targetType: "calendar",
        targetId: String(userId),
      });
      await setCalendarProvisioningStatus(userId, "creating");
      const created = await transport(
        new URL(
          "ocs/v1.php/cloud/users?format=json",
          `${base.replace(/\/$/, "")}/`
        ),
        {
          method: "POST",
          headers: {
            authorization: `Basic ${Buffer.from(`${adminUser}:${adminPassword}`).toString("base64")}`,
            "OCS-APIRequest": "true",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            userid: saved.username,
            password,
            displayName: user.name || "个人日历",
            email: `${saved.username}@calendar.local.invalid`,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        }
      );
      // Even a duplicate/ambiguous creation must prove ownership with the
      // previously persisted credentials. Never reset another account.
      await created.body?.cancel();
      identity = await who();
    }
    if (!identity.ok) throw new Error("Calendar identity unavailable");
    const body = (await identity.json()) as {
      ocs?: {
        data?: { id?: string; email?: string };
        meta?: { statuscode?: number };
      };
    };
    if (
      body.ocs?.data?.id !== saved.username ||
      ![100, 200].includes(Number(body.ocs?.meta?.statuscode))
    )
      throw new Error("Calendar identity mismatch");
    const calendar = await transport(
      calendarUrl(base, saved.username, "personal"),
      {
        method: "MKCALENDAR",
        headers: { ...ownHeaders, "content-type": "application/xml" },
        body: '<c:mkcalendar xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:d="DAV:"><d:set><d:prop><d:displayname>我的日历</d:displayname></d:prop></d:set></c:mkcalendar>',
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (![201, 405].includes(calendar.status))
      throw new Error("Calendar creation unavailable");
    const credentials = {
      userId,
      username: saved.username,
      calendarName: "personal",
      appPassword: password,
      writeEnabled: true,
    };
    await readOwnCalendar(
      userId,
      credentials,
      {
        start: new Date().toISOString(),
        end: new Date(Date.now() + 60_000).toISOString(),
      },
      transport
    );
    await recordAuditRequired({
      action: "calendar.provision.completed",
      actorType: "user",
      actorUserId: userId,
      targetType: "calendar",
      targetId: String(userId),
    });
    await saveCalendarBinding({
      ...credentials,
      enabled: true,
      discoverable: false,
      autoAvailability: true,
      calendarEmail: body.ocs.data.email || "",
    });
    await setCalendarProvisioningStatus(userId, "ready");
    return { state: "ready", managed: true };
  } catch {
    // Only a safe state reaches the browser; no provider error/credentials.
    if (await getCalendarProvisioning(userId))
      await setCalendarProvisioningStatus(userId, "failed");
    return { state: "retry", managed: true };
  } finally {
    if (acquired)
      await connection
        .query("SELECT RELEASE_LOCK(?)", [lock])
        .catch(() => undefined);
    await connection.end();
  }
}
