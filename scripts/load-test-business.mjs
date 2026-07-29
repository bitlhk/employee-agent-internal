#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = new URL(process.env.EA_BUSINESS_LOAD_TEST_URL || "http://127.0.0.1:5180");
const adoptId = String(process.env.EA_BUSINESS_LOAD_TEST_ADOPT_ID || "").trim();
const cookie = String(process.env.EA_BUSINESS_LOAD_TEST_COOKIE || "").trim();
const stages = String(process.env.EA_BUSINESS_LOAD_TEST_STAGES || "5,10,20")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0 && value <= 50);
const durationMs = Math.max(5_000, Number(process.env.EA_BUSINESS_LOAD_TEST_STAGE_SECONDS || 15) * 1000);
const timeoutMs = Math.max(1_000, Number(process.env.EA_BUSINESS_LOAD_TEST_TIMEOUT_MS || 10_000));
const outputDir = path.resolve(process.env.EA_BUSINESS_LOAD_TEST_OUTPUT_DIR || "data/load-tests");
const chatEnabled = process.env.EA_BUSINESS_LOAD_TEST_ENABLE_CHAT === "1";
const chatRequests = Math.min(5, Math.max(0, Number(process.env.EA_BUSINESS_LOAD_TEST_CHAT_REQUESTS || 0) || 0));
const internalKey = String(process.env.EA_BUSINESS_LOAD_TEST_INTERNAL_KEY || "").trim();

if (!adoptId) throw new Error("EA_BUSINESS_LOAD_TEST_ADOPT_ID is required");
if (!cookie) throw new Error("EA_BUSINESS_LOAD_TEST_COOKIE is required for authenticated read scenarios");
if (!stages.length) throw new Error("EA_BUSINESS_LOAD_TEST_STAGES must contain at least one positive integer");
if (chatRequests > 0 && !chatEnabled) {
  throw new Error("Set EA_BUSINESS_LOAD_TEST_ENABLE_CHAT=1 to allow paid model smoke requests");
}

const loopback = ["127.0.0.1", "localhost", "::1"].includes(baseUrl.hostname);
if (!loopback && process.env.EA_BUSINESS_LOAD_TEST_ALLOW_REMOTE !== "1") {
  throw new Error("Remote business load tests require EA_BUSINESS_LOAD_TEST_ALLOW_REMOTE=1");
}

const encodedAdoptId = encodeURIComponent(adoptId);
const scenarios = [
  { name: "health_summary", path: `/api/claw/health-summary?adoptId=${encodedAdoptId}`, weight: 20 },
  { name: "history_sessions", path: `/api/claw/chat-history/sessions?adoptId=${encodedAdoptId}&limit=50`, weight: 35 },
  { name: "runtime_info", path: `/api/claw/runtime-info?adoptId=${encodedAdoptId}`, weight: 15 },
  { name: "skill_registry", path: `/api/claw/skills/registry?adoptId=${encodedAdoptId}`, weight: 20 },
  { name: "mcp_status", path: `/api/claw/mcp-tools/status?adoptId=${encodedAdoptId}`, weight: 10 },
];

function chooseScenario(sequence) {
  const position = sequence % 100;
  let boundary = 0;
  for (const scenario of scenarios) {
    boundary += scenario.weight;
    if (position < boundary) return scenario;
  }
  return scenarios[scenarios.length - 1];
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = String(keyFn(item));
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

async function runReadStage(concurrency) {
  const deadline = Date.now() + durationMs;
  const samples = [];
  let sequence = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (Date.now() < deadline) {
      const scenario = chooseScenario(sequence++);
      const startedAt = performance.now();
      let status = 0;
      let error = "";
      try {
        const response = await fetch(new URL(scenario.path, baseUrl), {
          headers: { cookie },
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = response.status;
        await response.arrayBuffer();
      } catch (caught) {
        error = String(caught?.name || caught?.message || caught).slice(0, 120);
      }
      samples.push({ scenario: scenario.name, durationMs: performance.now() - startedAt, status, error });
      await new Promise((resolve) => setTimeout(resolve, 40 + Math.floor(Math.random() * 120)));
    }
  });
  await Promise.all(workers);

  const durations = samples.map((sample) => sample.durationMs);
  const errors = samples.filter((sample) => sample.error || sample.status < 200 || sample.status >= 400);
  return {
    concurrency,
    durationSeconds: durationMs / 1000,
    requests: samples.length,
    requestsPerSecond: Number((samples.length / (durationMs / 1000)).toFixed(2)),
    errorCount: errors.length,
    errorRate: Number((errors.length / Math.max(1, samples.length)).toFixed(4)),
    latencyMs: {
      p50: Number(percentile(durations, 0.5).toFixed(1)),
      p95: Number(percentile(durations, 0.95).toFixed(1)),
      p99: Number(percentile(durations, 0.99).toFixed(1)),
      max: Number(Math.max(0, ...durations).toFixed(1)),
    },
    statusCounts: countBy(samples, (sample) => sample.status || sample.error || "unknown"),
    scenarioCounts: countBy(samples, (sample) => sample.scenario),
  };
}

async function runChatSmoke(index) {
  const startedAt = performance.now();
  const conversationId = `loadtest_${Date.now().toString(36)}_${index}`;
  const headers = {
    "content-type": "application/json",
    cookie,
  };
  if (internalKey) headers["x-internal-key"] = internalKey;

  let status = 0;
  let error = "";
  let bytes = 0;
  try {
    const response = await fetch(new URL("/api/claw/chat-stream", baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({
        adoptId,
        message: "这是一次受控运行检查。请只回复：运行正常。",
        channel: "web",
        conversationId,
        clientRunId: `loadtest-${conversationId}`,
      }),
      signal: AbortSignal.timeout(Math.max(timeoutMs, 300_000)),
    });
    status = response.status;
    const body = await response.arrayBuffer();
    bytes = body.byteLength;
    if (status < 200 || status >= 400) {
      error = new TextDecoder().decode(body).slice(0, 200);
    }
  } catch (caught) {
    error = String(caught?.name || caught?.message || caught).slice(0, 200);
  }
  return {
    index,
    status,
    bytes,
    durationMs: Number((performance.now() - startedAt).toFixed(1)),
    error,
  };
}

const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  target: `${baseUrl.protocol}//${baseUrl.host}`,
  mode: "authenticated-business-read",
  adoptIdHashHint: adoptId.length > 8 ? `${adoptId.slice(0, 4)}...${adoptId.slice(-4)}` : "redacted",
  stages: [],
  chatSmoke: [],
};

for (const concurrency of stages) {
  const result = await runReadStage(concurrency);
  report.stages.push(result);
  console.log(`read concurrency=${concurrency} requests=${result.requests} rps=${result.requestsPerSecond} errors=${result.errorRate} p95=${result.latencyMs.p95}ms`);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}

for (let index = 1; index <= chatRequests; index += 1) {
  const result = await runChatSmoke(index);
  report.chatSmoke.push(result);
  console.log(`chat request=${index} status=${result.status || "error"} duration=${result.durationMs}ms bytes=${result.bytes}`);
}

report.completedAt = new Date().toISOString();
await mkdir(outputDir, { recursive: true });
const stamp = report.startedAt.replace(/[:.]/g, "-");
const outputPath = path.join(outputDir, `business-${stamp}.json`);
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`report=${outputPath}`);
