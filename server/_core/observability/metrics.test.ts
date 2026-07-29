import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginOperationalActivity,
  metricsRegistry,
  observeOperationalActivity,
} from "./metrics";

const temporaryDirectories: string[] = [];

afterEach(() => {
  delete process.env.BACKUP_STATUS_FILE;
  delete process.env.BACKUP_VALIDATION_STATUS_FILE;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("operational metrics", () => {
  it("exports backup freshness and bounded activity metrics", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "ea-metrics-"));
    temporaryDirectories.push(directory);
    const statusFile = path.join(directory, ".last-local-success");
    const validationStatusFile = path.join(directory, ".last-validated-success");
    writeFileSync(statusFile, new Date().toISOString());
    writeFileSync(validationStatusFile, new Date().toISOString());
    process.env.BACKUP_STATUS_FILE = statusFile;
    process.env.BACKUP_VALIDATION_STATUS_FILE = validationStatusFile;

    const finish = beginOperationalActivity("knowledge_search");
    observeOperationalActivity({ activity: "knowledge_search", outcome: "success", durationMs: 125 });
    finish();
    finish();

    const metrics = await metricsRegistry.metrics();
    expect(metrics).toContain("ea_backup_last_success_timestamp_seconds");
    expect(metrics).toContain("ea_backup_last_validation_timestamp_seconds");
    expect(metrics).toContain('ea_operational_activity_total{activity="knowledge_search",outcome="success"} 1');
    expect(metrics).toContain('ea_operational_activity_active{activity="knowledge_search"} 0');
  });
});
