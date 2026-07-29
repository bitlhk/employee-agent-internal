#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = new URL(process.env.EA_LOAD_TEST_URL || "http://127.0.0.1:5174");
const stages = String(process.env.EA_LOAD_TEST_STAGES || "10,30,50")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0 && value <= 500);
const durationMs = Math.max(5_000, Number(process.env.EA_LOAD_TEST_STAGE_SECONDS || 15) * 1000);
const timeoutMs = Math.max(1_000, Number(process.env.EA_LOAD_TEST_TIMEOUT_MS || 5_000));
const outputDir = path.resolve(process.env.EA_LOAD_TEST_OUTPUT_DIR || "data/load-tests");
const cookie = String(process.env.EA_LOAD_TEST_COOKIE || "").trim();

if (!stages.length) throw new Error("EA_LOAD_TEST_STAGES must contain at least one positive integer");
const loopback = ["127.0.0.1", "localhost", "::1"].includes(baseUrl.hostname);
if (!loopback && process.env.EA_LOAD_TEST_ALLOW_REMOTE !== "1") {
  throw new Error("Remote load tests require EA_LOAD_TEST_ALLOW_REMOTE=1");
}

const scenarios = [
  { name: "live", path: "/health/live", weight: 10 },
  { name: "ready", path: "/health/ready", weight: 15 },
  { name: "brand", path: "/api/brand", weight: 15 },
  { name: "app", path: "/", weight: 60 },
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

async function runStage(concurrency) {
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
          headers: cookie ? { cookie } : undefined,
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = response.status;
        await response.arrayBuffer();
      } catch (caught) {
        error = String(caught?.name || caught?.message || caught).slice(0, 80);
      }
      samples.push({ scenario: scenario.name, durationMs: performance.now() - startedAt, status, error });
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 100)));
    }
  });
  await Promise.all(workers);
  const durations = samples.map((sample) => sample.durationMs);
  const errors = samples.filter((sample) => sample.error || sample.status < 200 || sample.status >= 400);
  const elapsedSeconds = durationMs / 1000;
  return {
    concurrency,
    durationSeconds: elapsedSeconds,
    requests: samples.length,
    requestsPerSecond: Number((samples.length / elapsedSeconds).toFixed(2)),
    errorCount: errors.length,
    errorRate: Number((errors.length / Math.max(1, samples.length)).toFixed(4)),
    latencyMs: {
      p50: Number(percentile(durations, 0.5).toFixed(1)),
      p95: Number(percentile(durations, 0.95).toFixed(1)),
      p99: Number(percentile(durations, 0.99).toFixed(1)),
      max: Number(Math.max(0, ...durations).toFixed(1)),
    },
    statusCounts: Object.fromEntries(Object.entries(Object.groupBy(samples, (sample) => String(sample.status || sample.error || "unknown"))).map(([key, items]) => [key, items.length])),
    scenarioCounts: Object.fromEntries(Object.entries(Object.groupBy(samples, (sample) => sample.scenario)).map(([key, items]) => [key, items.length])),
  };
}

const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  target: `${baseUrl.protocol}//${baseUrl.host}`,
  mode: "read-only-platform",
  stages: [],
};

for (const concurrency of stages) {
  const result = await runStage(concurrency);
  report.stages.push(result);
  console.log(`concurrency=${concurrency} requests=${result.requests} rps=${result.requestsPerSecond} errors=${result.errorRate} p95=${result.latencyMs.p95}ms p99=${result.latencyMs.p99}ms`);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}

report.completedAt = new Date().toISOString();
await mkdir(outputDir, { recursive: true });
const stamp = report.startedAt.replace(/[:.]/g, "-");
const outputPath = path.join(outputDir, `capacity-${stamp}.json`);
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`report=${outputPath}`);
