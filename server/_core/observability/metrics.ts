import { existsSync, statfsSync, statSync } from "node:fs";
import path from "node:path";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const metricsRegistry = new Registry();

collectDefaultMetrics({
  prefix: "ea_",
  register: metricsRegistry,
});

const httpRequests = new Counter({
  name: "ea_http_requests_total",
  help: "HTTP requests completed by the Employee Agent server.",
  labelNames: ["method", "route", "status_class"] as const,
  registers: [metricsRegistry],
});

const httpDuration = new Histogram({
  name: "ea_http_request_duration_seconds",
  help: "HTTP request duration in seconds.",
  labelNames: ["method", "route", "status_class"] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 30, 60, 180, 300],
  registers: [metricsRegistry],
});

const httpInflight = new Gauge({
  name: "ea_http_inflight_requests",
  help: "HTTP requests currently being processed.",
  registers: [metricsRegistry],
});

const readinessChecks = new Counter({
  name: "ea_readiness_checks_total",
  help: "Readiness dependency check outcomes.",
  labelNames: ["dependency", "outcome"] as const,
  registers: [metricsRegistry],
});

const readinessDuration = new Histogram({
  name: "ea_readiness_check_duration_seconds",
  help: "Readiness dependency check duration in seconds.",
  labelNames: ["dependency"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3],
  registers: [metricsRegistry],
});

const filesystemSize = new Gauge({
  name: "ea_filesystem_size_bytes",
  help: "Size of the filesystem containing the application root.",
  registers: [metricsRegistry],
  collect() {
    try {
      const stats = statfsSync(process.env.APP_ROOT || process.cwd());
      this.set(Number(stats.blocks) * Number(stats.bsize));
    } catch {
      this.set(0);
    }
  },
});

const filesystemFree = new Gauge({
  name: "ea_filesystem_free_bytes",
  help: "Free bytes on the filesystem containing the application root.",
  registers: [metricsRegistry],
  collect() {
    try {
      const stats = statfsSync(process.env.APP_ROOT || process.cwd());
      this.set(Number(stats.bavail) * Number(stats.bsize));
    } catch {
      this.set(0);
    }
  },
});

const backupLastSuccess = new Gauge({
  name: "ea_backup_last_success_timestamp_seconds",
  help: "Unix timestamp of the most recent successful local backup.",
  registers: [metricsRegistry],
  collect() {
    const statusFile = String(
      process.env.BACKUP_STATUS_FILE
        || path.join(process.env.BACKUP_DIR || "/root/backups/employee-agent", ".last-local-success"),
    );
    try {
      this.set(existsSync(statusFile) ? statSync(statusFile).mtimeMs / 1000 : 0);
    } catch {
      this.set(0);
    }
  },
});

const backupLastValidation = new Gauge({
  name: "ea_backup_last_validation_timestamp_seconds",
  help: "Unix timestamp of the most recent successfully validated local backup.",
  registers: [metricsRegistry],
  collect() {
    const statusFile = String(
      process.env.BACKUP_VALIDATION_STATUS_FILE
        || path.join(process.env.BACKUP_DIR || "/root/backups/employee-agent", ".last-validated-success"),
    );
    try {
      this.set(existsSync(statusFile) ? statSync(statusFile).mtimeMs / 1000 : 0);
    } catch {
      this.set(0);
    }
  },
});

export type OperationalActivity =
  | "knowledge_search"
  | "knowledge_index"
  | "expert_task"
  | "cron_delivery"
  | "mcp_call"
  | "sandbox_exec";

export type OperationalOutcome = "success" | "empty" | "error" | "timeout" | "cancelled";

const operationalActivityTotal = new Counter({
  name: "ea_operational_activity_total",
  help: "Completed operational activities by bounded activity and outcome.",
  labelNames: ["activity", "outcome"] as const,
  registers: [metricsRegistry],
});

const operationalActivityDuration = new Histogram({
  name: "ea_operational_activity_duration_seconds",
  help: "Operational activity duration in seconds.",
  labelNames: ["activity", "outcome"] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 30, 60, 180, 300, 900],
  registers: [metricsRegistry],
});

const operationalActivityActive = new Gauge({
  name: "ea_operational_activity_active",
  help: "Operational activities currently in progress.",
  labelNames: ["activity"] as const,
  registers: [metricsRegistry],
});

export function beginHttpRequest(): void {
  httpInflight.inc();
}
export function completeHttpRequest(input: {
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
}): void {
  httpInflight.dec();
  const statusClass = `${Math.max(0, Math.floor(input.statusCode / 100))}xx`;
  const labels = {
    method: input.method.slice(0, 16),
    route: input.route.slice(0, 180),
    status_class: statusClass,
  };
  httpRequests.inc(labels);
  httpDuration.observe(labels, Math.max(0, input.durationMs) / 1000);
}

export function observeReadiness(dependency: string, ok: boolean, durationMs: number): void {
  const boundedDependency = dependency.slice(0, 32);
  readinessChecks.inc({ dependency: boundedDependency, outcome: ok ? "ok" : "failed" });
  readinessDuration.observe({ dependency: boundedDependency }, Math.max(0, durationMs) / 1000);
}

export function beginOperationalActivity(activity: OperationalActivity): () => void {
  operationalActivityActive.inc({ activity });
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    operationalActivityActive.dec({ activity });
  };
}

export function observeOperationalActivity(input: {
  activity: OperationalActivity;
  outcome: OperationalOutcome;
  durationMs: number;
}): void {
  const labels = { activity: input.activity, outcome: input.outcome };
  operationalActivityTotal.inc(labels);
  operationalActivityDuration.observe(labels, Math.max(0, input.durationMs) / 1000);
}
