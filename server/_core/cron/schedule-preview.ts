import { Cron } from "croner";
import type {
  CronSchedule,
  PreviewRunsRequest,
  PreviewRunsResponse,
} from "@shared/types/cron";

function defaultTimezone() {
  return process.env.TZ || "Asia/Shanghai";
}

function previewOnce(schedule: Extract<CronSchedule, { kind: "once" }>, now: Date) {
  const run = new Date(schedule.runAt);
  return Number.isFinite(run.getTime()) && run.getTime() > now.getTime() ? [run] : [];
}

function previewInterval(
  schedule: Extract<CronSchedule, { kind: "interval" }>,
  now: Date,
  count: number,
) {
  const runs: Date[] = [];
  const stepMs = schedule.intervalMinutes * 60_000;
  let cursor = new Date(now.getTime() + stepMs);
  for (let index = 0; index < count; index += 1) {
    runs.push(cursor);
    cursor = new Date(cursor.getTime() + stepMs);
  }
  return runs;
}

function previewCron(
  schedule: Extract<CronSchedule, { kind: "cron" }>,
  timezone: string,
  count: number,
) {
  const cron = new Cron(schedule.cronExpr, { timezone, paused: true });
  return cron.nextRuns(count).map((value) => value instanceof Date ? value : new Date(value));
}

export function computePreviewRuns(
  request: PreviewRunsRequest,
  now = new Date(),
): PreviewRunsResponse {
  const count = Math.max(1, Math.min(20, Number(request.count || 5)));
  const timezone = request.timezone || defaultTimezone();
  let dates: Date[];
  if (request.schedule.kind === "once") {
    dates = previewOnce(request.schedule, now).slice(0, count);
  } else if (request.schedule.kind === "interval") {
    dates = previewInterval(request.schedule, now, count);
  } else {
    dates = previewCron(request.schedule, timezone, count);
  }
  const wakeOffsetMs = Number(request.wakeOffsetSeconds || 0) * 1000;
  return {
    runs: dates.map((runAt) => ({
      runAt: runAt.toISOString(),
      ...(wakeOffsetMs > 0
        ? { wakeAt: new Date(runAt.getTime() - wakeOffsetMs).toISOString() }
        : {}),
    })),
  };
}
