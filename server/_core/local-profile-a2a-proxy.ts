import type { Express, Request, Response, NextFunction } from "express";
import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";

export function resolveLocalProfileA2AProxyPort(raw: unknown, fallback = 8898): number {
  const parsed = Number(raw || fallback);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) return fallback;
  return parsed;
}

export function localProfileA2AProxyEnabled(raw: unknown): boolean {
  return String(raw || "").trim().toLowerCase() === "true";
}

export function resolveLocalProfileA2AProxyTimeout(raw: unknown): number {
  const parsed = Number(raw || 1_400_000);
  if (!Number.isInteger(parsed) || parsed < 30_000 || parsed > 1_800_000) {
    return 1_400_000;
  }
  return parsed;
}

export type TrustedLocalProfileA2ATarget = {
  url: string;
  allowPrivate: boolean;
};

type LocalProfileA2AEnvironment = Record<string, string | undefined>;

function profileRouteSpecs(env: LocalProfileA2AEnvironment) {
  return [
    {
      enabled: localProfileA2AProxyEnabled(env.HERMES_PPT_A2A_PROXY_ENABLED),
      publicPath: "/a2a/ppt-expert",
      port: resolveLocalProfileA2AProxyPort(env.HERMES_PPT_A2A_PORT, 8898),
    },
    {
      enabled: localProfileA2AProxyEnabled(env.HERMES_DIAGRAM_A2A_PROXY_ENABLED),
      publicPath: "/a2a/diagram-expert",
      port: resolveLocalProfileA2AProxyPort(env.HERMES_DIAGRAM_A2A_PORT, 8899),
    },
  ];
}

/** Keep same-host profile traffic off the public reverse-proxy round trip. */
export function resolveTrustedLocalProfileA2ATarget(
  rawUrl: string,
  env: LocalProfileA2AEnvironment = process.env,
): TrustedLocalProfileA2ATarget {
  let target: URL;
  let publicBase: URL;
  try {
    target = new URL(rawUrl);
    publicBase = new URL(String(env.PUBLIC_BASE_URL || ""));
  } catch {
    return { url: rawUrl, allowPrivate: false };
  }

  if (target.origin !== publicBase.origin) {
    return { url: rawUrl, allowPrivate: false };
  }

  for (const spec of profileRouteSpecs(env)) {
    if (!spec.enabled) continue;
    if (target.pathname !== spec.publicPath && !target.pathname.startsWith(`${spec.publicPath}/`)) {
      continue;
    }
    const suffix = target.pathname.slice(spec.publicPath.length) || "/";
    const local = new URL(`http://127.0.0.1:${spec.port}`);
    local.pathname = suffix;
    local.search = target.search;
    return { url: local.toString(), allowPrivate: true };
  }

  return { url: rawUrl, allowPrivate: false };
}

interface ProfileProxySpec {
  publicPath: string;
  port: number;
  timeoutMs: number;
  label: string;
  unavailableMessage: string;
}

function registerOneProfileProxy(app: Express, spec: ProfileProxySpec): void {
  const target = `http://127.0.0.1:${spec.port}`;

  app.use(spec.publicPath, (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      res.status(405).json({ error: "method not allowed" });
      return;
    }
    next();
  });

  app.use(spec.publicPath, createProxyMiddleware({
    target,
    changeOrigin: false,
    xfwd: false,
    timeout: spec.timeoutMs,
    proxyTimeout: spec.timeoutMs,
    on: {
      proxyReq: fixRequestBody,
      error(error, _req, res) {
        console.error(`[${spec.label}] local sidecar unavailable`, error.message);
        if ("writeHead" in res && !res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: spec.unavailableMessage }));
        }
      },
    },
  }));

  console.log(`[${spec.label}] proxy enabled: ${spec.publicPath} -> ${target}; timeout=${spec.timeoutMs}ms`);
}

export function registerLocalProfileA2AProxy(app: Express): void {
  // PPT expert (ppt-expert profile) — long-running deck builds.
  if (localProfileA2AProxyEnabled(process.env.HERMES_PPT_A2A_PROXY_ENABLED)) {
    registerOneProfileProxy(app, {
      publicPath: "/a2a/ppt-expert",
      port: resolveLocalProfileA2AProxyPort(process.env.HERMES_PPT_A2A_PORT, 8898),
      timeoutMs: resolveLocalProfileA2AProxyTimeout(process.env.HERMES_PPT_A2A_PROXY_TIMEOUT_MS),
      label: "HERMES-PPT-A2A",
      unavailableMessage: "PPT expert is unavailable",
    });
  }

  // Diagram expert (diagram-expert profile) — archify text-to-diagram.
  if (localProfileA2AProxyEnabled(process.env.HERMES_DIAGRAM_A2A_PROXY_ENABLED)) {
    registerOneProfileProxy(app, {
      publicPath: "/a2a/diagram-expert",
      port: resolveLocalProfileA2AProxyPort(process.env.HERMES_DIAGRAM_A2A_PORT, 8899),
      timeoutMs: resolveLocalProfileA2AProxyTimeout(process.env.HERMES_DIAGRAM_A2A_PROXY_TIMEOUT_MS),
      label: "HERMES-DIAGRAM-A2A",
      unavailableMessage: "Diagram expert is unavailable",
    });
  }
}
