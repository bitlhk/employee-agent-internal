import "dotenv/config";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/mysql2";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql, { type Connection } from "mysql2/promise";

type BaselineContract = {
  id: string;
  tables: Array<{ name: string; columns: string[] }>;
};

type MigrationRow = {
  hash: string;
  created_at: number | string;
};

type MigrationCapabilities = {
  trigger: boolean;
  view: boolean;
};

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(appRoot, "config", "schema-baseline-v1.json");
const migrationsFolder = path.join(appRoot, "drizzle", "managed");
const migrationsTable = "__ea_schema_migrations";
const lockName = "employee_agent_schema_migration";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function databaseUrl(): string {
  const value = String(process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL || "").trim();
  if (!value) throw new Error("DATABASE_MIGRATION_URL or DATABASE_URL is required");
  return value;
}

function loadBaseline(): { contract: BaselineContract; checksum: string } {
  const content = readFileSync(baselinePath, "utf8");
  const contract = JSON.parse(content) as BaselineContract;
  if (!contract.id || !Array.isArray(contract.tables) || contract.tables.length === 0) {
    throw new Error("schema baseline manifest is invalid");
  }
  return { contract, checksum: sha256(content) };
}

async function acquireLock(connection: Connection): Promise<void> {
  const [rows] = await connection.query<Array<{ acquired: number } & mysql.RowDataPacket>>(
    "SELECT GET_LOCK(?, 60) AS acquired",
    [lockName],
  );
  if (Number(rows[0]?.acquired || 0) !== 1) throw new Error("could not acquire schema migration lock");
}

async function releaseLock(connection: Connection): Promise<void> {
  await connection.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => undefined);
}

async function migrationTableExists(connection: Connection): Promise<boolean> {
  const [rows] = await connection.query<Array<{ present: number } & mysql.RowDataPacket>>(
    "SELECT COUNT(*) AS present FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    [migrationsTable],
  );
  return Number(rows[0]?.present || 0) === 1;
}

async function ensureMigrationTable(connection: Connection): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS \`${migrationsTable}\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      \`hash\` TEXT NOT NULL,
      \`created_at\` BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

function migrationCapabilities(sqlStatements: string[]): MigrationCapabilities {
  const source = sqlStatements.join("\n").toUpperCase();
  return {
    trigger: /\bCREATE\s+TRIGGER\b/.test(source),
    view: /\bCREATE(?:\s+OR\s+REPLACE)?\s+.*\bVIEW\b/.test(source),
  };
}

async function pendingMigrationCapabilities(connection: Connection): Promise<MigrationCapabilities> {
  const migrations = readMigrationFiles({ migrationsFolder });
  if (!await migrationTableExists(connection)) {
    return migrationCapabilities(migrations.flatMap((migration) => migration.sql));
  }
  const [rows] = await connection.query<Array<MigrationRow & mysql.RowDataPacket>>(
    `SELECT hash, created_at FROM \`${migrationsTable}\` WHERE created_at > 0 ORDER BY created_at`,
  );
  const appliedTimes = new Set(rows.map((row) => Number(row.created_at)));
  return migrationCapabilities(
    migrations
      .filter((migration) => !appliedTimes.has(migration.folderMillis))
      .flatMap((migration) => migration.sql),
  );
}

async function validateDdlPrivileges(
  connection: Connection,
  required: MigrationCapabilities,
): Promise<void> {
  const [rows] = await connection.query<Array<{ connection_id: number } & mysql.RowDataPacket>>(
    "SELECT CONNECTION_ID() AS connection_id",
  );
  const suffix = `${process.pid}_${Number(rows[0]?.connection_id || 0)}`;
  const table = `__ea_migration_probe_${suffix}`;
  const trigger = `__ea_migration_probe_trigger_${suffix}`;
  const view = `__ea_migration_probe_view_${suffix}`;

  try {
    await connection.query(`CREATE TABLE \`${table}\` (\`value\` INT NOT NULL) ENGINE=InnoDB`);
    await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN \`probe\` INT NULL`);
    await connection.query(`CREATE INDEX \`idx_probe\` ON \`${table}\` (\`probe\`)`);
    await connection.query(`INSERT INTO \`${table}\` (\`value\`) VALUES (1)`);
    await connection.query(`DELETE FROM \`${table}\` WHERE \`value\` = 1`);
    if (required.trigger) {
      await connection.query(`CREATE TRIGGER \`${trigger}\` BEFORE INSERT ON \`${table}\` FOR EACH ROW SET NEW.\`value\` = NEW.\`value\``);
    }
    if (required.view) {
      await connection.query(`CREATE VIEW \`${view}\` AS SELECT \`value\` FROM \`${table}\``);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`DDL privilege probe failed; configure DATABASE_MIGRATION_URL with a migration account (${reason})`);
  } finally {
    await connection.query(`DROP VIEW IF EXISTS \`${view}\``).catch(() => undefined);
    await connection.query(`DROP TRIGGER IF EXISTS \`${trigger}\``).catch(() => undefined);
    await connection.query(`DROP TABLE IF EXISTS \`${table}\``).catch(() => undefined);
  }
}

async function validateBaseline(connection: Connection, contract: BaselineContract): Promise<void> {
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
  if (missing.length > 0) {
    const preview = missing.slice(0, 25).join(", ");
    throw new Error(`database does not match ${contract.id}; missing ${preview}${missing.length > 25 ? ` and ${missing.length - 25} more` : ""}`);
  }
}

