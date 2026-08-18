#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import {
  browserMutationHeaders,
  loadTestProfiles,
  trpcKnowledgeSearchPath,
} from "./lib/load-test-profiles.mjs";

const baseUrl = new URL(process.env.EA_BUSINESS_LOAD_TEST_URL || "http://127.0.0.1:5180");
const adoptId = String(process.env.EA_BUSINESS_LOAD_TEST_ADOPT_ID || "").trim();
const cookie = String(process.env.EA_BUSINESS_LOAD_TEST_COOKIE || "").trim();
const knowledgeBaseId = String(process.env.EA_BUSINESS_LOAD_TEST_KNOWLEDGE_BASE_ID || "").trim();
const profileFile = String(process.env.EA_BUSINESS_LOAD_TEST_PROFILE_FILE || "").trim();
const mutationOrigin = String(process.env.EA_BUSINESS_LOAD_TEST_ORIGIN || "").trim();
const stages = String(process.env.EA_BUSINESS_LOAD_TEST_STAGES || "5,10,20")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0 && value <= 200);
const durationMs = Math.max(5_000, Number(process.env.EA_BUSINESS_LOAD_TEST_STAGE_SECONDS || 15) * 1000);
const timeoutMs = Math.max(1_000, Number(process.env.EA_BUSINESS_LOAD_TEST_TIMEOUT_MS || 10_000));
const prewarmEnabled = process.env.EA_BUSINESS_LOAD_TEST_PREWARM === "1";
const prewarmConcurrency = Math.min(
  30,
  Math.max(1, Number(process.env.EA_BUSINESS_LOAD_TEST_PREWARM_CONCURRENCY || 10) || 10),
);
const outputDir = path.resolve(process.env.EA_BUSINESS_LOAD_TEST_OUTPUT_DIR || "data/load-tests");
const chatEnabled = process.env.EA_BUSINESS_LOAD_TEST_ENABLE_CHAT === "1";
const chatRequests = Math.min(200, Math.max(0, Number(process.env.EA_BUSINESS_LOAD_TEST_CHAT_REQUESTS || 0) || 0));
const chatConcurrency = Math.min(
  200,
  Math.max(1, Number(process.env.EA_BUSINESS_LOAD_TEST_CHAT_CONCURRENCY || Math.min(chatRequests || 1, 10)) || 1),
);
const chatMessage = String(
  process.env.EA_BUSINESS_LOAD_TEST_CHAT_MESSAGE
  || "这是一次受控运行检查。请只回复：运行正常。",
).slice(0, 1000);
const chatModel = String(process.env.EA_BUSINESS_LOAD_TEST_CHAT_MODEL || "__auto").trim().slice(0, 120);
const requireChatToolEvent = process.env.EA_BUSINESS_LOAD_TEST_REQUIRE_TOOL_EVENT === "1";
const allowPermissionRequest = process.env.EA_BUSINESS_LOAD_TEST_ALLOW_PERMISSION_REQUEST === "1";
const expectedToolFragments = String(process.env.EA_BUSINESS_LOAD_TEST_EXPECT_TOOL_FRAGMENTS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const sandboxEnabled = process.env.EA_BUSINESS_LOAD_TEST_ENABLE_SANDBOX === "1";
const sandboxRequests = Math.min(200, Math.max(0, Number(process.env.EA_BUSINESS_LOAD_TEST_SANDBOX_REQUESTS || 0) || 0));
const sandboxConcurrency = Math.min(
  200,
  Math.max(1, Number(process.env.EA_BUSINESS_LOAD_TEST_SANDBOX_CONCURRENCY || Math.min(sandboxRequests || 1, 5)) || 1),
);
const internalKey = String(process.env.EA_BUSINESS_LOAD_TEST_INTERNAL_KEY || "").trim();
const maxErrorRate = Math.max(0, Number(process.env.EA_BUSINESS_LOAD_TEST_MAX_ERROR_RATE || 0.01));
const maxP95Ms = Math.max(1, Number(process.env.EA_BUSINESS_LOAD_TEST_MAX_P95_MS || 1500));
const loadTestAgents = {
  "http:": new http.Agent({ keepAlive: true, maxSockets: 250, maxFreeSockets: 50 }),
  "https:": new https.Agent({ keepAlive: true, maxSockets: 250, maxFreeSockets: 50 }),
};

if (!stages.length) throw new Error("EA_BUSINESS_LOAD_TEST_STAGES must contain at least one positive integer");
if (chatRequests > 0 && !chatEnabled) {
  throw new Error("Set EA_BUSINESS_LOAD_TEST_ENABLE_CHAT=1 to allow paid model smoke requests");
}
if (sandboxRequests > 0 && !sandboxEnabled) {
  throw new Error("Set EA_BUSINESS_LOAD_TEST_ENABLE_SANDBOX=1 to allow sandbox smoke requests");
}

const loopback = ["127.0.0.1", "localhost", "::1"].includes(baseUrl.hostname);
if (!loopback && process.env.EA_BUSINESS_LOAD_TEST_ALLOW_REMOTE !== "1") {
  throw new Error("Remote business load tests require EA_BUSINESS_LOAD_TEST_ALLOW_REMOTE=1");
}

const profiles = await loadTestProfiles({
  profileFile,
  adoptId,
  cookie,
  knowledgeBaseId,
});
const knowledgeQuery = String(
  process.env.EA_BUSINESS_LOAD_TEST_KNOWLEDGE_QUERY || "企业制度、岗位职责与风险要求",
).slice(0, 400);
const scenarios = [
  { name: "history_sessions", path: (profile) => `/api/claw/chat-history/sessions?adoptId=${encodeURIComponent(profile.adoptId)}&limit=50`, weight: 30 },
  { name: "skill_registry", path: (profile) => `/api/claw/skills/registry?adoptId=${encodeURIComponent(profile.adoptId)}`, weight: 20 },
  { name: "mcp_status", path: (profile) => `/api/claw/mcp-tools/status?adoptId=${encodeURIComponent(profile.adoptId)}`, weight: 20 },
  { name: "file_capabilities", path: (profile) => `/api/claw/files/capabilities?adoptId=${encodeURIComponent(profile.adoptId)}`, weight: 10 },
  { name: "channel_capabilities", path: (profile) => `/api/claw/channels/capabilities?adoptId=${encodeURIComponent(profile.adoptId)}`, weight: 10 },
  { name: "knowledge_search", path: (profile) => trpcKnowledgeSearchPath(profile, knowledgeQuery), weight: 10, requiresKnowledge: true },
];
const requestedScenarioNames = new Set(
  String(process.env.EA_BUSINESS_LOAD_TEST_SCENARIOS || "")
    .split(",").map((value) => value.trim()).filter(Boolean),
);
const activeScenarios = requestedScenarioNames.size > 0
  ? scenarios.filter((scenario) => requestedScenarioNames.has(scenario.name))
  : scenarios;
if (!activeScenarios.length) throw new Error("EA_BUSINESS_LOAD_TEST_SCENARIOS did not match a known scenario");

function weightedSchedule(items) {
  const totalWeight = items.reduce((total, item) => total + item.weight, 0);
  const scores = new Map(items.map((item) => [item.name, 0]));
  return Array.from({ length: totalWeight }, () => {
    let selected = items[0];
    for (const item of items) {
      const score = (scores.get(item.name) || 0) + item.weight;
      scores.set(item.name, score);
      if (score > (scores.get(selected.name) || 0)) selected = item;
    }
    scores.set(selected.name, (scores.get(selected.name) || 0) - totalWeight);
    return selected;
  });
}

const scenarioSchedule = weightedSchedule(activeScenarios);

function chooseScenario(sequence, profile) {
  for (let offset = 0; offset < scenarioSchedule.length; offset += 1) {
    const scenario = scenarioSchedule[(sequence + offset) % scenarioSchedule.length];
    if (!scenario.requiresKnowledge || profile.knowledgeBaseId) return scenario;
  }
  return activeScenarios[0];
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

function latencySummary(items) {
  const durations = items.map((item) => item.durationMs);
  return {
    p50: Number(percentile(durations, 0.5).toFixed(1)),
    p95: Number(percentile(durations, 0.95).toFixed(1)),
    p99: Number(percentile(durations, 0.99).toFixed(1)),
    max: Number(Math.max(0, ...durations).toFixed(1)),
  };
}

function parseSseEvents(body) {
  const events = [];
  for (const block of String(body || "").split(/\r?\n\r?\n/u)) {
    const lines = block.split(/\r?\n/u);
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") continue;
    let payload = data;
    try { payload = JSON.parse(data); } catch {}
    events.push({ event, payload });
  }
  return events;
}

function requestChatStream(url, headers, payload, timeout) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const transport = url.protocol === "https:" ? https : http;
    const startedAt = performance.now();
    const request = transport.request(url, {
      method: "POST",
      headers: {
        ...headers,
        "content-length": Buffer.byteLength(body),
      },
      agent: loadTestAgents[url.protocol],
    }, (response) => {
      let responseBody = "";
      let bytes = 0;
      let firstByteMs = 0;
      let firstToolEventMs = 0;
      response.on("data", (chunk) => {
        if (!firstByteMs) firstByteMs = performance.now() - startedAt;
        bytes += chunk.length;
        responseBody += chunk.toString("utf8");
        if (!firstToolEventMs && responseBody.includes("event: tool_call")) {
          firstToolEventMs = performance.now() - startedAt;
        }
        if (responseBody.length > 1_000_000) responseBody = responseBody.slice(-500_000);
      });
      response.on("end", () => resolve({
        status: response.statusCode || 0,
        body: responseBody,
        bytes,
        firstByteMs,
        firstToolEventMs,
      }));
      response.on("error", reject);
    });
    request.setTimeout(timeout, () => request.destroy(new Error(`chat request timed out after ${timeout}ms`)));
    request.on("error", reject);
    request.end(body);
  });
}

