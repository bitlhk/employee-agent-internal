import { execFileSync } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import path from "path";

import { getDb } from "../db";
import { getAuditBaselineHealth } from "./audit-health";
import { getBackgroundWorkerSnapshot } from "./background-workers";
import {
  APP_ROOT,
  JIUWENCLAW_HOME,
  jiuwenClawServiceId,
} from "./helpers";
import { getCapacitySnapshot } from "./operational-capacity";

export interface RuntimeModelOption {
  id: string;
  name: string;
  desc?: string;
  isDefault?: boolean;
}

type CommandResult = {
  ok: boolean;
  output: string;
  error?: string;
};

type Pm2Process = {
  name?: string;
  pm2_env?: {
    status?: string;
    restart_time?: number;
    pm_uptime?: number;
  };
  monit?: {
    memory?: number;
    cpu?: number;
  };
};

type DatabaseHealth = {
  ok: boolean;
  tables: Array<{ name: string; exists: boolean }>;
  skillMarketApproved: number | null;
  claws: {
    total: number;
    active: number;
    jiuwenActive: number;
    openclawActive: number;
  } | null;
  error: string;
  latencyMs?: number;
};

type HealthStatus = "ok" | "warning" | "error" | "disabled";

type HealthCheck = {
  key: string;
  group: "platform" | "operations" | "runtime" | "database" | "channels" | "audit";
  label: string;
  provider?: string;
  status: HealthStatus;
  detail: string;
  meta?: Record<string, unknown>;
};

function runCommand(file: string, args: string[], timeout = 8_000): CommandResult {
  try {
    return {
      ok: true,
      output: execFileSync(file, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout,
      }).trim(),
    };
  } catch (error: unknown) {
    const detail = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    return {
      ok: false,
      output: String(detail.stdout || "").trim(),
      error: String(detail.stderr || detail.message || error).trim(),
    };
  }
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function resultRows(result: unknown): unknown[] {
  if (!Array.isArray(result)) return [];
  return Array.isArray(result[0]) ? result[0] : result;
}

function firstRecord(result: unknown): Record<string, unknown> {
  const first = resultRows(result)[0];
  return first && typeof first === "object" ? first as Record<string, unknown> : {};
}

function countDirectories(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}

function readJiuwenRecentActivity(): { requests24h: number; completes24h: number } {
  const logPath = path.join(APP_ROOT, "logs", "jiuwenclaw-exec.log");
  if (!existsSync(logPath)) return { requests24h: 0, completes24h: 0 };

  const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
  let requests24h = 0;
  let completes24h = 0;
  try {
    const lines = readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-5_000);
    for (const line of lines) {
      const event = parseJson<Record<string, unknown>>(line, {});
      const timestamp = Date.parse(String(event.ts || ""));
      if (!Number.isFinite(timestamp) || timestamp < cutoff) continue;
      if (event.event === "chat_stream_request") requests24h += 1;
      if (event.event === "chat_stream_complete") completes24h += 1;
    }
  } catch {
    return { requests24h: 0, completes24h: 0 };
  }
  return { requests24h, completes24h };
}

async function readDatabaseHealth(): Promise<DatabaseHealth> {
  const tables = ["users", "claw_adoptions", "skill_marketplace"] as const;
  const health: DatabaseHealth = {
    ok: false,
    tables: [],
    skillMarketApproved: null,
    claws: null,
    error: "",
  };
  const startedAt = Date.now();

  try {
    const db = await getDb();
    if (!db) throw new Error("DB not available");
    health.ok = true;
    for (const table of tables) {
      const result = await db.execute(`SHOW TABLES LIKE '${table}'`);
      health.tables.push({ name: table, exists: resultRows(result).length > 0 });
    }

    const approved = await db.execute("SELECT COUNT(*) AS count FROM skill_marketplace WHERE status = 'approved'");
    const agents = await db.execute(`
      SELECT
        COUNT(*) AS total,
        SUM(status = 'active') AS active,
        SUM(status = 'active' AND (runtime = 'jiuwenswarm' OR adoptId LIKE 'lgj-%')) AS jiuwenActive,
        SUM(status = 'active' AND (runtime = 'openclaw' OR adoptId LIKE 'lgc-%')) AS openclawActive
      FROM claw_adoptions
    `);
    const approvedRow = firstRecord(approved);
    const agentRow = firstRecord(agents);
    health.skillMarketApproved = Number(approvedRow.count || 0);
    health.claws = {
      total: Number(agentRow.total || 0),
      active: Number(agentRow.active || 0),
      jiuwenActive: Number(agentRow.jiuwenActive || 0),
      openclawActive: Number(agentRow.openclawActive || 0),
    };
  } catch (error: unknown) {
    health.error = error instanceof Error ? error.message : String(error);
  } finally {
    health.latencyMs = Date.now() - startedAt;
  }

  return health;
}

