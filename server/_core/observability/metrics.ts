import { existsSync, readFileSync, statfsSync, statSync } from "node:fs";
import path from "node:path";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import {
  parseReleaseEvidence,
  parseRestoreDrillEvidence,
} from "./operational-evidence";

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

const capacityQueued = new Gauge({
  name: "ea_capacity_queued",
  help: "Requests waiting in a bounded capacity lane queue.",
  labelNames: ["lane"] as const,
  registers: [metricsRegistry],
});

const capacityQueueLimit = new Gauge({
  name: "ea_capacity_queue_limit",
  help: "Configured waiting queue limit for a bounded capacity lane.",
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

function deploymentLogPath(): string {
  return String(
    process.env.EA_DEPLOYMENT_LOG_FILE
      || path.join(process.env.EA_DEPLOY_ROOT || "/opt/employee-agent", "deployments.log"),
  );
}

function restoreDrillStatusPath(): string {
  return String(
    process.env.RESTORE_DRILL_STATUS_FILE
      || path.join(
        process.env.RESTORE_DRILL_ROOT || "/var/lib/employee-agent-restore-drills",
        ".last-success-report",
      ),
  );
}

const releaseEvents30d = new Gauge({
  name: "ea_release_events_30d",
  help: "Release control events observed in the last 30 days.",
  labelNames: ["action", "result"] as const,
  registers: [metricsRegistry],
  collect() {
    this.reset();
    try {
      const rows = parseReleaseEvidence(readFileSync(deploymentLogPath(), "utf8"));
      const counts = new Map<string, number>();
      for (const row of rows) {
        const key = `${row.action}:${row.result}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      for (const action of ["prepare", "deploy", "rollback"] as const) {
        for (const result of ["success", "failed"] as const) {
          this.set({ action, result }, counts.get(`${action}:${result}`) || 0);
        }
      }
    } catch {
      for (const action of ["prepare", "deploy", "rollback"] as const) {
        for (const result of ["success", "failed"] as const) this.set({ action, result }, 0);
      }
    }
  },
});

const releaseLastEvent = new Gauge({
  name: "ea_release_last_event_timestamp_seconds",
  help: "Unix timestamp of the most recent release control event.",
  labelNames: ["action", "result"] as const,
  registers: [metricsRegistry],
  collect() {
    this.reset();
    try {
      const rows = parseReleaseEvidence(readFileSync(deploymentLogPath(), "utf8"));
      const latest = new Map<string, number>();
      for (const row of rows) {
        const key = `${row.action}:${row.result}`;
        latest.set(key, Math.max(latest.get(key) || 0, row.timestampSeconds));
      }
      for (const [key, timestampSeconds] of latest) {
        const [action, result] = key.split(":") as [
          "prepare" | "deploy" | "rollback",
          "success" | "failed",
        ];
        this.set({ action, result }, timestampSeconds);
      }
    } catch {
      // Missing deployment evidence is represented by an absent series.
    }
  },
});

const restoreDrillLastSuccess = new Gauge({
  name: "ea_restore_drill_last_success_timestamp_seconds",
  help: "Unix timestamp of the most recent successful isolated restore drill.",
  registers: [metricsRegistry],
  collect() {
    try {
      const statusFile = restoreDrillStatusPath();
      const evidence = parseRestoreDrillEvidence(readFileSync(statusFile, "utf8"));
      this.set(evidence ? statSync(statusFile).mtimeMs / 1_000 : 0);
    } catch {
      this.set(0);
    }
  },
});

const restoreDrillRpo = new Gauge({
  name: "ea_restore_drill_rpo_seconds",
  help: "RPO measured by the most recent successful isolated restore drill.",
  registers: [metricsRegistry],
  collect() {
    try {
      this.set(parseRestoreDrillEvidence(readFileSync(restoreDrillStatusPath(), "utf8"))?.rpoSeconds || 0);
    } catch {
      this.set(0);
    }
  },
});

const restoreDrillRto = new Gauge({
  name: "ea_restore_drill_rto_seconds",
  help: "RTO measured by the most recent successful isolated restore drill.",
  registers: [metricsRegistry],
  collect() {
    try {
      this.set(parseRestoreDrillEvidence(readFileSync(restoreDrillStatusPath(), "utf8"))?.rtoSeconds || 0);
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

export type ChatRuntime = "jiuwenswarm";
export type ChatOutcome = "success" | "error" | "timeout" | "cancelled";
export type McpKind = "platform" | "custom" | "enterprise";
export type BackgroundWorkerName =
  | "log_retention"
  | "agent_health"
  | "agent_memory"
  | "agent_tasks"
  | "knowledge_recovery"
  | "audit_dlq"
  | "tool_audit"
  | "public_health"
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

const mcpStatusCacheRequests = new Counter({
  name: "ea_mcp_status_cache_requests_total",
  help: "MCP status response cache lookups by bounded outcome.",
  labelNames: ["outcome"] as const,
  registers: [metricsRegistry],
});

const searchToolCalls = new Counter({
  name: "ea_search_tool_calls_total",
  help: "Completed external search tool calls by bounded outcome.",
  labelNames: ["outcome"] as const,
  registers: [metricsRegistry],
});

const searchToolDuration = new Histogram({
  name: "ea_search_tool_duration_seconds",
  help: "External search tool call duration in seconds.",
  labelNames: ["outcome"] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60],
  registers: [metricsRegistry],
});

const searchResultOptimizations = new Counter({
  name: "ea_search_result_optimizations_total",
  help: "Search tool results compacted before model continuation.",
  registers: [metricsRegistry],
});

const searchResultChars = new Histogram({
  name: "ea_search_result_chars",
  help: "Search result size before and after runtime compaction.",
  labelNames: ["stage"] as const,
  buckets: [500, 1000, 2000, 4000, 6000, 9000, 12000, 20000, 40000, 80000, 160000],
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

const skillWorkActive = new Gauge({
  name: "ea_skill_work_active",
  help: "Active bounded Skill preparation work by lane.",
  labelNames: ["lane"] as const,
  registers: [metricsRegistry],
});

const skillWorkQueued = new Gauge({
  name: "ea_skill_work_queued",
  help: "Queued bounded Skill preparation work by lane.",
  labelNames: ["lane"] as const,
  registers: [metricsRegistry],
});

const skillWorkLimit = new Gauge({
  name: "ea_skill_work_limit",
  help: "Configured active and queued limits for Skill preparation work.",
  labelNames: ["lane", "kind"] as const,
  registers: [metricsRegistry],
});

const skillWorkTotal = new Counter({
  name: "ea_skill_work_total",
  help: "Completed Skill preparation work by lane and outcome.",
  labelNames: ["lane", "outcome"] as const,
  registers: [metricsRegistry],
});

const skillWorkDuration = new Histogram({
  name: "ea_skill_work_duration_seconds",
  help: "Queued plus execution duration for Skill preparation work.",
  labelNames: ["lane", "outcome"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120],
  registers: [metricsRegistry],
});

const skillWorkRejections = new Counter({
  name: "ea_skill_work_rejections_total",
  help: "Skill preparation requests rejected because a bounded queue was full.",
  labelNames: ["lane"] as const,
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

const publicHealthComponentStatus = new Gauge({
  name: "ea_public_health_component_status",
  help: "Public health component status as a one-hot gauge.",
  labelNames: ["component", "status"] as const,
  registers: [metricsRegistry],
});

const memoryRetrievals = new Counter({
  name: "ea_memory_retrieval_total",
  help: "Managed memory retrieval attempts by bounded outcome.",
  labelNames: ["outcome"] as const,
  registers: [metricsRegistry],
});

const memoryRetrievalDuration = new Histogram({
  name: "ea_memory_retrieval_duration_seconds",
  help: "Managed memory retrieval duration in seconds.",
  labelNames: ["outcome"] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [metricsRegistry],
});

const memoryRetrievalSelected = new Histogram({
  name: "ea_memory_retrieval_selected_items",
  help: "Number of managed memory items selected per retrieval.",
  buckets: [0, 1, 2, 3, 4, 6, 8, 12],
  registers: [metricsRegistry],
});

const memoryConflicts = new Counter({
  name: "ea_memory_conflicts_total",
  help: "Managed memory conflict events by action.",
  labelNames: ["action"] as const,
  registers: [metricsRegistry],
});

const capabilityPreflight = new Counter({
  name: "ea_capability_preflight_total",
  help: "Capability preflight outcomes by bounded capability kind.",
  labelNames: ["kind", "outcome"] as const,
  registers: [metricsRegistry],
});

const agentTaskRetries = new Counter({
  name: "ea_agent_task_retries_total",
  help: "Agent task retry requests by bounded outcome.",
  labelNames: ["outcome"] as const,
  registers: [metricsRegistry],
});

const governanceDecisions = new Counter({
  name: "ea_governance_decisions_total",
  help: "Deterministic governance decisions by bounded capability and effect.",
  labelNames: ["capability", "effect"] as const,
  registers: [metricsRegistry],
});

const governanceApprovalTransitions = new Counter({
  name: "ea_governance_approval_transitions_total",
  help: "Durable governance approval state transitions by bounded transition and outcome.",
  labelNames: ["transition", "outcome"] as const,
  registers: [metricsRegistry],
});

const governancePepCapabilities = new Gauge({
  name: "ea_governance_pep_capabilities",
  help: "Active side-effect capabilities by deterministic PEP coverage state.",
  labelNames: ["coverage"] as const,
  registers: [metricsRegistry],
});

const governancePepCoverageRatio = new Gauge({
  name: "ea_governance_pep_coverage_ratio",
  help: "Ratio of active side-effect capabilities with deterministic fail-close PEP coverage.",
  registers: [metricsRegistry],
});

const runtimeGovernanceAttested = new Gauge({
  name: "ea_runtime_governance_attested",
  help: "Whether an Agent runtime recently proved that its governance hook is active.",
  labelNames: ["runtime"] as const,
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

export function setCapacityQueue(lane: string, queued: number, limit: number): void {
  const boundedLane = lane.slice(0, 32);
  capacityQueued.set({ lane: boundedLane }, Math.max(0, queued));
  capacityQueueLimit.set({ lane: boundedLane }, Math.max(0, limit));
}

export function observeMemoryRetrieval(input: {
  outcome: "selected" | "empty" | "disabled" | "error";
  durationMs: number;
  selectedCount?: number;
}): void {
  memoryRetrievals.inc({ outcome: input.outcome });
  memoryRetrievalDuration.observe({ outcome: input.outcome }, Math.max(0, input.durationMs) / 1000);
  memoryRetrievalSelected.observe(Math.max(0, input.selectedCount || 0));
}

export function observeMemoryConflict(action: "detected" | "accepted" | "rejected"): void {
  memoryConflicts.inc({ action });
}

export function observeCapabilityPreflight(input: {
  kind: "model" | "skill" | "connector" | "expert" | "knowledge";
  outcome: "ready" | "blocked" | "unchecked";
}): void {
  capabilityPreflight.inc(input);
}

export function observeAgentTaskRetry(outcome: "created" | "blocked" | "error"): void {
  agentTaskRetries.inc({ outcome });
}

export function observeGovernanceDecision(input: {
  capabilityId: string;
  effect: "ALLOW" | "DENY" | "REQUIRE_APPROVAL";
}): void {
  governanceDecisions.inc({
    capability: input.capabilityId.slice(0, 64),
    effect: input.effect.toLowerCase(),
  });
}

export function observeGovernanceApprovalTransition(
  transition: "created" | "reused" | "approved" | "rejected" | "consumed" | "consume_conflict",
  outcome: "success" | "failed" = "success",
): void {
  governanceApprovalTransitions.inc({ transition, outcome });
}

export function setGovernancePepCoverage(input: { total: number; covered: number }): void {
  const total = Math.max(0, input.total);
  const covered = Math.min(total, Math.max(0, input.covered));
  governancePepCapabilities.set({ coverage: "covered" }, covered);
  governancePepCapabilities.set({ coverage: "uncovered" }, total - covered);
  governancePepCoverageRatio.set(total > 0 ? covered / total : 1);
}

export function setRuntimeGovernanceAttested(runtimeId: string, attested: boolean): void {
  runtimeGovernanceAttested.set({ runtime: runtimeId.slice(0, 64) }, attested ? 1 : 0);
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

export function recordMcpStatusCacheRequest(
  outcome: "hit" | "miss" | "coalesced" | "bypass",
): void {
  mcpStatusCacheRequests.inc({ outcome });
}

export function beginSearchToolCall(): (outcome: OperationalOutcome) => void {
  const startedAt = Date.now();
  let finished = false;
  return (outcome) => {
    if (finished) return;
    finished = true;
    searchToolCalls.inc({ outcome });
    searchToolDuration.observe({ outcome }, Math.max(0, Date.now() - startedAt) / 1000);
  };
}

export function recordSearchResultOptimization(args: {
  originalChars: number;
  compactChars: number;
}): void {
  searchResultOptimizations.inc();
  searchResultChars.observe({ stage: "original" }, Math.max(0, args.originalChars));
  searchResultChars.observe({ stage: "compact" }, Math.max(0, args.compactChars));
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

export function setSkillWorkQueue(input: {
  lane: "scan" | "install";
  active: number;
  queued: number;
  concurrency: number;
  maxQueued: number;
}): void {
  skillWorkActive.set({ lane: input.lane }, Math.max(0, input.active));
  skillWorkQueued.set({ lane: input.lane }, Math.max(0, input.queued));
  skillWorkLimit.set({ lane: input.lane, kind: "active" }, Math.max(0, input.concurrency));
  skillWorkLimit.set({ lane: input.lane, kind: "queued" }, Math.max(0, input.maxQueued));
}

export function beginSkillWork(lane: "scan" | "install"): (outcome: "success" | "error") => void {
  const startedAt = Date.now();
  let finished = false;
  return (outcome) => {
    if (finished) return;
    finished = true;
    skillWorkTotal.inc({ lane, outcome });
    skillWorkDuration.observe({ lane, outcome }, Math.max(0, Date.now() - startedAt) / 1000);
  };
}

export function observeSkillWorkRejection(lane: "scan" | "install"): void {
  skillWorkRejections.inc({ lane });
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

export function setPublicHealthComponentStatus(
  component: "application" | "runtime" | "model",
  status: "operational" | "degraded" | "outage" | "unknown",
): void {
  for (const candidate of ["operational", "degraded", "outage", "unknown"] as const) {
    publicHealthComponentStatus.set({ component, status: candidate }, candidate === status ? 1 : 0);
  }
}
