const AUTH_PATHS = new Set(["/login", "/register", "/reset-password"]);

export type CentralAuthConfig = {
  mode: "local" | "central";
  bridgeUrl?: string;
  publicBaseUrl?: string;
};

function normalizedPath(pathname: string): string {
  const value = String(pathname || "/").replace(/\/+$/, "");
  return value || "/";
}

function safeReturnPath(value: unknown): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) {
    return "/";
  }

  try {
    const parsed = new URL(candidate, "https://ea-return.invalid");
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return AUTH_PATHS.has(normalizedPath(parsed.pathname)) ? "/" : path;
  } catch {
    return "/";
  }
}

function requiredHttpsUrl(value: string | undefined, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS`);
  }
  return parsed;
}

export function centralAuthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CentralAuthConfig {
  const mode = String(env.AUTH_MODE || "local").trim().toLowerCase();
  if (mode !== "central") return { mode: "local" };

  return {
    mode: "central",
    bridgeUrl: requiredHttpsUrl(env.CENTRAL_AUTH_BRIDGE_URL, "CENTRAL_AUTH_BRIDGE_URL").toString(),
    publicBaseUrl: requiredHttpsUrl(
      env.WORKFORCE_AGENT_PUBLIC_BASE_URL || env.PUBLIC_BASE_URL || env.FRONTEND_URL,
      "WORKFORCE_AGENT_PUBLIC_BASE_URL",
    ).toString(),
  };
}

export function centralAuthRedirectUrl(args: {
  config: CentralAuthConfig;
  pathname: string;
  redirect?: unknown;
}): string | null {
  if (args.config.mode !== "central" || !AUTH_PATHS.has(normalizedPath(args.pathname))) return null;

  const bridgeUrl = requiredHttpsUrl(args.config.bridgeUrl, "CENTRAL_AUTH_BRIDGE_URL");
  const publicBaseUrl = requiredHttpsUrl(args.config.publicBaseUrl, "WORKFORCE_AGENT_PUBLIC_BASE_URL");
  const nextUrl = new URL(safeReturnPath(args.redirect), publicBaseUrl.origin);
  bridgeUrl.searchParams.set("next", nextUrl.toString());
  return bridgeUrl.toString();
}
