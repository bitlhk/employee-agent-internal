import type { IncomingMessage } from "http";

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function configuredWebSocketOrigins(): Set<string> {
  const values = [
    process.env.WS_ALLOWED_ORIGINS,
    process.env.CORS_ORIGIN,
    process.env.FRONTEND_URL,
  ].filter(Boolean).join(",").split(",");

  return new Set(values
    .map((value) => normalizeOrigin(value.trim()))
    .filter((value): value is string => Boolean(value)));
}

export function isAllowedWebSocketOrigin(req: IncomingMessage): boolean {
  const origin = normalizeOrigin(String(req.headers.origin || ""));
  if (!origin) return false;
  if (configuredWebSocketOrigins().has(origin)) return true;

  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if (!host) return false;
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const protocol = forwardedProto === "https" ? "https" : "http";
  return origin === `${protocol}://${host}`;
}