export async function getAdminSystemHealth(availableModels: RuntimeModelOption[]) {
  const checkedAt = new Date().toISOString();
  const pm2 = runCommand("pm2", ["jlist"]);
  const gitBranch = runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], 5_000);
  const gitCommit = runCommand("git", ["rev-parse", "--short", "HEAD"], 5_000);
  const pm2Rows = pm2.ok ? parseJson<Pm2Process[]>(pm2.output || "[]", []) : [];
  const appName = process.env.PM2_APP_NAME
    || (APP_ROOT.includes("linggan-platform") ? "linggan-claw" : "employee-agent");
  const app = pm2Rows.find((row) => row.name === appName)
    || pm2Rows.find((row) => /employee-agent|linggan-claw/.test(String(row.name || "")))
    || null;
  const alertProcessName = process.env.EA_ALERT_PM2_NAME || "employee-agent-alerts";
  const alertProcess = pm2Rows.find((row) => row.name === alertProcessName) || null;
  const capacity = getCapacitySnapshot();
  const workers = getBackgroundWorkerSnapshot();
  const alertConfigured = Boolean(String(process.env.EA_ALERT_FEISHU_WEBHOOK_URL || "").trim());
  const primaryModel = availableModels.find((model) => model.isDefault)?.id || "__auto";
  const database = await readDatabaseHealth();
  const auditBaseline = await getAuditBaselineHealth();
  const checks: HealthCheck[] = [];
  const appStatus = String(app?.pm2_env?.status || "");

  checks.push({
    key: "platform.app",
    group: "platform",
    label: "平台服务",
    provider: "ea",
    status: appStatus === "online" ? "ok" : "error",
    detail: `${app?.name || appName} · ${appStatus || "unknown"} · CPU ${app?.monit?.cpu ?? "-"}% · 重启 ${app?.pm2_env?.restart_time ?? "-"} 次`,
  });

  const saturatedLanes = Object.entries(capacity)
    .filter(([, lane]) => lane.limit > 0 && lane.active / lane.limit >= 0.8);
  checks.push({
    key: "operations.capacity",
    group: "operations",
    label: "并发容量",
    provider: "ea",
    status: saturatedLanes.length > 0 ? "warning" : "ok",
    detail: Object.entries(capacity)
      .map(([lane, state]) => `${lane} ${state.active}/${state.limit}`)
      .join(" · "),
  });

  const failedWorkers = workers.filter((worker) => worker.state === "failed");
  const runningWorkers = workers.filter((worker) => worker.state === "running");
  checks.push({
    key: "operations.workers",
    group: "operations",
    label: "后台任务",
    provider: "ea",
    status: failedWorkers.length > 0 ? "error" : workers.length > 0 ? "ok" : "warning",
    detail: `${runningWorkers.length}/${workers.length} 运行${failedWorkers.length ? ` · ${failedWorkers.length} 异常` : ""}`,
  });
  checks.push({
    key: "operations.metrics",
    group: "operations",
    label: "监控指标",
    provider: "prometheus",
    status: "ok",
    detail: "Prometheus 指标已通过受限内部端点提供",
  });
  checks.push({
    key: "operations.alerting",
    group: "operations",
    label: "飞书告警",
    provider: "feishu",
    status: !alertConfigured
      ? "disabled"
      : alertProcess?.pm2_env?.status === "online"
        ? "ok"
        : "warning",
    detail: !alertConfigured
      ? "尚未配置告警机器人"
      : alertProcess?.pm2_env?.status === "online"
        ? "告警分发进程运行中"
        : "已配置，但告警分发进程未运行",
  });

  const jiuwenActive = Number(database.claws?.jiuwenActive || 0);
  const jiuwenEnabled = jiuwenActive > 0 || process.env.WORKFORCE_AGENT_HEALTH_CHECK_JIUWEN === "true";
  const globalSessionsDir = path.join(JIUWENCLAW_HOME, "agent", "sessions");
  const serviceDir = path.join(JIUWENCLAW_HOME, `service_${jiuwenClawServiceId()}`);
  const homeExists = existsSync(JIUWENCLAW_HOME);
  const globalSessionCount = countDirectories(globalSessionsDir);
  const serviceAgentCount = countDirectories(serviceDir);
  const service = runCommand("systemctl", ["is-active", "jiuwenswarm.service"], 3_000);
  const recentActivity = readJiuwenRecentActivity();
  checks.push({
    key: "runtime.jiuwenswarm",
    group: "runtime",
    label: "JiuwenSwarm Runtime",
    provider: "jiuwenswarm",
    status: !jiuwenEnabled ? "disabled" : homeExists ? "ok" : "error",
    detail: !jiuwenEnabled
      ? "当前没有启用 JiuwenSwarm 智能体"
      : `${jiuwenActive} 个 active · sessions ${globalSessionCount} · service agents ${serviceAgentCount} · 24h 请求 ${recentActivity.requests24h}`,
    meta: {
      home: JIUWENCLAW_HOME,
      serviceId: jiuwenClawServiceId(),
      serviceStatus: service.output || service.error || "",
      ...recentActivity,
    },
  });

  const retiredActive = Number(database.claws?.openclawActive || 0);
  checks.push({
    key: "runtime.retired",
    group: "runtime",
    label: "已退役运行时记录",
    provider: "legacy",
    status: retiredActive > 0 ? "warning" : "disabled",
    detail: retiredActive > 0
      ? `数据库仍有 ${retiredActive} 个 active 历史记录`
      : "没有 active 历史运行时记录",
  });
  checks.push({
    key: "data.database",
    group: "database",
    label: "数据库",
    provider: "mysql",
    status: database.ok && database.tables.every((table) => table.exists) ? "ok" : "error",
    detail: database.ok
      ? `active ${database.claws?.active ?? 0}/${database.claws?.total ?? 0} · 技能 ${database.skillMarketApproved ?? 0} · ${database.latencyMs ?? "-"} ms`
      : database.error || "数据库不可用",
  });
  checks.push({
    key: "data.audit",
    group: "audit",
    label: "审计基线",
    provider: "audit-ledger",
    status: auditBaseline.ok ? "ok" : "warning",
    detail: `表 ${auditBaseline.tables.filter((table) => table.exists).length}/${auditBaseline.tables.length || 4} · DLQ ${auditBaseline.dlq?.eventCount ?? 0}`,
  });
  checks.push({
    key: "channels.status",
    group: "channels",
    label: "频道连接",
    provider: "channels",
    status: "disabled",
    detail: "频道健康由连接器状态页独立展示",
  });

  const summary = {
    ok: checks.every((check) => check.status === "ok" || check.status === "disabled"),
    error: checks.filter((check) => check.status === "error").length,
    warning: checks.filter((check) => check.status === "warning").length,
    disabled: checks.filter((check) => check.status === "disabled").length,
  };

  return {
    checkedAt,
    summary,
    checks,
    runtimes: {
      primary: jiuwenActive > 0 ? "jiuwenswarm" : "none",
      jiuwenswarm: {
        enabled: jiuwenEnabled,
        active: jiuwenActive,
        home: JIUWENCLAW_HOME,
        serviceId: jiuwenClawServiceId(),
        globalSessions: globalSessionCount,
        serviceAgents: serviceAgentCount,
        serviceStatus: service.output || "",
        recent: recentActivity,
      },
      openclaw: {
        enabled: false,
        active: retiredActive,
        retired: true,
      },
    },
    app: {
      name: appName,
      healthOk: appStatus === "online",
      health: { status: appStatus === "online" ? "ok" : "error", timestamp: checkedAt },
      pm2: app ? {
        name: app.name,
        status: app.pm2_env?.status,
        restarts: app.pm2_env?.restart_time,
        uptime: app.pm2_env?.pm_uptime,
        memory: app.monit?.memory,
        cpu: app.monit?.cpu,
      } : null,
      git: { branch: gitBranch.output || "", commit: gitCommit.output || "" },
      errors: [pm2.error].filter(Boolean),
    },
    operations: {
      capacity: {
        api: capacity.api,
        chat_http: capacity.chat_http,
        chat_ws: capacity.chat_ws,
      },
      workers,
      metrics: { enabled: true, endpoint: "/internal/metrics" },
      alerting: {
        configured: alertConfigured,
        processName: alertProcessName,
        status: String(alertProcess?.pm2_env?.status || (alertConfigured ? "offline" : "disabled")),
      },
    },
    channels: {
      ok: true,
      lines: [],
      raw: "",
      error: "",
    },
    models: {
      primary: primaryModel,
      available: availableModels,
      allowlist: availableModels.map((model) => model.id),
      agentModelDrift: [],
    },
    database,
    audit: auditBaseline,
  };
}
