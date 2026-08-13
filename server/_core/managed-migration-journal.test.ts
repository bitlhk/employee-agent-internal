import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readMigrationFiles } from "drizzle-orm/migrator";

describe("managed migration journal", () => {
  it("registers every managed SQL migration exactly once", () => {
    const managedRoot = path.join(process.cwd(), "drizzle", "managed");
    const sqlTags = readdirSync(managedRoot)
      .filter((file) => /^\d{4}_.+\.sql$/u.test(file))
      .map((file) => file.replace(/\.sql$/u, ""))
      .sort();
    const journal = JSON.parse(
      readFileSync(path.join(managedRoot, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const journalTags = journal.entries.map((entry) => entry.tag).sort();

    expect(journalTags).toEqual(sqlTags);
    expect(new Set(journalTags).size).toBe(journalTags.length);
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_, index) => index),
    );
  });

  it("separates every SQL statement for the Drizzle migration runner", () => {
    const managedRoot = path.join(process.cwd(), "drizzle", "managed");
    const migrations = readMigrationFiles({ migrationsFolder: managedRoot });

    for (const migration of migrations) {
      const tag = migration.folderMillis;
      const journal = JSON.parse(
        readFileSync(path.join(managedRoot, "meta", "_journal.json"), "utf8"),
      ) as { entries: Array<{ when: number; tag: string }> };
      const entry = journal.entries.find((candidate) => candidate.when === tag);
      expect(entry, `missing journal entry for ${tag}`).toBeDefined();
      const rawSql = readFileSync(path.join(managedRoot, `${entry!.tag}.sql`), "utf8");
      const createTableCount = rawSql.match(/^CREATE TABLE\b/gimu)?.length ?? 0;
      expect(migration.sql.length, entry!.tag).toBeGreaterThanOrEqual(createTableCount);
    }
  });
});
