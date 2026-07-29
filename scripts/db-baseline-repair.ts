import "dotenv/config";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection } from "mysql2/promise";

type BaselineContract = {
  id: string;
  tables: Array<{ name: string; columns: string[] }>;
};

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(appRoot, "config", "schema-baseline-v1.json");
const allowedRepair = "lx_coop_user_hidden.created_at";
const lockName = "employee_agent_schema_migration";

function databaseUrl(): string {
  const value = String(process.env.DATABASE_MIGRATION_URL || "").trim();
  if (!value) throw new Error("DATABASE_MIGRATION_URL is required for baseline repair");
  return value;
}

function loadBaseline(): BaselineContract {
  const contract = JSON.parse(readFileSync(baselinePath, "utf8")) as BaselineContract;
  if (contract.id !== "baseline-v1" || !Array.isArray(contract.tables)) {
    throw new Error("unsupported schema baseline contract");
  }
  return contract;
}

async function acquireLock(connection: Connection): Promise<void> {
  const [rows] = await connection.query<Array<{ acquired: number } & mysql.RowDataPacket>>(
    "SELECT GET_LOCK(?, 60) AS acquired",
    [lockName],
  );
  if (Number(rows[0]?.acquired || 0) !== 1) throw new Error("could not acquire schema migration lock");
}

async function validateDdlPrivileges(connection: Connection): Promise<void> {
  const suffix = `${process.pid}_${createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 8)}`;
  const table = `__ea_repair_probe_${suffix}`;
  const trigger = `__ea_repair_probe_trigger_${suffix}`;
  const view = `__ea_repair_probe_view_${suffix}`;
  try {
    await connection.query(`CREATE TABLE \`${table}\` (\`value\` INT NOT NULL) ENGINE=InnoDB`);
    await connection.query(`CREATE TRIGGER \`${trigger}\` BEFORE INSERT ON \`${table}\` FOR EACH ROW SET NEW.\`value\` = NEW.\`value\``);
    await connection.query(`CREATE VIEW \`${view}\` AS SELECT \`value\` FROM \`${table}\``);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`DDL privilege probe failed (${reason})`);
  } finally {
    await connection.query(`DROP VIEW IF EXISTS \`${view}\``).catch(() => undefined);
    await connection.query(`DROP TRIGGER IF EXISTS \`${trigger}\``).catch(() => undefined);
    await connection.query(`DROP TABLE IF EXISTS \`${table}\``).catch(() => undefined);
  }
}

async function findMissing(connection: Connection, contract: BaselineContract): Promise<string[]> {
  const [rows] = await connection.query<Array<{ TABLE_NAME: string; COLUMN_NAME: string } & mysql.RowDataPacket>>(`
    SELECT TABLE_NAME, COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
  `);
  const actual = new Map<string, Set<string>>();
  for (const row of rows) {
    const columns = actual.get(row.TABLE_NAME) || new Set<string>();
    columns.add(row.COLUMN_NAME);
    actual.set(row.TABLE_NAME, columns);
  }
  const missing: string[] = [];
  for (const table of contract.tables) {
    const columns = actual.get(table.name);
    if (!columns) {
      missing.push(`${table.name}.*`);
      continue;
    }
    for (const column of table.columns) {
      if (!columns.has(column)) missing.push(`${table.name}.${column}`);
    }
  }
  return missing;
}

async function main(): Promise<void> {
  const connection = await mysql.createConnection({ uri: databaseUrl(), multipleStatements: false });
  try {
    await acquireLock(connection);
    await validateDdlPrivileges(connection);
    const contract = loadBaseline();
    const missing = await findMissing(connection, contract);
    if (missing.length === 0) {
      console.log(`${contract.id} already matches; no repair needed`);
      return;
    }
    const unsupported = missing.filter((item) => item !== allowedRepair);
    if (unsupported.length > 0) {
      throw new Error(`baseline repair refused unsupported drift: ${unsupported.slice(0, 20).join(", ")}`);
    }
    await connection.query(`
      ALTER TABLE \`lx_coop_user_hidden\`
      ADD COLUMN \`created_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP AFTER \`session_id\`
    `);
    const remaining = await findMissing(connection, contract);
    if (remaining.length > 0) throw new Error(`baseline repair incomplete: ${remaining.join(", ")}`);
    console.log(`${contract.id} repaired: ${allowedRepair}`);
  } finally {
    await connection.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => undefined);
    await connection.end();
  }
}

main().catch((error) => {
  console.error(`[DB-BASELINE-REPAIR] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
