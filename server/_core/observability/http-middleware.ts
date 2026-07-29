import type { Request, RequestHandler } from "express";
import { completeHttpRequest, beginHttpRequest } from "./metrics";
import { logInfo, logWarn } from "./logger";
import { normalizeIncomingRequestId, runWithRequestContext, updateRequestContext } from "./request-context";

const UUID_OR_TOKEN_RE = /\b(?:[0-9a-f]{8}-[0-9a-f-]{20,}|(?:lgj|lgc|agt|kb|doc|cs)-?[A-Za-z0-9_-]{8,})\b/gi;

type MetricRequest = Pick<Request, "path" | "baseUrl"> & {
  route?: { path?: unknown };
};

export function normalizeMetricRoute(req: MetricRequest): string {
  const matchedPath = typeof req.route?.path === "string" ? req.route.path : req.path;
  const path = String(matchedPath || "/").split("?")[0] || "/";
  if (path.startsWith("/assets/")) return "/assets/:asset";
  if (path.startsWith("/api/trpc/")) return "/api/trpc";
  return `${String(req.baseUrl || "")}${path}`
    .replace(UUID_OR_TOKEN_RE, ":id")
    .replace(/\/(?:\d{2,})(?=\/|$)/g, "/:number")
    .slice(0, 180);
}

export function resolveMetricRoute(req: MetricRequest, statusCode: number): string {
  if (statusCode === 404 && !req.route) return "/__unmatched__";
  return normalizeMetricRoute(req);
}

function shouldLogRequest(route: string, statusCode: number): boolean {
  if (statusCode >= 400) return true;
  if (route === "/health" || route === "/health/live" || route === "/health/ready") return false;
  if (route === "/internal/metrics" || route.startsWith("/assets/")) return false;
  return route.startsWith("/api/") || route.startsWith("/install.sh");
}

export const requestObservabilityMiddleware: RequestHandler = (req, res, next) => {
  const requestId = normalizeIncomingRequestId(req.headers["x-request-id"] || req.headers["x-correlation-id"]);
  const startedAt = process.hrtime.bigint();
  const initialRoute = normalizeMetricRoute(req);
  let completed = false;
  res.setHeader("x-request-id", requestId);
  beginHttpRequest();

  const complete = (outcome: "finish" | "closed") => {
    if (completed) return;
    completed = true;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const route = resolveMetricRoute(req, res.statusCode) || initialRoute;
    updateRequestContext({ route });
    completeHttpRequest({ method: req.method, route, statusCode: res.statusCode, durationMs });
    if (!shouldLogRequest(route, res.statusCode)) return;
    const fields = {
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      outcome,
    };
    if (res.statusCode >= 400) logWarn("http.request.complete", fields);
    else logInfo("http.request.complete", fields);
  };

  runWithRequestContext({
    requestId,
    method: req.method.slice(0, 16),
    route: initialRoute,
  }, () => {
    res.once("finish", () => complete("finish"));
    res.once("close", () => complete("closed"));
    next();
  });
};
