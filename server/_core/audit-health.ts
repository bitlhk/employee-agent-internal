import { getDb } from "../db";
import { getAuditDlqStats, type AuditDlqStats } from "./audit-ledger";

type AuditDbExecutor = {
  execute: (query: string) => Promise<unknown>;
};

type AuditTableName = "audit_events" | "audit_tool_events" | "audit_security_findings" | "audit_exports";

const AUDIT_TABLES: Array<{ name: AuditTableName; timeColumn: "event_time" | "created_at" }> = [
  { name: "audit_events", timeColumn: "event_time" },
  { name: "audit_tool_events", timeColumn: "created_at" },
  { name: "audit_security_findings", timeColumn: "created_at" },
  { name: "audit_exports", timeColumn: "created_at" },
];

const EXPECTED_WORM_TRIGGERS = [
  "audit_events_no_update",
  "audit_events_no_delete",
  "audit_tool_events_no_update",
  "audit_tool_events_no_delete",
  "audit_exports_no_update",
  "audit_exports_no_delete",
  "audit_security_findings_no_delete",
  "audit_security_findings_restricted_update",
];

const FORBIDDEN_RUNTIME_PRIVILEGES = [
  "ALL PRIVILEGES",
  "ALTER",
  "CREATE",
  "CREATE USER",
  "DROP",
  "EVENT",
  "FILE",
  "GRANT OPTION",
  "LOCK TABLES",
  "PROCESS",
  "RELOAD",
  "SHUTDOWN",
  "SUPER",
  "TRIGGER",
  "TRUNCATE",
];

export interface AuditTableHealth {
  name: AuditTableName;
  exists: boolean;
  rowCount: number | null;
  oldest: string | null;
  newest: string | null;
  error?: string;
}

export interface AuditRuntimePermissionHealth {
  ok: boolean;
  currentUser: string | null;
  grantCount: number;
  forbiddenPrivileges: string[];
  error?: string;
}

export interface AuditTriggerHealth {
  expected: string[];
  present: string[];
  missing: string[];
  ok: boolean;
  error?: string;
}

export interface AuditBaselineHealth {
  ok: boolean;
  checkedAt: string;
  tables: AuditTableHealth[];
  ledger: {
    exists: boolean;
    rowCount: number | null;
    oldestEventTime: string | null;
    newestEventTime: string | null;
  };
  dlq: AuditDlqStats | null;
  recentFailures: Array<{
    eventId: string;
    eventTime: string | null;
    category: string;
    action: string;
    result: string;
    severity: string;
    errorCode: string | null;
    policyCode: string | null;
  }>;
  permissions: AuditRuntimePermissionHealth;
  triggers: AuditTriggerHealth;
  warnings: string[];
  error?: string;
}

export async function getAuditBaselineHealth(options: {
  db?: AuditDbExecutor | null;
  dlqStats?: () => Promise<AuditDlqStats>;
  now?: () => Date;
} = {}): Promise<AuditBaselineHealth> {
  const checkedAt = (options.now || (() => new Date()))().toISOString();
  const warnings: string[] = [];
  const tables: AuditTableHealth[] = [];
  let recentFailures: AuditBaselineHealth["recentFailures"] = [];
  let permissions: AuditRuntimePermissionHealth = {
    ok: false,
    currentUser: null,
    grantCount: 0,
    forbiddenPrivileges: [],
  };
  let triggers: AuditTriggerHealth = {
    expected: EXPECTED_WORM_TRIGGERS,
    present: [],
    missing: EXPECTED_WORM_TRIGGERS,
    ok: false,
  };

  const dlq = await (options.dlqStats || getAuditDlqStats)().catch((err: any) => {
    warnings.push(`audit DLQ stats unavailable: ${errorMessage(err)}`);
    return null;
  });

  try {
    const db = options.db === undefined ? await getDb() : options.db;
    if (!db) throw new Error("DB not available");

    for (const table of AUDIT_TABLES) {
      tables.push(await inspectAuditTable(db, table.name, table.timeColumn));
    }

    const auditEvents = tables.find((table) => table.name === "audit_events");
    if (auditEvents?.exists) {
      recentFailures = await listRecentAuditFailures(db);
    }

    permissions = await inspectRuntimePermissions(db);
    triggers = await inspectAuditTriggers(db);
  } catch (err: any) {
    return buildAuditHealth({
      checkedAt,
      tables,
      dlq,
      recentFailures,
      permissions,
      triggers,
      warnings,
      error: errorMessage(err),
    });
  }

  return buildAuditHealth({ checkedAt, tables, dlq, recentFailures, permissions, triggers, warnings });
}

