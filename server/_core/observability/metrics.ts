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

const serverLifecycleState = new Gauge({
  name: "ea_server_lifecycle_state",
  help: "Current server lifecycle state as a one-hot gauge.",
  labelNames: ["state"] as const,
  registers: [metricsRegistry],
});

const serverTrackedRequests = new Gauge({
  name: "ea_server_tracked_requests",
  help: "Non-operational HTTP requests tracked for graceful shutdown.",
  registers: [metricsRegistry],
});

const serverDrainTotal = new Counter({
  name: "ea_server_drain_total",
  help: "Graceful server drain attempts by outcome.",
  labelNames: ["outcome"] as const,
  registers: [metricsRegistry],
});

const capacityActive = new Gauge({
  name: "ea_capacity_active",
  help: "Active work held in each bounded capacity lane.",
  labelNames: ["lane"] as const,
  registers: [metricsRegistry],
});

const capacityLimit = new Gauge({
  name: "ea_capacity_limit",
  help: "Configured limit for each bounded capacity lane.",
  labelNames: ["lane"] as const,
  registers: [metricsRegistry],
});

const capacityRejections = new Counter({
  name: "ea_capacity_rejections_total",
  help: "Requests rejected because a bounded capacity lane was full.",
  labelNames: ["lane"] as const,
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

export type ChatRuntime = "jiuwenswarm" | "openclaw";
export type ChatOutcome = "success" | "error" | "timeout" | "cancelled";
export type McpKind = "platform" | "custom";
export type BackgroundWorkerName =
  | "log_retention"
  | "cron_delivery"
  | "agent_health"
  | "agent_memory"
  | "knowledge_recovery"
  | "audit_dlq"
  | "recycler";
export type BackgroundWorkerState = "running" | "stopping" | "stopped" | "failed";

const chatRequests = new Counter({
  name: "ea_chat_requests_total",
  help: "Completed chat requests by runtime and outcome.",
  labelNames: ["runtime", "outcome"] as const,
  registers: [metricsRegistry],
});

const chatDuration = new Histogram({
  name: "ea_chat_request_duration_seconds",
  help: "End-to-end chat request duration in seconds.",
  labelNames: ["runtime", "outcome"] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 180, 300],
  registers: [metricsRegistry],
});

const chatFirstToken = new Histogram({
  name: "ea_chat_first_token_duration_seconds",
  help: "Chat time to first visible token in seconds.",
  labelNames: ["runtime"] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120],
  registers: [metricsRegistry],
});

const chatActive = new Gauge({
  name: "ea_chat_active_requests",
  help: "Chat requests currently in progress by runtime.",
  labelNames: ["runtime"] as const,
  registers: [metricsRegistry],
});

const runtimeCalls = new Counter({
  name: "ea_runtime_calls_total",
  help: "Completed Agent runtime calls by runtime and outcome.",
  labelNames: ["runtime", "outcome"] as const,
  registers: [metricsRegistry],
});

const runtimeDuration = new Histogram({
  name: "ea_runtime_call_duration_seconds",
  help: "Agent runtime call duration in seconds.",
  labelNames: ["runtime", "outcome"] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 180, 300],
  registers: [metricsRegistry],
});

const runtimeActive = new Gauge({
  name: "ea_runtime_active_calls",
  help: "Agent runtime calls currently in progress.",
  labelNames: ["runtime"] as const,
  registers: [metricsRegistry],
});

const mcpCalls = new Counter({
  name: "ea_mcp_calls_total",
  help: "Completed MCP tool calls by bounded MCP kind and outcome.",
  labelNames: ["kind", "outcome"] as const,
  registers: [metricsRegistry],
});

const mcpDuration = new Histogram({
  name: "ea_mcp_call_duration_seconds",
  help: "MCP tool call duration in seconds.",
  labelNames: ["kind", "outcome"] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 30, 60, 180, 300],
  registers: [metricsRegistry],
});

const mcpActive = new Gauge({
  name: "ea_mcp_active_calls",
  help: "MCP tool calls currently in progress by bounded MCP kind.",
  labelNames: ["kind"] as const,
  registers: [metricsRegistry],
});

const sandboxExecutions = new Counter({
  name: "ea_sandbox_executions_total",
  help: "Completed sandbox executions by outcome.",
  labelNames: ["outcome"] as const,
  registers: [metricsRegistry],
});

