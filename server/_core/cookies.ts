import { COOKIE_NAME } from "@shared/const";
import type { CookieOptions, Request, Response } from "express";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function isIpAddress(host: string) {
  // Basic IPv4 check and IPv6 presence detection.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(":");
}

function isSecureRequest(req: Request) {
  if (req.protocol === "https") return true;

  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!forwardedProto) return false;

  const protoList = Array.isArray(forwardedProto)
    ? forwardedProto
    : forwardedProto.split(",");

  return protoList.some(proto => proto.trim().toLowerCase() === "https");
}

export function getSessionCookieOptions(
  req: Request
): Pick<CookieOptions, "domain" | "httpOnly" | "path" | "sameSite" | "secure"> {
  // const hostname = req.hostname;
  // const shouldSetDomain =
  //   hostname &&
  //   !LOCAL_HOSTS.has(hostname) &&
  //   !isIpAddress(hostname) &&
  //   hostname !== "127.0.0.1" &&
  //   hostname !== "::1";

  // const domain =
  //   shouldSetDomain && !hostname.startsWith(".")
  //     ? `.${hostname}`
  //     : shouldSetDomain
  //       ? hostname
  //       : undefined;

  const isSecure = isSecureRequest(req);
  const isLocalhost = req.hostname === "localhost" || 
                      req.hostname === "127.0.0.1" || 
                      LOCAL_HOSTS.has(req.hostname);

  // 在本地开发环境中，使用 "lax" 而不是 "none"
  // 因为 "none" 需要 secure: true，但本地开发通常是 HTTP
  // 在生产环境（HTTPS）中，使用 "none" 以支持跨域
  const sameSite: "strict" | "lax" | "none" = 
    isSecure && !isLocalhost ? "none" : "lax";

  // 跨子域共享登录态（通过 COOKIE_DOMAIN 环境变量配置）
  const host = req.hostname || "";
  const cookieDomain = process.env.COOKIE_DOMAIN; // e.g. ".example.com"
  const domain = cookieDomain && host.endsWith(cookieDomain.replace(/^\./, "")) ? cookieDomain : undefined;

  return {
    domain,
    httpOnly: true,
    path: "/",
    sameSite,
    secure: isSecure,
  };
}

export function clearSessionCookieVariants(req: Request, res: Response) {
  const hostname = req.hostname || "";
  const configuredDomain = process.env.COOKIE_DOMAIN || "";
  const normalizedDomain = configuredDomain.replace(/^\./, "");
  const domains = new Set<string | undefined>([undefined]);

  if (configuredDomain) domains.add(configuredDomain);
  if (normalizedDomain) {
    domains.add(normalizedDomain);
    domains.add(`.${normalizedDomain}`);
  }
  if (hostname && hostname !== normalizedDomain) domains.add(hostname);

  for (const domain of domains) {
    const base = { ...(domain ? { domain } : {}), path: "/" };
    try {
      res.clearCookie(COOKIE_NAME, {
        ...base,
        httpOnly: true,
        secure: true,
        sameSite: "none",
      });
    } catch {}
    try {
      res.clearCookie(COOKIE_NAME, {
        ...base,
        httpOnly: true,
        secure: false,
        sameSite: "lax",
      });
    } catch {}
  }
}

export function setLogoutLockCookieVariants(req: Request, res: Response, maxAgeMs = 3 * 60 * 1000) {
  const hostname = req.hostname || "";
  const configuredDomain = process.env.COOKIE_DOMAIN || "";
  const normalizedDomain = configuredDomain.replace(/^\./, "");
  const domains = new Set<string | undefined>([undefined]);

  if (configuredDomain) domains.add(configuredDomain);
  if (normalizedDomain) {
    domains.add(normalizedDomain);
    domains.add(`.${normalizedDomain}`);
  }
  if (hostname && hostname !== normalizedDomain) domains.add(hostname);

  for (const domain of domains) {
    const base = {
      ...(domain ? { domain } : {}),
      httpOnly: true,
      path: "/",
      maxAge: maxAgeMs,
    };
    try {
      res.cookie("logout_lock", "1", {
        ...base,
        secure: true,
        sameSite: "none",
      });
    } catch {}
    try {
      res.cookie("logout_lock", "1", {
        ...base,
        secure: false,
        sameSite: "lax",
      });
    } catch {}
  }
}
