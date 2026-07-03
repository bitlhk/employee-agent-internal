#!/usr/bin/env -S npx tsx
/**
 * check-agent-chat-health.ts
 *
 * Read-only health summary for Workforce Agent Platform chat runtime migration.
 *
 * Typical use:
 *   pnpm tsx scripts/check-agent-chat-health.ts --since-minutes 720
 *   pnpm tsx scripts/check-agent-chat-health.ts --since-minutes 1440 --strict
 *   pnpm tsx scripts/check-agent-chat-health.ts --json
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

type JsonRecord = Record<string, unknown>;

const argv = process.argv.slice(2);
const JSON_MODE = argv.includes("--json");
const STRICT = argv.includes("--strict");
const SINCE_MINUTES = numberArg("--since-minutes", 24 * 60);
const LOG_DIR = process.env.EA_LOG_DIR || process.env.LINGXIA_LOG_DIR || "logs";
const cutoffMs = Date.now() - SINCE_MINUTES * 60 * 1000;

function numberArg(name: string, fallback: number) {
  const idx = argv.indexOf(name);
  if (idx < 0) return fallback;
  const raw = argv[idx + 1];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readLines(path: string) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
}

function parsePm2Time(line: string) {
  const m = line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/);
  if (!m) return null;
  return new Date(`${m[1]}T${m[2]}+08:00`).getTime();
}

function parseJsonLine(line: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonRecord
      : null;
  } catch {
    return null;
  }
}

function eventName(row: JsonRecord) {
  return typeof row.event === "string" ? row.event : "";
}

function isAfterCutoffJson(row: JsonRecord) {
  if (typeof row.ts !== "string") return false;
  const t = new Date(row.ts).getTime();
  return Number.isFinite(t) && t >= cutoffMs;
}

function isAfterCutoffPm2(line: string) {
  const t = parsePm2Time(line);
  return t != null && t >= cutoffMs;
}

const detailRows = readLines(join(LOG_DIR, "claw-exec-detail.log"))
  .map(parseJsonLine)
  .filter((row): row is JsonRecord => !!row && isAfterCutoffJson(row));

const pm2ErrorLines = readLines(join(LOG_DIR, "pm2-error.log")).filter(isAfterCutoffPm2);
const pm2OutLines = readLines(join(LOG_DIR, "pm2-out.log")).filter(isAfterCutoffPm2);

const counts = {
  wsNatural: detailRows.filter((r) => eventName(r) === "ws_chat_response").length,
  wsAbnormal: detailRows.filter((r) => eventName(r) === "ws_chat_response_abnormal").length,
  wsClientClosed: detailRows.filter((r) => eventName(r) === "ws_chat_client_closed").length,
  httpNatural: detailRows.filter((r) => eventName(r) === "chat_stream_response").length,
  httpAbnormal: detailRows.filter((r) => eventName(r) === "chat_stream_response_abnormal").length,
  recover: detailRows.filter((r) => eventName(r) === "recover_response").length,
  unmatched: pm2ErrorLines.filter((line) => line.includes("[WS] unmatched runtime event after normalizer")).length,
  parseErrors: pm2ErrorLines.filter((line) => line.includes("[WS] parse error")).length,
  runtimeErrors: pm2ErrorLines.filter((line) => /\b(TypeError|ReferenceError|SyntaxError)\b/.test(line)).length,
  restarts: pm2OutLines.filter((line) => line.includes("Backend API server running")).length,
};

const recentProblemLines = pm2ErrorLines
  .filter((line) =>
    line.includes("[WS] unmatched runtime event after normalizer") ||
    line.includes("[WS] parse error") ||
    /\b(TypeError|ReferenceError|SyntaxError)\b/.test(line)
  )
  .slice(-20);

const recentAbnormalRows = detailRows
  .filter((r) => eventName(r).includes("abnormal"))
  .slice(-20);

const failed = counts.unmatched > 0 ||
  counts.wsAbnormal > 0 ||
  counts.httpAbnormal > 0 ||
  counts.parseErrors > 0 ||
  counts.runtimeErrors > 0;

const summary = {
  sinceMinutes: SINCE_MINUTES,
  cutoff: new Date(cutoffMs).toISOString(),
  logDir: LOG_DIR,
  counts,
  recentProblemLines,
  recentAbnormalRows,
  status: failed ? "attention" : "healthy",
};

if (JSON_MODE) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`Workforce Agent Platform chat health since ${summary.cutoff} (${SINCE_MINUTES} min)`);
  console.log("");
  console.log(`  WS natural:        ${counts.wsNatural}`);
  console.log(`  WS abnormal:       ${counts.wsAbnormal}`);
  console.log(`  WS client closed:  ${counts.wsClientClosed}`);
  console.log(`  HTTP natural:      ${counts.httpNatural}`);
  console.log(`  HTTP abnormal:     ${counts.httpAbnormal}`);
  console.log(`  recover responses: ${counts.recover}`);
  console.log(`  unmatched events:  ${counts.unmatched}`);
  console.log(`  WS parse errors:   ${counts.parseErrors}`);
  console.log(`  runtime errors:    ${counts.runtimeErrors}`);
  console.log(`  backend restarts:  ${counts.restarts}`);
  console.log("");
  console.log(`Status: ${summary.status}`);

  if (recentProblemLines.length > 0) {
    console.log("");
    console.log("Recent problem lines:");
    for (const line of recentProblemLines) console.log(`  ${line}`);
  }
}

if (STRICT && failed) process.exit(1);