const sandboxDuration = new Histogram({
  name: "ea_sandbox_execution_duration_seconds",
  help: "Sandbox execution duration in seconds.",
  labelNames: ["outcome"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [metricsRegistry],
});

const sandboxActive = new Gauge({
  name: "ea_sandbox_active_executions",
  help: "Sandbox executions currently in progress.",
  registers: [metricsRegistry],
});

const dbPoolConnections = new Gauge({
  name: "ea_db_pool_connections",
  help: "Database pool connection counts by bounded state.",
  labelNames: ["state"] as const,
  registers: [metricsRegistry],
});

const dbPoolLimit = new Gauge({
  name: "ea_db_pool_limit",
  help: "Configured database pool limits.",
  labelNames: ["kind"] as const,
  registers: [metricsRegistry],
});

const dbPoolEvents = new Counter({
  name: "ea_db_pool_events_total",
  help: "Database pool pressure and error events.",
  labelNames: ["event"] as const,
  registers: [metricsRegistry],
});
let dbPoolActiveCount = 0;

const backgroundWorkerState = new Gauge({
  name: "ea_background_worker_state",
  help: "Background worker state as a one-hot gauge.",
  labelNames: ["worker", "state"] as const,
  registers: [metricsRegistry],
});

const backgroundWorkerStops = new Counter({
  name: "ea_background_worker_stops_total",
  help: "Background worker stop attempts by outcome.",
  labelNames: ["worker", "outcome"] as const,
  registers: [metricsRegistry],
});

const backgroundWorkerStopDuration = new Histogram({
  name: "ea_background_worker_stop_duration_seconds",
  help: "Background worker stop duration in seconds.",
  labelNames: ["worker", "outcome"] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
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

export type ServerLifecycleState = "starting" | "ready" | "draining";

export function setServerLifecycleState(state: ServerLifecycleState): void {
  for (const candidate of ["starting", "ready", "draining"] as const) {
    serverLifecycleState.set({ state: candidate }, candidate === state ? 1 : 0);
  }
}

export function setServerTrackedRequests(active: number): void {
  serverTrackedRequests.set(Math.max(0, active));
}

export function observeServerDrain(outcome: "completed" | "timed_out"): void {
  serverDrainTotal.inc({ outcome });
}

export function setCapacityLane(lane: string, active: number, limit: number): void {
  const boundedLane = lane.slice(0, 32);
  capacityActive.set({ lane: boundedLane }, Math.max(0, active));
  capacityLimit.set({ lane: boundedLane }, Math.max(0, limit));
}

export function observeCapacityRejection(lane: string): void {
  capacityRejections.inc({ lane: lane.slice(0, 32) });
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

export function beginChatRequest(runtime: ChatRuntime): {
  observeFirstToken: () => void;
  finish: (outcome: ChatOutcome) => void;
} {
  const startedAt = Date.now();
  let firstTokenObserved = false;
  let finished = false;
  chatActive.inc({ runtime });
  return {
    observeFirstToken() {
      if (firstTokenObserved || finished) return;
      firstTokenObserved = true;
      chatFirstToken.observe({ runtime }, Math.max(0, Date.now() - startedAt) / 1000);
    },
    finish(outcome) {
      if (finished) return;
      finished = true;
      chatActive.dec({ runtime });
      const labels = { runtime, outcome };
      chatRequests.inc(labels);
      chatDuration.observe(labels, Math.max(0, Date.now() - startedAt) / 1000);
    },
  };
}

export function beginMcpCall(kind: McpKind): (outcome: OperationalOutcome) => void {
  const startedAt = Date.now();
  let finished = false;
  mcpActive.inc({ kind });
  return (outcome) => {
    if (finished) return;
    finished = true;
    mcpActive.dec({ kind });
    const labels = { kind, outcome };
    mcpCalls.inc(labels);
    mcpDuration.observe(labels, Math.max(0, Date.now() - startedAt) / 1000);
  };
}

export function beginRuntimeCall(runtime: ChatRuntime): (outcome: ChatOutcome) => void {
  const startedAt = Date.now();
  let finished = false;
  runtimeActive.inc({ runtime });
  return (outcome) => {
    if (finished) return;
    finished = true;
    runtimeActive.dec({ runtime });
    const labels = { runtime, outcome };
    runtimeCalls.inc(labels);
    runtimeDuration.observe(labels, Math.max(0, Date.now() - startedAt) / 1000);
  };
}

export function beginSandboxExecution(): (outcome: OperationalOutcome, durationMs?: number) => void {
  const startedAt = Date.now();
  let finished = false;
  sandboxActive.inc();
  return (outcome, durationMs) => {
    if (finished) return;
    finished = true;
    sandboxActive.dec();
    sandboxExecutions.inc({ outcome });
    sandboxDuration.observe({ outcome }, Math.max(0, durationMs ?? Date.now() - startedAt) / 1000);
  };
}

export function configureDbPoolMetrics(input: { connectionLimit: number; maxIdle: number; queueLimit: number }): void {
  dbPoolLimit.set({ kind: "connections" }, Math.max(0, input.connectionLimit));
  dbPoolLimit.set({ kind: "max_idle" }, Math.max(0, input.maxIdle));
  dbPoolLimit.set({ kind: "queue" }, Math.max(0, input.queueLimit));
  dbPoolActiveCount = 0;
  dbPoolConnections.set({ state: "active" }, dbPoolActiveCount);
}

export function observeDbPoolEvent(event: "connection" | "acquire" | "release" | "enqueue" | "error"): void {
  dbPoolEvents.inc({ event });
  if (event === "acquire") dbPoolActiveCount += 1;
  if (event === "release") dbPoolActiveCount = Math.max(0, dbPoolActiveCount - 1);
  if (event === "acquire" || event === "release") {
    dbPoolConnections.set({ state: "active" }, dbPoolActiveCount);
  }
}

export function resetDbPoolMetrics(): void {
  dbPoolActiveCount = 0;
  dbPoolConnections.set({ state: "active" }, dbPoolActiveCount);
}

export function setBackgroundWorkerState(worker: BackgroundWorkerName, state: BackgroundWorkerState): void {
  for (const candidate of ["running", "stopping", "stopped", "failed"] as const) {
    backgroundWorkerState.set({ worker, state: candidate }, candidate === state ? 1 : 0);
  }
}

export function observeBackgroundWorkerStop(
  worker: BackgroundWorkerName,
  outcome: "success" | "error",
  durationMs: number,
): void {
  const labels = { worker, outcome };
  backgroundWorkerStops.inc(labels);
  backgroundWorkerStopDuration.observe(labels, Math.max(0, durationMs) / 1000);
}