export function detectForbiddenGrantPrivileges(grants: string[]): string[] {
  const found = new Set<string>();
  for (const raw of grants) {
    const grant = String(raw || "").toUpperCase();
    if (grant.includes("GRANT ALL PRIVILEGES")) found.add("ALL PRIVILEGES");
    for (const privilege of FORBIDDEN_RUNTIME_PRIVILEGES) {
      if (privilege === "ALL PRIVILEGES") continue;
      const escaped = privilege.replace(/ /g, "\\s+");
      if (new RegExp(`\\b${escaped}\\b`).test(grant)) found.add(privilege);
    }
  }
  return Array.from(found).sort();
}

async function inspectAuditTable(db: AuditDbExecutor, name: AuditTableName, timeColumn: string): Promise<AuditTableHealth> {
  try {
    const exists = await tableExists(db, name);
    if (!exists) return { name, exists: false, rowCount: null, oldest: null, newest: null };

    const rows = await queryRows(db, `SELECT COUNT(*) AS row_count, MIN(\`${timeColumn}\`) AS oldest_at, MAX(\`${timeColumn}\`) AS newest_at FROM \`${name}\``);
    const row = rows[0] || {};
    return {
      name,
      exists: true,
      rowCount: numberField(row, ["row_count", "rowCount", "COUNT(*)"]),
      oldest: dateField(row, ["oldest_at", "oldestAt"]),
      newest: dateField(row, ["newest_at", "newestAt"]),
    };
  } catch (err: any) {
    return { name, exists: false, rowCount: null, oldest: null, newest: null, error: errorMessage(err) };
  }
}

async function tableExists(db: AuditDbExecutor, table: AuditTableName): Promise<boolean> {
  if (!AUDIT_TABLES.some((item) => item.name === table)) return false;
  const rows = await queryRows(db, `SHOW TABLES LIKE '${table}'`);
  return rows.length > 0;
}

async function listRecentAuditFailures(db: AuditDbExecutor): Promise<AuditBaselineHealth["recentFailures"]> {
  const rows = await queryRows(db, `
    SELECT event_id, event_time, category, action, result, severity, error_code, policy_code
    FROM audit_events
    WHERE result <> 'success' OR severity IN ('high', 'critical')
    ORDER BY event_time DESC
    LIMIT 10
  `);
  return rows.map((row) => ({
    eventId: stringField(row, ["event_id", "eventId"]),
    eventTime: dateField(row, ["event_time", "eventTime"]),
    category: stringField(row, ["category"]),
    action: stringField(row, ["action"]),
    result: stringField(row, ["result"]),
    severity: stringField(row, ["severity"]),
    errorCode: nullableStringField(row, ["error_code", "errorCode"]),
    policyCode: nullableStringField(row, ["policy_code", "policyCode"]),
  }));
}

async function inspectRuntimePermissions(db: AuditDbExecutor): Promise<AuditRuntimePermissionHealth> {
  try {
    const currentUserRows = await queryRows(db, "SELECT CURRENT_USER() AS audit_current_user");
    const currentUser = nullableStringField(currentUserRows[0] || {}, ["audit_current_user", "current_user", "CURRENT_USER()"]);
    const grantRows = await queryRows(db, "SHOW GRANTS FOR CURRENT_USER()");
    const grants = grantRows.map((row) => String(Object.values(row)[0] || "")).filter(Boolean);
    const forbiddenPrivileges = detectForbiddenGrantPrivileges(grants);
    return {
      ok: forbiddenPrivileges.length === 0,
      currentUser,
      grantCount: grants.length,
      forbiddenPrivileges,
    };
  } catch (err: any) {
    return { ok: false, currentUser: null, grantCount: 0, forbiddenPrivileges: [], error: errorMessage(err) };
  }
}

