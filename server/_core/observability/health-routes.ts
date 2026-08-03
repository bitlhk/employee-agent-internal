import { timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { metricsRegistry } from "./metrics";
import { getServerLifecycleSnapshot } from "../operational-lifecycle";
import { evaluateReadiness } from "./readiness";
import {
  getPublicHealthSnapshot,
  publicHealthEnabled,
} from "./public-health";

export { evaluateReadiness } from "./readiness";

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
  app.get("/.well-known/linggan-health", (_req, res) => {
    if (!publicHealthEnabled()) {
      res.status(404).type("text/plain").send("not found\n");
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=15, stale-if-error=60");
    res.json(getPublicHealthSnapshot());
  });
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
