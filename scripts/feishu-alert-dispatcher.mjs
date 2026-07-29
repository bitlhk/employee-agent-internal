#!/usr/bin/env node

import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const prometheusUrl = String(process.env.PROMETHEUS_URL || "http://127.0.0.1:9090").replace(/\/$/, "");
const webhookUrl = String(process.env.EA_ALERT_FEISHU_WEBHOOK_URL || "").trim();
const intervalMs = Math.max(15_000, Number(process.env.EA_ALERT_POLL_INTERVAL_MS || 60_000));
const statePath = path.resolve(process.env.EA_ALERT_STATE_FILE || "data/ops-alert-state.json");

function validateWebhook(value) {
  if (!value) throw new Error("EA_ALERT_FEISHU_WEBHOOK_URL is not configured");
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.hostname !== "open.feishu.cn") {
    throw new Error("Feishu alert webhook must use https://open.feishu.cn");
  }
  return parsed.toString();
}

function alertKey(alert) {
  const labels = alert?.labels && typeof alert.labels === "object" ? alert.labels : {};
  return createHash("sha256").update(JSON.stringify(Object.entries(labels).sort())).digest("hex").slice(0, 24);
}

function alertLabel(alert) {
  const labels = alert?.labels || {};
  return String(labels.alertname || labels.severity || "EA Alert").slice(0, 120);
}

function alertDescription(alert) {
  const annotations = alert?.annotations || {};
  return String(annotations.description || annotations.summary || "监控规则触发").replace(/\s+/g, " ").slice(0, 600);
}

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    return new Map(Array.isArray(parsed?.active) ? parsed.active.map((item) => [item.key, item]) : []);
  } catch {
    return new Map();
  }
}

async function saveState(active) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ updatedAt: new Date().toISOString(), active: Array.from(active.values()) }, null, 2), { mode: 0o600 });
  await rename(temporary, statePath);
}

async function sendFeishu(text) {
  const response = await fetch(validateWebhook(webhookUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msg_type: "text", content: { text } }),
    signal: AbortSignal.timeout(8_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Feishu webhook returned HTTP ${response.status}`);
}

async function fetchFiringAlerts() {
  const response = await fetch(`${prometheusUrl}/api/v1/alerts`, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Prometheus returned HTTP ${response.status}`);
  const payload = await response.json();
  const alerts = Array.isArray(payload?.data?.alerts) ? payload.data.alerts : [];
  return alerts.filter((alert) => String(alert?.state || "").toLowerCase() === "firing");
}

let stopped = false;
let running = false;
let previous = await loadState();

async function poll() {
  if (stopped || running) return;
  running = true;
  try {
    const alerts = await fetchFiringAlerts();
    const current = new Map(alerts.map((alert) => {
      const key = alertKey(alert);
      return [key, { key, name: alertLabel(alert), description: alertDescription(alert), since: String(alert.activeAt || "") }];
    }));
    const opened = Array.from(current.values()).filter((item) => !previous.has(item.key));
    const recovered = Array.from(previous.values()).filter((item) => !current.has(item.key));
    for (const alert of opened) {
      await sendFeishu(`[EA 告警] ${alert.name}\n${alert.description}\n状态：触发`);
    }
    for (const alert of recovered) {
      await sendFeishu(`[EA 恢复] ${alert.name}\n状态：已恢复`);
    }
    previous = current;
    await saveState(current);
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: "alert_poll", firing: current.size, opened: opened.length, recovered: recovered.length }));
  } catch (error) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), event: "alert_poll_failed", error: String(error?.message || error).slice(0, 240) }));
  } finally {
    running = false;
  }
}

const timer = setInterval(() => void poll(), intervalMs);
timer.unref?.();
process.on("SIGTERM", () => { stopped = true; clearInterval(timer); });
process.on("SIGINT", () => { stopped = true; clearInterval(timer); });

if (!webhookUrl) {
  console.error("EA alert dispatcher disabled: EA_ALERT_FEISHU_WEBHOOK_URL is not configured");
  process.exitCode = 2;
} else {
  await poll();
  // Keep the process referenced; the polling timer itself is intentionally unref'd
  // so tests and one-shot validation can terminate cleanly.
  process.stdin.resume();
}
