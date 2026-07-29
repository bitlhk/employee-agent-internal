import type { Express, NextFunction, Request, Response } from "express";
import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { createContext } from "./context";
import { logError, logInfo, logWarn } from "./observability/logger";

const MONITORING_PUBLIC_PATH = "/ops/grafana";
const MONITORING_DASHBOARD_PATH =
  "/d/employee-agent-overview/employee-agent-overview";
const DEFAULT_GRAFANA_URL = "http://127.0.0.1:3000";
const DEFAULT_PROMETHEUS_URL = "http://127.0.0.1:9090";

type MonitoringEnvironment = Record<string, string | undefined>;

export type MonitoringServiceStatus = {
  available: boolean;
  detail: string;
};

export type MonitoringStatus = {
  configured: boolean;
  available: boolean;
  checkedAt: string;
  dashboardUrl: string | null;
  services: {
    prometheus: MonitoringServiceStatus;
    grafana: MonitoringServiceStatus;
  };
};

function enabledValue(raw: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(raw || "")
      .trim()
      .toLowerCase()
  );
}

export function resolveLoopbackMonitoringUrl(
  raw: unknown,
  fallback: string
): URL | null {
  try {
    const url = new URL(String(raw || fallback));
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "http:") return null;
    if (!["127.0.0.1", "[::1]"].includes(hostname)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    return url;
  } catch {
    return null;
  }
}

export function monitoringConfig(env: MonitoringEnvironment = process.env) {
  const configured = enabledValue(env.EA_MONITORING_ENABLED);
  const grafana = resolveLoopbackMonitoringUrl(
    env.GRAFANA_INTERNAL_URL,
    DEFAULT_GRAFANA_URL
  );
  const prometheus = resolveLoopbackMonitoringUrl(
    env.PROMETHEUS_URL,
    DEFAULT_PROMETHEUS_URL
  );
  return {
    configured,
    valid: Boolean(grafana && prometheus),
    grafana,
    prometheus,
    dashboardUrl:
      configured && grafana
        ? `${MONITORING_PUBLIC_PATH}${MONITORING_DASHBOARD_PATH}?orgId=1&kiosk`
        : null,
  };
}

async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const ctx = await createContext({
      req,
      res,
    } as unknown as CreateExpressContextOptions);
    if (!ctx.user) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }
    if (ctx.user.role !== "admin") {
      res.status(403).json({ error: "FORBIDDEN" });
      return;
    }
    next();
  } catch (error) {
    logError("monitoring.auth.failed", error);
    res.status(500).json({ error: "monitoring authentication failed" });
  }
}

async function checkService(
  url: URL | null,
  path: string
): Promise<MonitoringServiceStatus> {
  if (!url) return { available: false, detail: "配置无效" };
  try {
    const endpoint = new URL(path, url);
    const response = await fetch(endpoint, {
      method: "GET",
      signal: AbortSignal.timeout(2_000),
      redirect: "error",
    });
    if (!response.ok) {
      return { available: false, detail: `HTTP ${response.status}` };
    }
    return { available: true, detail: "运行中" };
  } catch {
    return { available: false, detail: "无法连接" };
  }
}

export async function readMonitoringStatus(
  env: MonitoringEnvironment = process.env
): Promise<MonitoringStatus> {
  const config = monitoringConfig(env);
  if (!config.configured) {
    const disabled = { available: false, detail: "未启用" };
    return {
      configured: false,
      available: false,
      checkedAt: new Date().toISOString(),
      dashboardUrl: null,
      services: { prometheus: disabled, grafana: disabled },
    };
  }
  if (!config.valid) {
    const invalid = { available: false, detail: "配置无效" };
    return {
      configured: true,
      available: false,
      checkedAt: new Date().toISOString(),
      dashboardUrl: null,
      services: { prometheus: invalid, grafana: invalid },
    };
  }

  const [prometheus, grafana] = await Promise.all([
    checkService(config.prometheus, "/-/ready"),
    checkService(config.grafana, "/api/health"),
  ]);
  return {
    configured: true,
    available: prometheus.available && grafana.available,
    checkedAt: new Date().toISOString(),
    dashboardUrl: config.dashboardUrl,
    services: { prometheus, grafana },
  };
}

function proxyPath(pathname: string): string {
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return normalized.startsWith(MONITORING_PUBLIC_PATH)
    ? normalized
    : `${MONITORING_PUBLIC_PATH}${normalized}`;
}

function isAllowedGrafanaRequest(req: Request): boolean {
  if (req.method === "GET" || req.method === "HEAD") return true;
  if (req.method !== "POST") return false;
  return req.path === "/api/ds/query";
}

export function registerMonitoringRoutes(app: Express): void {
  app.get("/api/admin/monitoring/status", requireAdmin, async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await readMonitoringStatus());
  });

  const config = monitoringConfig();
  if (!config.configured) {
    logInfo("monitoring.dashboard.disabled");
    return;
  }
  if (!config.valid || !config.grafana) {
    logWarn("monitoring.dashboard.invalid_config");
    return;
  }

  app.use(MONITORING_PUBLIC_PATH, requireAdmin);
  app.use(MONITORING_PUBLIC_PATH, (req, res, next) => {
    if (!isAllowedGrafanaRequest(req)) {
      res.setHeader("Allow", "GET, HEAD, POST /api/ds/query");
      res.status(405).json({ error: "monitoring dashboard is read-only" });
      return;
    }
    next();
  });
  app.use(
    MONITORING_PUBLIC_PATH,
    createProxyMiddleware({
      target: config.grafana.origin,
      changeOrigin: false,
      xfwd: true,
      proxyTimeout: 10_000,
      timeout: 10_000,
      pathRewrite: proxyPath,
      on: {
        proxyReq(proxyReq, req) {
          proxyReq.removeHeader("authorization");
          proxyReq.removeHeader("cookie");
          fixRequestBody(proxyReq, req);
        },
        proxyRes(proxyRes) {
          delete proxyRes.headers["set-cookie"];
        },
        error(error, _req, res) {
          logWarn("monitoring.dashboard.proxy_unavailable", {
            error: error.message,
          });
          if ("writeHead" in res && !res.headersSent) {
            res.writeHead(502, {
              "Content-Type": "application/json; charset=utf-8",
            });
            res.end(
              JSON.stringify({ error: "monitoring dashboard unavailable" })
            );
          }
        },
      },
    })
  );

  logInfo("monitoring.dashboard.proxy_enabled", {
    publicPath: MONITORING_PUBLIC_PATH,
    target: config.grafana.origin,
  });
}
