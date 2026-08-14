#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

const wsUrl = new URL(process.env.EA_ENTERPRISE_LOAD_TEST_WS_URL || "ws://127.0.0.1:19002/ws");
const stages = String(process.env.EA_ENTERPRISE_LOAD_TEST_STAGES || "2,5,10")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0 && value <= 150);
const timeoutMs = Math.max(15_000, Number(process.env.EA_ENTERPRISE_LOAD_TEST_TIMEOUT_MS || 180_000));
const groupCount = Math.max(1, Math.min(16, Number(process.env.EA_ENTERPRISE_LOAD_TEST_GROUPS || 1)));
const groupOffset = Math.max(0, Number(process.env.EA_ENTERPRISE_LOAD_TEST_GROUP_OFFSET || 5));
const botId = String(process.env.EA_ENTERPRISE_LOAD_TEST_BOT_ID || "insurance-advisor").trim();
const mode = String(process.env.EA_ENTERPRISE_LOAD_TEST_MODE || "agent.fast").trim();
const outputDir = path.resolve(process.env.EA_ENTERPRISE_LOAD_TEST_OUTPUT_DIR || "data/load-tests");
const maxErrorRate = Math.max(0, Number(process.env.EA_ENTERPRISE_LOAD_TEST_MAX_ERROR_RATE || 0.02));
const maxP95TtftMs = Math.max(1, Number(process.env.EA_ENTERPRISE_LOAD_TEST_MAX_P95_TTFT_MS || 20_000));
const maxP95TotalMs = Math.max(1, Number(process.env.EA_ENTERPRISE_LOAD_TEST_MAX_P95_TOTAL_MS || 90_000));
const wsOrigin = `${wsUrl.protocol === "wss:" ? "https:" : "http:"}//${wsUrl.host}`;

if (!stages.length) throw new Error("EA_ENTERPRISE_LOAD_TEST_STAGES must contain a positive stage");
if (!botId) throw new Error("EA_ENTERPRISE_LOAD_TEST_BOT_ID is required");
if (!["ws:", "wss:"].includes(wsUrl.protocol)) throw new Error("Enterprise load target must use ws or wss");
const loopback = ["127.0.0.1", "localhost", "::1"].includes(wsUrl.hostname);
if (!loopback && process.env.EA_ENTERPRISE_LOAD_TEST_ALLOW_REMOTE !== "1") {
  throw new Error("Remote enterprise runtime load tests require EA_ENTERPRISE_LOAD_TEST_ALLOW_REMOTE=1");
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
}

function payloadOf(frame) {
  return frame?.payload && typeof frame.payload === "object"
    ? frame.payload
    : frame?.data && typeof frame.data === "object"
      ? frame.data
      : {};
}

