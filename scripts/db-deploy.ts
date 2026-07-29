import "dotenv/config";

import { spawn } from "node:child_process";
import mysql from "mysql2/promise";

function migrationUrl(): string {
  const value = String(process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL || "").trim();
  if (!value) throw new Error("DATABASE_MIGRATION_URL or DATABASE_URL is required");
  return value;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function main(): Promise<void> {
  const url = migrationUrl();
  const connection = await mysql.createConnection(url);
  try {
    const [lockRows] = await connection.query<Array<{ acquired: number } & mysql.RowDataPacket>>(
      "SELECT GET_LOCK('employee_agent_schema_bootstrap', 60) AS acquired",
    );
    if (Number(lockRows[0]?.acquired || 0) !== 1) {
      throw new Error("could not acquire schema bootstrap lock");
    }
    const [rows] = await connection.query<Array<{ TABLE_NAME: string } & mysql.RowDataPacket>>(`
      SELECT TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_TYPE = 'BASE TABLE'
        AND TABLE_NAME NOT LIKE '\\_\\_%'
    `);
    const domainTableCount = rows.length;
    const hasUsersTable = rows.some((row) => row.TABLE_NAME === "users");

    const env = { ...process.env, DATABASE_URL: url, DATABASE_MIGRATION_URL: url };
    if (domainTableCount === 0) {
      await run("pnpm", ["exec", "drizzle-kit", "push", "--force"], env);
    } else if (!hasUsersTable) {
      throw new Error("database is not empty and does not contain the Employee Agent users table");
    }
  } finally {
    await connection.query("SELECT RELEASE_LOCK('employee_agent_schema_bootstrap')").catch(() => undefined);
    await connection.end();
  }

  const env = { ...process.env, DATABASE_URL: url, DATABASE_MIGRATION_URL: url };
  await run("pnpm", ["exec", "tsx", "scripts/db-migrate.ts", "apply"], env);
}

main().catch((error) => {
  console.error(`[DB-DEPLOY] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
