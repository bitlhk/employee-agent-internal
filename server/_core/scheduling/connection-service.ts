import { z } from "zod";
import mysql from "mysql2/promise";
import { TRPCError } from "@trpc/server";
import { calendarBindingSchema } from "../../../shared/scheduling";
import {
  getCalendarBinding,
  saveCalendarBinding,
  revokeCalendarConnection,
  calendarAccountOwner,
} from "../../db/scheduling";
import { calendarUrl, readOwnCalendar } from "./calendar";
import { recordAuditRequired } from "../audit-events";

export const selfConnectionSchema = calendarBindingSchema.omit({
  userId: true,
  enabled: true,
  autoAvailability: true,
  calendarEmail: true,
});
export async function connectOwnCalendar(
  userId: number,
  raw: z.input<typeof selfConnectionSchema>,
  transport: typeof fetch = fetch
) {
  const input = selfConnectionSchema.parse(raw);
  const base = process.env.NEXTCLOUD_BASE_URL;
  if (!base)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "日历系统尚未配置",
    });
  calendarUrl(base, input.username, input.calendarName);
  const owner = await calendarAccountOwner(input.username);
  if (owner !== null && owner !== userId)
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "该日历账号已属于另一个平台用户",
    });
  const response = await transport(
    new URL("ocs/v2.php/cloud/user?format=json", `${base.replace(/\/$/, "")}/`),
    {
      headers: {
        authorization: `Basic ${Buffer.from(`${input.username}:${input.appPassword}`).toString("base64")}`,
        "OCS-APIRequest": "true",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (!response.ok)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "日历账号验证失败，请检查本人账号和应用密码",
    });
  const body = (await response.json()) as {
    ocs?: {
      meta?: { statuscode?: number };
      data?: { id?: string; email?: string };
    };
  };
  if (
    ![100, 200].includes(Number(body.ocs?.meta?.statuscode)) ||
    body.ocs?.data?.id !== input.username
  )
    throw new TRPCError({ code: "FORBIDDEN", message: "日历身份验证不匹配" });
  const now = Date.now();
  await readOwnCalendar(
    userId,
    { userId, ...input },
    {
      start: new Date(now).toISOString(),
      end: new Date(now + 60_000).toISOString(),
    },
    transport
  );
  const connection = await mysql.createConnection(process.env.DATABASE_URL!);
  const lock = `calendar-write:${userId}`;
  let acquired = false;
  try {
    const [rows] = await connection.query<
      Array<{ acquired: number } & mysql.RowDataPacket>
    >("SELECT GET_LOCK(?, 0) AS acquired", [lock]);
    acquired = rows[0]?.acquired === 1;
    if (!acquired)
      throw new TRPCError({
        code: "CONFLICT",
        message: "本人日历正在更新，请稍后连接",
      });
    await recordAuditRequired({
      action: "calendar.connection.authorized",
      actorType: "user",
      actorUserId: userId,
      targetType: "calendar",
      targetId: String(userId),
      metadata: {
        writeEnabled: input.writeEnabled,
        discoverable: input.discoverable,
      },
    });
    try {
      await saveCalendarBinding({
        ...input,
        userId,
        enabled: true,
        autoAvailability: true,
        calendarEmail: body.ocs?.data?.email || "",
      });
    } catch {
      throw new TRPCError({
        code: "CONFLICT",
        message: "连接失败，该日历账号可能已绑定其他平台用户",
      });
    }
  } finally {
    if (acquired)
      await connection
        .query("SELECT RELEASE_LOCK(?)", [lock])
        .catch(() => undefined);
    await connection.end();
  }
  return { connected: true };
}

export async function disconnectOwnCalendar(userId: number) {
  const connection = await mysql.createConnection(process.env.DATABASE_URL!);
  const lock = `calendar-write:${userId}`;
  let acquired = false;
  try {
    const [rows] = await connection.query<
      Array<{ acquired: number } & mysql.RowDataPacket>
    >("SELECT GET_LOCK(?, 0) AS acquired", [lock]);
    acquired = rows[0]?.acquired === 1;
    if (!acquired)
      throw new TRPCError({
        code: "CONFLICT",
        message: "本人日历正在更新，请稍后解除连接",
      });
    await recordAuditRequired({
      action: "calendar.connection.revoked",
      actorType: "user",
      actorUserId: userId,
      targetType: "calendar",
      targetId: String(userId),
    });
    await revokeCalendarConnection(userId);
    return { disconnected: true };
  } finally {
    if (acquired)
      await connection
        .query("SELECT RELEASE_LOCK(?)", [lock])
        .catch(() => undefined);
    await connection.end();
  }
}
export async function ownConnectionInfo(userId: number) {
  const binding = await getCalendarBinding(userId);
  return binding
    ? {
        username: binding.username,
        calendarName: binding.calendarName,
        enabled: binding.enabled,
        writeEnabled: binding.writeEnabled,
        discoverable: binding.discoverable,
      }
    : null;
}