async function ensureBaseline(connection: Connection, createMarker: boolean): Promise<boolean> {
  const { contract, checksum } = loadBaseline();
  const marker = `baseline:${contract.id}:${checksum}`;
  const [rows] = await connection.query<Array<MigrationRow & mysql.RowDataPacket>>(
    `SELECT hash, created_at FROM \`${migrationsTable}\` WHERE created_at = 0`,
  );
  if (rows.length > 1) throw new Error("multiple schema baseline markers found");
  if (rows.length === 1) {
    if (rows[0].hash !== marker) throw new Error("schema baseline checksum mismatch");
    return true;
  }
  await validateBaseline(connection, contract);
  if (!createMarker) return false;
  await connection.query(`INSERT INTO \`${migrationsTable}\` (hash, created_at) VALUES (?, 0)`, [marker]);
  return true;
}

async function inspectHistory(connection: Connection, requireComplete: boolean): Promise<{ applied: number; pending: number }> {
  const migrations = readMigrationFiles({ migrationsFolder });
  const [rows] = await connection.query<Array<MigrationRow & mysql.RowDataPacket>>(
    `SELECT hash, created_at FROM \`${migrationsTable}\` WHERE created_at > 0 ORDER BY created_at`,
  );
  const appliedByTime = new Map(rows.map((row) => [Number(row.created_at), row.hash]));
  const expectedTimes = new Set(migrations.map((migration) => migration.folderMillis));
  for (const row of rows) {
    if (!expectedTimes.has(Number(row.created_at))) {
      throw new Error(`database contains unknown managed migration timestamp ${row.created_at}`);
    }
  }
  let pending = 0;
  let seenPending = false;
  for (const migration of migrations) {
    const appliedHash = appliedByTime.get(migration.folderMillis);
    if (!appliedHash) {
      pending += 1;
      seenPending = true;
      continue;
    }
    if (seenPending) throw new Error("managed migration history is non-linear");
    if (appliedHash !== migration.hash) {
      throw new Error(`managed migration checksum mismatch at ${migration.folderMillis}`);
    }
  }
  if (requireComplete && pending > 0) throw new Error(`${pending} managed migration(s) are pending`);
  return { applied: rows.length, pending };
}

async function adoptCurrentSchema(connection: Connection): Promise<void> {
  const { contract, checksum } = loadBaseline();
  await validateBaseline(connection, contract);
  await ensureMigrationTable(connection);

  const [rows] = await connection.query<Array<{ count: number } & mysql.RowDataPacket>>(
    `SELECT COUNT(*) AS count FROM \`${migrationsTable}\``,
  );
  if (Number(rows[0]?.count || 0) !== 0) {
    throw new Error("current schema adoption requires an empty managed migration history");
  }

  const migrations = readMigrationFiles({ migrationsFolder });
  const marker = `baseline:${contract.id}:${checksum}`;
  await connection.beginTransaction();
  try {
    await connection.query(
      `INSERT INTO \`${migrationsTable}\` (hash, created_at) VALUES (?, 0)`,
      [marker],
    );
    for (const migration of migrations) {
      await connection.query(
        `INSERT INTO \`${migrationsTable}\` (hash, created_at) VALUES (?, ?)`,
        [migration.hash, migration.folderMillis],
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }

  const adopted = await inspectHistory(connection, true);
  console.log(`current schema adopted; applied=${adopted.applied} pending=${adopted.pending}`);
}

async function main(): Promise<void> {
  const mode = String(process.argv[2] || "apply");
  if (!new Set(["apply", "check", "status", "adopt-current"]).has(mode)) {
    throw new Error("usage: db-migrate.ts [apply|check|status|adopt-current]");
  }
  const connection = await mysql.createConnection({ uri: databaseUrl(), multipleStatements: false });
  try {
    await acquireLock(connection);
    if (mode === "adopt-current") {
      await adoptCurrentSchema(connection);
      return;
    }
    const tablePresent = await migrationTableExists(connection);
    if (!tablePresent && mode !== "apply") {
      await validateBaseline(connection, loadBaseline().contract);
      if (mode === "check") throw new Error("managed migration baseline is not registered");
      console.log("schema matches baseline; managed migration baseline is not registered");
      return;
    }
    let ddlPrivilegesValidated = false;
    if (!tablePresent) {
      await validateDdlPrivileges(connection, await pendingMigrationCapabilities(connection));
      ddlPrivilegesValidated = true;
      await ensureMigrationTable(connection);
    }
    const baselineReady = await ensureBaseline(connection, mode === "apply");
    if (!baselineReady) {
      if (mode === "check") throw new Error("managed migration baseline is not registered");
      console.log("schema matches baseline; managed migration baseline is not registered");
      return;
    }
    const before = await inspectHistory(connection, false);
    if (mode === "apply" && before.pending > 0) {
      if (!ddlPrivilegesValidated) {
        await validateDdlPrivileges(connection, await pendingMigrationCapabilities(connection));
      }
      await migrate(drizzle(connection), { migrationsFolder, migrationsTable });
    }
    const after = await inspectHistory(connection, mode !== "status");
    console.log(`schema baseline ready; applied=${after.applied} pending=${after.pending}`);
  } finally {
    await releaseLock(connection);
    await connection.end();
  }
}

main().catch((error) => {
  console.error(`[DB-MIGRATE] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
