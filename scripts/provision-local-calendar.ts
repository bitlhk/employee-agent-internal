import "dotenv/config";
import { parse } from "dotenv";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import { calendarUrl, readOwnCalendar } from "../server/_core/scheduling/calendar";
import { getCalendarBinding, saveCalendarBinding, setLocalCalendarEmail } from "../server/db/scheduling";
import { closeDbConnection } from "../server/db/connection";

async function main() {
  if (!process.argv.includes("--local")) throw new Error("Explicit --local is required; this provisions local development calendars only");
  const baseUrl = "http://127.0.0.1:8088";
  const deployment = parse(readFileSync("deploy/calendar/nextcloud/.env"));
  const admin = Buffer.from(`${deployment.NEXTCLOUD_ADMIN_USER}:${deployment.NEXTCLOUD_ADMIN_PASSWORD}`).toString("base64");
  process.env.NEXTCLOUD_BASE_URL = baseUrl;
  const credentialFile = process.env.LOCAL_CALENDAR_CREDENTIAL_FILE || "C:/ProgramData/MySQL/EmployeeAgent/calendar-accounts.json";
  const accounts: Record<string, { username: string; password: string }> = existsSync(credentialFile) ? JSON.parse(readFileSync(credentialFile, "utf8")) : {};
  const db = await mysql.createConnection(process.env.DATABASE_URL!);
  try {
    const [users] = await db.query<Array<{ id: number; name: string | null } & mysql.RowDataPacket>>("SELECT id, name FROM users ORDER BY id");
    for (const user of users) {
      const existing = await getCalendarBinding(user.id);
      if (existing) {
        const local = accounts[String(user.id)];
        if (!existing.calendarEmail && local?.username === existing.username) {
          const email = `${existing.username}@calendar.local.invalid`;
          const response = await fetch(`${baseUrl}/ocs/v1.php/cloud/users/${encodeURIComponent(existing.username)}?format=json`, {
            method: "PUT", headers: { authorization: `Basic ${admin}`, "OCS-APIRequest": "true", "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ key: "email", value: email }), redirect: "error", signal: AbortSignal.timeout(15_000),
          });
          const result = await response.json() as { ocs?: { meta?: { statuscode?: number } } };
          if (!response.ok || result.ocs?.meta?.statuscode !== 100) throw new Error("Local invitation address configuration failed");
          await setLocalCalendarEmail(user.id, existing.username, email);
        }
        console.log(`User ${user.id}: existing binding preserved`); continue;
      }
      let account = accounts[String(user.id)];
      if (!account) {
        account = { username: `ea-user-${user.id}`, password: randomBytes(24).toString("hex") };
        const response = await fetch(`${baseUrl}/ocs/v1.php/cloud/users?format=json`, {
          method: "POST", headers: { authorization: `Basic ${admin}`, "OCS-APIRequest": "true", "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ userid: account.username, password: account.password, displayName: user.name || `用户${user.id}`, email: `${account.username}@calendar.local.invalid` }), redirect: "error", signal: AbortSignal.timeout(30_000),
        });
        const body = await response.json() as { ocs?: { meta?: { statuscode?: number } } };
        if (!response.ok || body.ocs?.meta?.statuscode !== 100) throw new Error(`Could not provision local calendar user ${user.id}; existing remote credentials will not be reset`);
        accounts[String(user.id)] = account;
        mkdirSync(path.dirname(credentialFile), { recursive: true });
        writeFileSync(credentialFile, JSON.stringify(accounts, null, 2), { mode: 0o600 });
      }
      const url = calendarUrl(baseUrl, account.username, "personal");
      await fetch(url, { method: "MKCALENDAR", headers: { authorization: `Basic ${Buffer.from(`${account.username}:${account.password}`).toString("base64")}`, "content-type": "application/xml" },
        body: '<c:mkcalendar xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:d="DAV:"><d:set><d:prop><d:displayname>个人日程</d:displayname></d:prop></d:set></c:mkcalendar>', redirect: "error", signal: AbortSignal.timeout(15_000) });
      const credentials = { userId: user.id, username: account.username, calendarName: "personal", appPassword: account.password, writeEnabled: true };
      await readOwnCalendar(user.id, credentials, { start: new Date().toISOString(), end: new Date(Date.now() + 86_400_000).toISOString() });
      await saveCalendarBinding({ ...credentials, enabled: true, discoverable: true, calendarEmail: `${account.username}@calendar.local.invalid` });
      console.log(`User ${user.id}: own calendar provisioned and verified`);
    }
    const envPath = ".env";
    const original = readFileSync(envPath, "utf8");
    const updated = /^NEXTCLOUD_BASE_URL=/m.test(original) ? original.replace(/^NEXTCLOUD_BASE_URL=.*$/m, `NEXTCLOUD_BASE_URL=${baseUrl}`) : `${original.trimEnd()}\nNEXTCLOUD_BASE_URL=${baseUrl}\n`;
    writeFileSync(envPath, updated, { mode: 0o600 });
    console.log("Local calendar configured. Account credentials are saved only in the protected local credential file.");
  } finally { await db.end(); await closeDbConnection(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Local calendar provisioning failed"); process.exitCode = 1; });
