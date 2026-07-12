import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { pruneJsonLogFile, retentionDaysForLog } from "./retained-json-log";

afterEach(() => {
  delete process.env.APP_LOG_RETENTION_DAYS;
  delete process.env.AUDIT_LOG_RETENTION_DAYS;
});

describe("JSON log retention", () => {
  it("uses separate defaults for runtime and audit logs", () => {
    expect(retentionDaysForLog("claw-exec.log")).toBe(30);
    expect(retentionDaysForLog("claw-exec-detail.log")).toBe(730);
    expect(retentionDaysForLog("security-audit.log")).toBe(730);
  });

  it("removes expired JSON records while preserving recent and unparseable lines", async () => {
    process.env.APP_LOG_RETENTION_DAYS = "30";
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-log-retention-"));
    const file = path.join(root, "runtime.log");
    const now = Date.UTC(2026, 6, 12);
    writeFileSync(file, [
      JSON.stringify({ ts: "2026-05-01T00:00:00.000Z", event: "old" }),
      JSON.stringify({ ts: "2026-07-01T00:00:00.000Z", event: "recent" }),
      "legacy unstructured line",
      "",
    ].join("\n"));
    try {
      await pruneJsonLogFile(file, now);
      const content = readFileSync(file, "utf8");
      expect(content).not.toContain('"event":"old"');
      expect(content).toContain('"event":"recent"');
      expect(content).toContain("legacy unstructured line");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