function runConversation({ stage, index, runId }) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const requestId = `${runId}:${stage}:${index}`;
    const sessionId = `ea-load-${runId}-${stage}-${index}`;
    const userId = `ea_load_${runId}_${stage}_${index}`;
    const groupId = `ea_s${groupOffset + (index % groupCount)}`;
    const ws = new WebSocket(wsUrl, { headers: { Origin: wsOrigin } });
    let sent = false;
    let firstTokenAt = 0;
    let text = "";
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(1000, "load probe complete"); } catch {}
      resolve({
        stage,
        index,
        groupId,
        userId,
        sessionId,
        ttftMs: firstTokenAt ? firstTokenAt - startedAt : 0,
        totalMs: performance.now() - startedAt,
        outputBytes: Buffer.byteLength(text, "utf8"),
        ...result,
      });
    };
    const send = () => {
      if (sent || ws.readyState !== WebSocket.OPEN) return;
      sent = true;
      ws.send(JSON.stringify({
        type: "req",
        id: requestId,
        method: "chat.send",
        params: {
          session_id: sessionId,
          content: "并发容量验证。不要调用任何工具，只回复 ENTERPRISE_OK。",
          query: "并发容量验证。不要调用任何工具，只回复 ENTERPRISE_OK。",
          mode,
          group_id: groupId,
          bot_id: botId,
          user_id: userId,
          interactive_ask: true,
          request_metadata: {
            source_channel: userId,
            ea_managed_runtime: true,
            ea_binding_id: `rtb_${userId}`,
            ea_source_agent_id: `agent_${userId}`,
          },
        },
      }));
    };
    const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs);
    ws.on("open", () => setTimeout(send, 2_000));
    ws.on("message", (raw) => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (frame.type === "event" && frame.event === "connection.ack") {
        send();
        return;
      }
      if (frame.type === "res" && frame.id === requestId && frame.ok === false) {
        finish({ ok: false, error: String(frame.error || "request_failed") });
        return;
      }
      if (frame.type !== "event") return;
      const payload = payloadOf(frame);
      if (frame.event === "chat.delta") {
        const chunk = payload.delta || payload.content || payload.text || "";
        if (typeof chunk === "string" && chunk) {
          if (!firstTokenAt) firstTokenAt = performance.now();
          text += chunk;
        }
      }
      if (frame.event === "chat.final" || frame.event === "chat.done") {
        finish({
          ok: text.includes("ENTERPRISE_OK"),
          error: text.includes("ENTERPRISE_OK") ? "" : "unexpected_output",
        });
      }
    });
    ws.on("error", (error) => finish({ ok: false, error: String(error?.message || error) }));
    ws.on("close", () => {
      if (!settled) finish({ ok: false, error: "connection_closed" });
    });
  });
}

function summarize(stage, samples) {
  const successes = samples.filter((sample) => sample.ok);
  const errors = samples.filter((sample) => !sample.ok);
  const ttft = successes.map((sample) => sample.ttftMs);
  const total = successes.map((sample) => sample.totalMs);
  return {
    concurrency: stage,
    requests: samples.length,
    successCount: successes.length,
    errorCount: errors.length,
    errorRate: Number((errors.length / Math.max(1, samples.length)).toFixed(4)),
    ttftMs: {
      p50: Number(percentile(ttft, 0.5).toFixed(1)),
      p95: Number(percentile(ttft, 0.95).toFixed(1)),
      max: Number(Math.max(0, ...ttft).toFixed(1)),
    },
    totalMs: {
      p50: Number(percentile(total, 0.5).toFixed(1)),
      p95: Number(percentile(total, 0.95).toFixed(1)),
      max: Number(Math.max(0, ...total).toFixed(1)),
    },
    errorCounts: Object.fromEntries(Object.entries(Object.groupBy(errors, (sample) => sample.error || "unknown")).map(([key, values]) => [key, values.length])),
    samples,
  };
}

const runId = Date.now().toString(36);
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  target: `${wsUrl.protocol}//${wsUrl.host}${wsUrl.pathname}`,
  mode: "enterprise-runtime-minimal-chat",
  botId,
  groupCount,
  stages: [],
};

for (const stage of stages) {
  const samples = await Promise.all(Array.from({ length: stage }, (_, index) => runConversation({ stage, index, runId })));
  const summary = summarize(stage, samples);
  report.stages.push(summary);
  console.log(`concurrency=${stage} success=${summary.successCount}/${summary.requests} ttft_p95=${summary.ttftMs.p95}ms total_p95=${summary.totalMs.p95}ms errors=${summary.errorRate}`);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}

const failedStages = report.stages.filter((stage) => (
  stage.errorRate > maxErrorRate
  || stage.ttftMs.p95 > maxP95TtftMs
  || stage.totalMs.p95 > maxP95TotalMs
));
report.acceptance = {
  passed: failedStages.length === 0,
  maxErrorRate,
  maxP95TtftMs,
  maxP95TotalMs,
  failedStageConcurrencies: failedStages.map((stage) => stage.concurrency),
};
report.completedAt = new Date().toISOString();
await mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, `enterprise-runtime-${report.startedAt.replace(/[:.]/g, "-")}.json`);
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`report=${outputPath}`);
console.log(`acceptance=${report.acceptance.passed ? "passed" : "failed"}`);
if (!report.acceptance.passed) process.exitCode = 1;
