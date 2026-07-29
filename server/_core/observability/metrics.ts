import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const metricsRegistry = new Registry();

collectDefaultMetrics({
  prefix: "ea_",
  register: metricsRegistry,
});

const httpRequests = new Counter({
  name: "ea_http_requests_total",
  help: "HTTP requests completed by the Employee Agent server.",
  labelNames: ["method", "route", "status_class"] as const,
  registers: [metricsRegistry],
});

const httpDuration = new Histogram({
  name: "ea_http_request_duration_seconds",
  help: "HTTP request duration in seconds.",
  labelNames: ["method", "route", "status_class"] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 30, 60, 180, 300],
  registers: [metricsRegistry],
});

const httpInflight = new Gauge({
  name: "ea_http_inflight_requests",
  help: "HTTP requests currently being processed.",
  registers: [metricsRegistry],
});

const readinessChecks = new Counter({
  name: "ea_readiness_checks_total",
  help: "Readiness dependency check outcomes.",
  labelNames: ["dependency", "outcome"] as const,
  registers: [metricsRegistry],
});

const readinessDuration = new Histogram({
  name: "ea_readiness_check_duration_seconds",
  help: "Readiness dependency check duration in seconds.",
  labelNames: ["dependency"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3],
  registers: [metricsRegistry],
});

export function beginHttpRequest(): void {
  httpInflight.inc();
}
export function completeHttpRequest(input: {
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
}): void {
  httpInflight.dec();
  const statusClass = `${Math.max(0, Math.floor(input.statusCode / 100))}xx`;
  const labels = {
    method: input.method.slice(0, 16),
    route: input.route.slice(0, 180),
    status_class: statusClass,
  };
  httpRequests.inc(labels);
  httpDuration.observe(labels, Math.max(0, input.durationMs) / 1000);
}

export function observeReadiness(dependency: string, ok: boolean, durationMs: number): void {
  const boundedDependency = dependency.slice(0, 32);
  readinessChecks.inc({ dependency: boundedDependency, outcome: ok ? "ok" : "failed" });
  readinessDuration.observe({ dependency: boundedDependency }, Math.max(0, durationMs) / 1000);
}
