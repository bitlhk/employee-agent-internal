import { sql } from "drizzle-orm";
import { getDb } from "./connection";

export type InstallEventType = "command_copied" | "downloaded" | "started" | "succeeded" | "failed";

export type RecordInstallEventInput = {
  installId: string;
  eventType: InstallEventType;
  stage?: string;
  source?: string;
  installerVersion?: string;
  osType?: string;
  arch?: string;
  mirror?: string;
  durationMs?: number;
};

function rowsFromResult(result: unknown): any[] {
  return Array.isArray(result) ? (Array.isArray(result[0]) ? result[0] : result) : [];
}

export async function recordInstallEvent(input: RecordInstallEventInput): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.execute(sql`
    INSERT INTO install_events (
      install_id, event_type, stage, source, installer_version, os_type, arch, mirror, duration_ms
    ) VALUES (
      ${input.installId}, ${input.eventType}, ${input.stage || null}, ${input.source || "bootstrap"},
      ${input.installerVersion || null}, ${input.osType || null}, ${input.arch || null},
      ${input.mirror || null}, ${input.durationMs ?? null}
    )
    ON DUPLICATE KEY UPDATE
      stage = VALUES(stage),
      source = VALUES(source),
      installer_version = VALUES(installer_version),
      os_type = VALUES(os_type),
      arch = VALUES(arch),
      mirror = VALUES(mirror),
      duration_ms = VALUES(duration_ms)
  `);
}

export async function getInstallTelemetrySummary() {
  const db = await getDb();
  if (!db) throw new Error("DB not available");

  const totalsResult: any = await db.execute(sql`
    SELECT
      SUM(event_type = 'command_copied') AS command_copied,
      SUM(event_type = 'downloaded') AS downloaded,
      SUM(event_type = 'started') AS started,
      SUM(event_type = 'succeeded') AS succeeded,
      SUM(event_type = 'failed') AS failed,
      SUM(event_type = 'succeeded' AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS succeeded_30d
    FROM install_events
  `);
  const totals = rowsFromResult(totalsResult)[0] || {};

  const dailyResult: any = await db.execute(sql`
    SELECT
      DATE(created_at) AS day,
      SUM(event_type = 'downloaded') AS downloaded,
      SUM(event_type = 'started') AS started,
      SUM(event_type = 'succeeded') AS succeeded,
      SUM(event_type = 'failed') AS failed
    FROM install_events
    WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
    GROUP BY DATE(created_at)
    ORDER BY day ASC
  `);

  const failuresResult: any = await db.execute(sql`
    SELECT COALESCE(stage, 'unknown') AS stage, COUNT(*) AS count
    FROM install_events
    WHERE event_type = 'failed'
    GROUP BY COALESCE(stage, 'unknown')
    ORDER BY count DESC
    LIMIT 8
  `);

  const started = Number(totals.started || 0);
  const succeeded = Number(totals.succeeded || 0);
  return {
    summary: {
      commandCopied: Number(totals.command_copied || 0),
      downloaded: Number(totals.downloaded || 0),
      started,
      succeeded,
      failed: Number(totals.failed || 0),
      succeeded30d: Number(totals.succeeded_30d || 0),
      successRate: started > 0 ? Math.round((succeeded / started) * 1000) / 10 : 0,
    },
    daily: rowsFromResult(dailyResult).map((row) => ({
      date: String(row.day instanceof Date ? row.day.toISOString().slice(0, 10) : row.day || "").slice(0, 10),
      downloaded: Number(row.downloaded || 0),
      started: Number(row.started || 0),
      succeeded: Number(row.succeeded || 0),
      failed: Number(row.failed || 0),
    })),
    failureStages: rowsFromResult(failuresResult).map((row) => ({
      stage: String(row.stage || "unknown"),
      count: Number(row.count || 0),
    })),
  };
}
