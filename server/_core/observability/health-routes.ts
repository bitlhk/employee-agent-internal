import { timingSafeEqual } from "node:crypto";
import net from "node:net";
import type { Express, Request, Response } from "express";
import { getDb } from "../../db";
import { getKnowledgeIndexRecoveryStatus, getKnowledgeServiceHealth } from "../knowledge-service";
import { isJiuwenClawRuntimeEnabled } from "../jiuwenclaw-bridge";
import { getUploadAntivirusHealth } from "../upload-security";
import { logError } from "./logger";
import { metricsRegistry, observeReadiness } from "./metrics";
import { getServerLifecycleSnapshot } from "../operational-lifecycle";

export type DependencyCheck = {
  name: "database" | "knowledge" | "jiuwenswarm" | "antivirus";
  required: boolean;
  ok: boolean;
  durationMs: number;
  status: "ok" | "failed" | "disabled";
};

export type ReadinessDependencies = {
  database: () => Promise<boolean>;
  knowledge: () => Promise<boolean>;
  jiuwenswarm: () => Promise<{ required: boolean; ok: boolean }>;
  antivirus: () => Promise<{ required: boolean; ok: boolean }>;
};

function boundedTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("dependency check timed out")), timeoutMs);
    timer.unref();
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function databaseReady(): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  await db.execute("SELECT 1");
  return true;
}

async function knowledgeReady(): Promise<boolean> {
  const service = await getKnowledgeServiceHealth();
  const recovery = getKnowledgeIndexRecoveryStatus();
  return Boolean(service.ok && recovery.evaluated);
}

function tcpReady(target: string): Promise<boolean> {
  const parsed = new URL(target);
  const port = Number(parsed.port || (parsed.protocol === "wss:" ? 443 : 80));
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: parsed.hostname, port });
    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1_500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function jiuwenReady(): Promise<{ required: boolean; ok: boolean }> {
  if (!isJiuwenClawRuntimeEnabled()) return { required: false, ok: true };
  const gateway = String(process.env.JIUWENCLAW_CHAT_TRANSPORT || "").trim().toLowerCase() === "gateway";
  const target = gateway
    ? String(process.env.JIUWENCLAW_GATEWAY_WS_URL || "ws://127.0.0.1:19000/ws")
    : String(process.env.JIUWENCLAW_AGENTSERVER_WS_URL || "ws://127.0.0.1:18092");
  return { required: true, ok: await tcpReady(target) };
}

const defaultDependencies: ReadinessDependencies = {
  database: databaseReady,
  knowledge: knowledgeReady,
  jiuwenswarm: jiuwenReady,
  antivirus: async () => {
    const health = await getUploadAntivirusHealth();
    return { required: health.required, ok: health.ok };
  },
};

async function runCheck(
  name: DependencyCheck["name"],
  action: () => Promise<{ required: boolean; ok: boolean }>,
): Promise<DependencyCheck> {
  const startedAt = process.hrtime.bigint();
  let required = true;
  let ok = false;
  try {
    const result = await boundedTimeout(action(), 3_000);
    required = result.required;
    ok = result.ok;
  } catch (error) {
    logError("health.readiness.failed", error, { dependency: name });
  }
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  observeReadiness(name, ok, durationMs);
  return {
    name,
    required,
    ok,
    durationMs: Math.round(durationMs * 10) / 10,
    status: required ? (ok ? "ok" : "failed") : "disabled",
  };
}

export async function evaluateReadiness(
  dependencies: ReadinessDependencies = defaultDependencies,
): Promise<{ ok: boolean; checks: DependencyCheck[] }> {
  const checks = await Promise.all([
    runCheck("database", async () => ({ required: true, ok: await dependencies.database() })),
    runCheck("knowledge", async () => ({ required: true, ok: await dependencies.knowledge() })),
    runCheck("jiuwenswarm", dependencies.jiuwenswarm),
    runCheck("antivirus", dependencies.antivirus),
  ]);
  return {
    ok: checks.every((check) => !check.required || check.ok),
    checks,
  };
}

function loopbackOnly(req: Request): boolean {
  if (req.headers["x-forwarded-for"] || req.headers["forwarded"]) return false;
  const value = String(req.socket.remoteAddress || "").toLowerCase();
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function equalBearerToken(req: Request, configured: string): boolean {
  const value = String(req.headers.authorization || "");
  const provided = value.startsWith("Bearer ") ? value.slice(7).trim() : "";
  if (!provided || provided.length !== configured.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(configured));
}

export function registerOperationalRoutes(app: Express): void {
  const live = (_req: Request, res: Response) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  };
  app.get("/health", live);
  app.get("/health/live", live);
  app.get("/health/ready", async (_req, res) => {
    const readiness = await evaluateReadiness();
    const lifecycle = getServerLifecycleSnapshot();
    const ready = readiness.ok && lifecycle.state === "ready";
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      timestamp: new Date().toISOString(),
      lifecycle,
      checks: readiness.checks,
    });
  });
  app.get("/internal/metrics", async (req, res) => {
    const token = String(process.env.METRICS_BEARER_TOKEN || "").trim();
    const allowed = token ? equalBearerToken(req, token) : loopbackOnly(req);
    if (!allowed) {
      res.status(404).type("text/plain").send("not found\n");
      return;
    }
    res.setHeader("Content-Type", metricsRegistry.contentType);
    res.send(await metricsRegistry.metrics());
  });
}