async function inspectAuditTriggers(db: AuditDbExecutor): Promise<AuditTriggerHealth> {
  try {
    const triggerNames = EXPECTED_WORM_TRIGGERS.map((name) => `'${name}'`).join(", ");
    const directRows = await queryRows(db, `
      SELECT TRIGGER_NAME AS name
      FROM INFORMATION_SCHEMA.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE()
        AND TRIGGER_NAME IN (${triggerNames})
    `);
    let rows = directRows;
    if (rows.length < EXPECTED_WORM_TRIGGERS.length) {
      try {
        const attestedRows = await queryRows(db, "SELECT name FROM audit_worm_trigger_status");
        const byName = new Map([...directRows, ...attestedRows].map((row) => [stringField(row, ["name", "TRIGGER_NAME"]), row]));
        rows = Array.from(byName.values());
      } catch {}
    }
    if (rows.length < EXPECTED_WORM_TRIGGERS.length) {
      try {
        const functionRows = await queryRows(db, "SELECT audit_worm_trigger_names() AS names");
        const raw = functionRows[0]?.names;
        const names = Array.isArray(raw) ? raw : JSON.parse(String(raw || "[]"));
        if (Array.isArray(names)) rows = names.map((name) => ({ name: String(name) }));
      } catch {}
    }
    const present = rows.map((row) => stringField(row, ["name", "TRIGGER_NAME"])).filter(Boolean).sort();
    const presentSet = new Set(present);
    const missing = EXPECTED_WORM_TRIGGERS.filter((name) => !presentSet.has(name));
    return { expected: EXPECTED_WORM_TRIGGERS, present, missing, ok: missing.length === 0 };
  } catch (err: any) {
    return { expected: EXPECTED_WORM_TRIGGERS, present: [], missing: EXPECTED_WORM_TRIGGERS, ok: false, error: errorMessage(err) };
  }
}

function buildAuditHealth(input: Omit<AuditBaselineHealth, "ok" | "ledger">): AuditBaselineHealth {
  const auditEvents = input.tables.find((table) => table.name === "audit_events");
  const missingTables = input.tables.filter((table) => !table.exists).map((table) => table.name);
  const warnings = [...input.warnings];
  if (missingTables.length > 0) warnings.push(`missing audit tables: ${missingTables.join(", ")}`);
  if (input.dlq?.lastWriteFailure) warnings.push(`audit DLQ last write failure: ${input.dlq.lastWriteFailure}`);
  if (input.dlq?.diskAvailableBytes && input.dlq.diskTotalBytes) {
    const availableRatio = input.dlq.diskAvailableBytes / input.dlq.diskTotalBytes;
    if (availableRatio < 0.1) warnings.push("audit DLQ disk availability is below 10%");
  }
  if (!input.permissions.ok) warnings.push("runtime database account has forbidden or unknown audit privileges");
  if (!input.triggers.ok) warnings.push("audit WORM triggers are missing or unavailable");

  const ok = !input.error
    && input.tables.length === AUDIT_TABLES.length
    && missingTables.length === 0
    && input.permissions.ok
    && input.triggers.ok
    && !input.dlq?.lastWriteFailure;

  return {
    ...input,
    ok,
    ledger: {
      exists: Boolean(auditEvents?.exists),
      rowCount: auditEvents?.rowCount ?? null,
      oldestEventTime: auditEvents?.oldest ?? null,
      newestEventTime: auditEvents?.newest ?? null,
    },
    warnings,
  };
}

async function queryRows(db: AuditDbExecutor, query: string): Promise<Record<string, any>[]> {
  return normalizeRows(await db.execute(query));
}

function normalizeRows(result: unknown): Record<string, any>[] {
  if (!Array.isArray(result)) return [];
  const rows = Array.isArray(result[0]) ? result[0] : result;
  return Array.isArray(rows) ? rows as Record<string, any>[] : [];
}

function numberField(row: Record<string, any>, names: string[]): number {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null) return Number(row[name] || 0);
  }
  return 0;
}

function stringField(row: Record<string, any>, names: string[]): string {
  return nullableStringField(row, names) || "";
}

function nullableStringField(row: Record<string, any>, names: string[]): string | null {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null) return String(row[name]);
  }
  return null;
}

function dateField(row: Record<string, any>, names: string[]): string | null {
  for (const name of names) {
    const value = row[name];
    if (value === undefined || value === null) continue;
    if (value instanceof Date) return value.toISOString();
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }
  return null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
