import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginChatRequest,
  beginMcpCall,
  beginOperationalActivity,
  beginRuntimeCall,
  beginSandboxExecution,
  configureDbPoolMetrics,
  metricsRegistry,
  observeDbPoolEvent,
  observeOperationalActivity,
  setBackgroundWorkerState,
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

  it("records bounded runtime, MCP, sandbox, database, and worker dimensions", async () => {
    const chat = beginChatRequest("jiuwenswarm");
    chat.observeFirstToken();
    chat.observeFirstToken();
    chat.finish("success");
    beginRuntimeCall("jiuwenswarm")("success");
    beginMcpCall("platform")("error");
    beginSandboxExecution()("timeout", 250);
    configureDbPoolMetrics({ connectionLimit: 10, maxIdle: 2, queueLimit: 100 });
    observeDbPoolEvent("acquire");
    observeDbPoolEvent("release");
    observeDbPoolEvent("release");
    setBackgroundWorkerState("recycler", "running");

    const output = await metricsRegistry.metrics();
    expect(output).toContain('ea_chat_requests_total{runtime="jiuwenswarm",outcome="success"} 1');
    expect(output).toContain('ea_runtime_calls_total{runtime="jiuwenswarm",outcome="success"} 1');
    expect(output).toContain('ea_mcp_calls_total{kind="platform",outcome="error"} 1');
    expect(output).toContain('ea_sandbox_executions_total{outcome="timeout"} 1');
    expect(output).toContain('ea_db_pool_connections{state="active"} 0');
    expect(output).toContain('ea_background_worker_state{worker="recycler",state="running"} 1');
  });
});
