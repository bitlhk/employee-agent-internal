import { COOKIE_NAME } from "@shared/const";
import { parse as parseCookieHeader } from "cookie";
import type { NextFunction, Request, RequestHandler, Response } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function csrfAllowedOrigins(corsOrigins: string[]): Set<string> {
  const configured = [
    ...corsOrigins,
    process.env.FRONTEND_URL,
    process.env.PUBLIC_BASE_URL,
    process.env.WORKFORCE_AGENT_PUBLIC_BASE_URL,
    process.env.LINGXIA_PUBLIC_BASE_URL,
  ];
  return new Set(configured
    .filter((value): value is string => Boolean(value) && value !== "*")
    .map((value) => normalizeOrigin(value.trim()))
    .filter((value): value is string => Boolean(value)));
}

function hasSessionCookie(req: Request): boolean {
  try { return Boolean(parseCookieHeader(req.headers.cookie || "")[COOKIE_NAME]); }
  catch { return false; }
}

function usesHeaderAuthentication(req: Request): boolean {
  return Boolean(
    req.headers.authorization
    || req.headers["x-internal-key"]
    || req.headers["x-linggan-token"]
    || req.headers["x-ea-audit-token"]
  );
}

export function isCookieMutationAllowed(req: Request, allowedOrigins: Set<string>): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
  if (!hasSessionCookie(req) || usesHeaderAuthentication(req)) return true;

  const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  const originHeader = String(req.headers.origin || "").trim();
  if (originHeader) {
    const origin = normalizeOrigin(originHeader);
    return Boolean(origin && allowedOrigins.has(origin));
  }
  if (fetchSite === "cross-site") return false;

  // Preserve CLI and legacy clients that authenticate with an explicitly supplied cookie.
  // Browser form/fetch CSRF requests carry Origin and/or Sec-Fetch-Site.
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "same-site" || fetchSite === "none";
}

export function cookieCsrfProtection(corsOrigins: string[]): RequestHandler {
  const allowedOrigins = csrfAllowedOrigins(corsOrigins);
  return (req: Request, res: Response, next: NextFunction) => {
    if (isCookieMutationAllowed(req, allowedOrigins)) return next();
    return res.status(403).json({ error: "CSRF request rejected" });
  };
}