async function preflightProfile(profile, index) {
  const startedAt = performance.now();
  let status = 0;
  let authenticated = false;
  let error = "";
  try {
    const input = encodeURIComponent(JSON.stringify({ json: null }));
    const response = await fetch(new URL(`/api/trpc/auth.me?input=${input}`, baseUrl), {
      headers: { cookie: profile.cookie },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    const body = await response.text();
    const parsed = JSON.parse(body);
    const user = parsed?.result?.data?.json ?? parsed?.result?.data ?? null;
    authenticated = Boolean(user?.id);
    if (status < 200 || status >= 300) error = body.slice(0, 200);
    else if (!authenticated) error = "session preflight returned no authenticated user";
  } catch (caught) {
    error = String(caught?.name || caught?.message || caught).slice(0, 200);
  }
  return {
    index,
    adoptId: profile.adoptId,
    status,
    authenticated,
    durationMs: Number((performance.now() - startedAt).toFixed(1)),
    error,
  };
}

async function prewarmProfile(profile, index) {
  const startedAt = performance.now();
  const checks = [];
  for (const scenario of scenarios.filter((item) => (
    ["history_sessions", "skill_registry", "mcp_status"].includes(item.name)
  ))) {
    let status = 0;
    let error = "";
    try {
      const response = await fetch(new URL(scenario.path(profile), baseUrl), {
        headers: { cookie: profile.cookie },
        redirect: "manual",
        signal: AbortSignal.timeout(Math.max(timeoutMs, 60_000)),
      });
      status = response.status;
      await response.arrayBuffer();
      if (status < 200 || status >= 300) error = `HTTP ${status}`;
    } catch (caught) {
      error = String(caught?.name || caught?.message || caught).slice(0, 120);
    }
    checks.push({ scenario: scenario.name, status, error });
  }
  return {
    index,
    adoptId: profile.adoptId,
    checks,
    durationMs: Number((performance.now() - startedAt).toFixed(1)),
    error: checks.find((check) => check.error)?.error || "",
  };
}

async function runBoundedBatch(count, concurrency, worker) {
  const results = new Array(count);
  let next = 0;
  const workers = Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (true) {
      const index = next++;
      if (index >= count) return;
      results[index] = await worker(index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runReadStage(concurrency) {
  const deadline = Date.now() + durationMs;
  const samples = [];
  let sequence = 0;
  const workers = Array.from({ length: concurrency }, async (_, workerIndex) => {
    const profile = profiles[workerIndex % profiles.length];
    while (Date.now() < deadline) {
      const scenario = chooseScenario(sequence++, profile);
      const startedAt = performance.now();
      let status = 0;
      let error = "";
      try {
        const response = await fetch(new URL(scenario.path(profile), baseUrl), {
          headers: { cookie: profile.cookie },
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

  const errors = samples.filter((sample) => sample.error || sample.status < 200 || sample.status >= 300);
  const byScenario = Object.groupBy(samples, (sample) => sample.scenario);
  return {
    concurrency,
    durationSeconds: durationMs / 1000,
    requests: samples.length,
    requestsPerSecond: Number((samples.length / (durationMs / 1000)).toFixed(2)),
    errorCount: errors.length,
    errorRate: Number((errors.length / Math.max(1, samples.length)).toFixed(4)),
    latencyMs: latencySummary(samples),
    scenarioLatencyMs: Object.fromEntries(
      Object.entries(byScenario).map(([name, items]) => [name, latencySummary(items)]),
    ),
    statusCounts: countBy(samples, (sample) => sample.status || sample.error || "unknown"),
    scenarioCounts: countBy(samples, (sample) => sample.scenario),
    scenarioErrorCounts: countBy(errors, (sample) => sample.scenario),
  };
}

async function runChatSmoke(index, profile) {
  const startedAt = performance.now();
  const conversationId = `loadtest_${Date.now().toString(36)}_${index}`;
  const headers = browserMutationHeaders(profile.cookie, mutationOrigin);
  if (internalKey) headers["x-internal-key"] = internalKey;

  let status = 0;
  let error = "";
  let bytes = 0;
  let completed = false;
  let observedToolEvent = false;
  let firstByteMs = 0;
  let firstToolEventMs = 0;
  let selectedModel = "";
  let toolNames = [];
  let permissionRequired = false;
  let permissionToolName = "";
  try {
    const response = await requestChatStream(
      new URL("/api/claw/chat-stream", baseUrl),
      headers,
      {
        adoptId: profile.adoptId,
        message: chatMessage,
        model: chatModel,
        channel: "web",
        conversationId,
        clientRunId: `loadtest-${conversationId}`,
        ...(profile.selectedSkillId ? { selectedSkillIds: [profile.selectedSkillId] } : {}),
      },
      Math.max(timeoutMs, 300_000),
    );
    status = response.status;
    const body = response.body;
    bytes = response.bytes;
    firstByteMs = response.firstByteMs;
    firstToolEventMs = response.firstToolEventMs;
    completed = body.includes("data: [DONE]");
    observedToolEvent = body.includes("event: tool_call");
    selectedModel = body.match(/"__model_selected"\s*:\s*"([^"]+)"/)?.[1] || "";
    const events = parseSseEvents(body);
    toolNames = Array.from(new Set(events
      .filter((event) => event.event === "tool_call")
      .map((event) => String(event.payload?.name || "").trim())
      .filter(Boolean)));
    const runtimeError = events.find((event) => (
      event.event === "error"
      || (event.payload && typeof event.payload === "object" && event.payload.__stream_error === true)
    ));
    const permissionRequest = events.find((event) => event.event === "jiuwen_permission_request");
    permissionRequired = Boolean(permissionRequest);
    permissionToolName = String(permissionRequest?.payload?.toolName || "").trim();
    if (status < 200 || status >= 400) {
      error = body.slice(0, 200);
    } else if (!completed) {
      error = "chat stream ended without completion marker";
    } else if (runtimeError) {
      error = `chat stream emitted an error event: ${JSON.stringify(runtimeError.payload).slice(0, 160)}`;
    } else if (permissionRequired && !allowPermissionRequest) {
      error = `chat stream stopped for a permission request${permissionToolName ? `: ${permissionToolName}` : ""}`;
    } else if (requireChatToolEvent && !observedToolEvent) {
      error = "chat stream completed without a tool event";
    } else {
      const missing = expectedToolFragments.filter(
        (fragment) => !toolNames.some((toolName) => toolName.includes(fragment)),
      );
      if (missing.length > 0) error = `chat stream missed expected tools: ${missing.join(", ")}`;
    }
  } catch (caught) {
    error = String(caught?.name || caught?.message || caught).slice(0, 200);
  }
  return {
    index,
    status,
    bytes,
    durationMs: Number((performance.now() - startedAt).toFixed(1)),
    firstByteMs: Number(firstByteMs.toFixed(1)),
    firstToolEventMs: Number(firstToolEventMs.toFixed(1)),
    completed,
    observedToolEvent,
    selectedModel,
    toolNames,
    permissionRequired,
    permissionToolName,
    error,
  };
}

async function runSandboxSmoke(index, profile) {
  const startedAt = performance.now();
  let status = 0;
  let error = "";
  let markerObserved = false;
  try {
    const response = await fetch(new URL("/api/claw/sandbox/exec", baseUrl), {
      method: "POST",
      headers: {
        ...browserMutationHeaders(profile.cookie, mutationOrigin),
      },
      body: JSON.stringify({
        adoptId: profile.adoptId,
        command: "printf EA_SANDBOX_OK",
        timeoutMs: 30_000,
      }),
      signal: AbortSignal.timeout(Math.max(timeoutMs, 45_000)),
    });
    status = response.status;
    const body = await response.text();
    markerObserved = body.includes("EA_SANDBOX_OK");
    if (status < 200 || status >= 400) {
      error = body.slice(0, 200);
    } else if (!markerObserved) {
      error = "sandbox response did not contain the expected marker";
    }
  } catch (caught) {
    error = String(caught?.name || caught?.message || caught).slice(0, 200);
  }
  return {
    index,
    status,
    markerObserved,
    durationMs: Number((performance.now() - startedAt).toFixed(1)),
    error,
  };
}

const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  target: `${baseUrl.protocol}//${baseUrl.host}`,
  mode: "authenticated-multi-user-business",
  profileCount: profiles.length,
  profilesWithKnowledge: profiles.filter((profile) => profile.knowledgeBaseId).length,
  profilePreflight: [],
  profilePrewarm: [],
  stages: [],
  chatSmoke: [],
  sandboxSmoke: [],
};

report.profilePreflight = await runBoundedBatch(profiles.length, Math.min(30, profiles.length), async (offset) => (
  preflightProfile(profiles[offset], offset + 1)
));
const failedPreflight = report.profilePreflight.filter((sample) => sample.error);
console.log(`profile preflight=${profiles.length} authenticated=${profiles.length - failedPreflight.length} failed=${failedPreflight.length}`);

if (prewarmEnabled && failedPreflight.length === 0) {
  report.profilePrewarm = await runBoundedBatch(profiles.length, prewarmConcurrency, async (offset) => (
    prewarmProfile(profiles[offset], offset + 1)
  ));
  const failed = report.profilePrewarm.filter((sample) => sample.error);
  console.log(`profile prewarm=${profiles.length} ready=${profiles.length - failed.length} failed=${failed.length}`);
}

for (const concurrency of stages) {
  const result = await runReadStage(concurrency);
  report.stages.push(result);
  console.log(`read concurrency=${concurrency} requests=${result.requests} rps=${result.requestsPerSecond} errors=${result.errorRate} p95=${result.latencyMs.p95}ms`);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}

report.chatSmoke = await runBoundedBatch(chatRequests, chatConcurrency, async (offset) => {
  const index = offset + 1;
  const result = await runChatSmoke(index, profiles[offset % profiles.length]);
  console.log(`chat request=${index} status=${result.status || "error"} duration=${result.durationMs}ms bytes=${result.bytes}`);
  return result;
});
report.chatModel = chatModel;
report.chatModelDistribution = countBy(report.chatSmoke, (sample) => sample.selectedModel || "unknown");
report.chatLatencyMs = latencySummary(report.chatSmoke);
report.chatFirstByteMs = latencySummary(
  report.chatSmoke.map((sample) => ({ durationMs: sample.firstByteMs })),
);
report.chatFirstToolEventMs = latencySummary(
  report.chatSmoke
    .filter((sample) => sample.firstToolEventMs > 0)
    .map((sample) => ({ durationMs: sample.firstToolEventMs })),
);
report.chatToolDistribution = countBy(
  report.chatSmoke.flatMap((sample) => sample.toolNames),
  (toolName) => toolName,
);

report.sandboxSmoke = await runBoundedBatch(sandboxRequests, sandboxConcurrency, async (offset) => {
  const index = offset + 1;
  const result = await runSandboxSmoke(index, profiles[offset % profiles.length]);
  console.log(`sandbox request=${index} status=${result.status || "error"} duration=${result.durationMs}ms marker=${result.markerObserved}`);
  return result;
});

const failedStages = report.stages.filter(
  (stage) => (
    stage.requests < stage.concurrency
    || stage.errorRate > maxErrorRate
    || stage.latencyMs.p95 > maxP95Ms
  ),
);
const failedPrewarm = report.profilePrewarm.filter((sample) => sample.error);
const failedChat = report.chatSmoke.filter((sample) => sample.error);
const failedSandbox = report.sandboxSmoke.filter((sample) => sample.error);
report.acceptance = {
  passed: failedPreflight.length === 0 && failedPrewarm.length === 0 && failedStages.length === 0 && failedChat.length === 0 && failedSandbox.length === 0,
  maxErrorRate,
  maxP95Ms,
  failedProfilePreflight: failedPreflight.map((sample) => sample.index),
  failedProfilePrewarm: failedPrewarm.map((sample) => sample.index),
  failedStageConcurrencies: failedStages.map((stage) => stage.concurrency),
  failedChatRequests: failedChat.map((sample) => sample.index),
  failedSandboxRequests: failedSandbox.map((sample) => sample.index),
};
report.completedAt = new Date().toISOString();
await mkdir(outputDir, { recursive: true });
const stamp = report.startedAt.replace(/[:.]/g, "-");
const outputPath = path.join(outputDir, `business-${stamp}.json`);
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`report=${outputPath}`);
console.log(`acceptance=${report.acceptance.passed ? "passed" : "failed"}`);
if (!report.acceptance.passed) process.exitCode = 1;
