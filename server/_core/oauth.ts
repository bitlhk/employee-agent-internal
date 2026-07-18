import { COOKIE_NAME } from "@shared/const";
import type { Express, Request, Response } from "express";
import { parse as parseCookieHeader } from "cookie";
import * as db from "../db";
import { clearSessionCookieVariants, getSessionCookieOptions } from "./cookies";
import { consumeOAuthState, createOAuthState } from "./oauth-state";
import { SESSION_MAX_AGE_MS, sdk } from "./sdk";
import { isAdminMfaEnabled } from "./admin-mfa";
import { setAdminMfaChallengeCookie } from "./admin-mfa-cookie";

const OAUTH_STATE_COOKIE = "oauth_state";

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

export function registerOAuthRoutes(app: Express) {
  app.get("/api/oauth/start", (req: Request, res: Response) => {
    const portal = String(process.env.OAUTH_PORTAL_URL || process.env.VITE_OAUTH_PORTAL_URL || "").trim();
    const appId = String(process.env.VITE_APP_ID || "").trim();
    const server = String(process.env.OAUTH_SERVER_URL || "").trim();
    if (!portal || !appId || !server) return res.redirect(302, "/login");

    try {
      const configuredBase = String(
        process.env.OAUTH_CALLBACK_URL
        || process.env.VITE_API_URL
        || process.env.PUBLIC_BASE_URL
        || process.env.FRONTEND_URL
        || ""
      ).trim();
      const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
      const requestBase = `${forwardedProto === "https" ? "https" : req.protocol}://${req.get("host")}`;
      const callbackUrl = process.env.OAUTH_CALLBACK_URL
        ? new URL(process.env.OAUTH_CALLBACK_URL).toString()
        : new URL("/api/oauth/callback", configuredBase || requestBase).toString();
      const { state, maxAgeMs } = createOAuthState(callbackUrl);
      const secure = callbackUrl.startsWith("https://");
      res.cookie(OAUTH_STATE_COOKIE, state, {
        httpOnly: true,
        secure,
        sameSite: "lax",
        path: "/api/oauth/callback",
        maxAge: maxAgeMs,
      });

      const loginUrl = new URL("/app-auth", portal);
      loginUrl.searchParams.set("appId", appId);
      loginUrl.searchParams.set("redirectUri", callbackUrl);
      loginUrl.searchParams.set("state", state);
      loginUrl.searchParams.set("type", "signIn");
      return res.redirect(302, loginUrl.toString());
    } catch (error) {
      console.error("[OAuth] Failed to start authorization", error);
      return res.status(500).json({ error: "OAuth configuration is invalid" });
    }
  });

  app.get("/api/oauth/callback", async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");

    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    const cookieState = parseCookieHeader(req.headers.cookie || "")[OAUTH_STATE_COOKIE];
    const redirectUri = consumeOAuthState(state, cookieState);
    res.clearCookie(OAUTH_STATE_COOKIE, {
      httpOnly: true,
      secure: req.protocol === "https" || String(req.headers["x-forwarded-proto"] || "").includes("https"),
      sameSite: "lax",
      path: "/api/oauth/callback",
    });
    if (!redirectUri) {
      res.status(400).json({ error: "invalid or expired OAuth state" });
      return;
    }

    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, redirectUri);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);

      if (!userInfo.openId) {
        res.status(400).json({ error: "openId missing from user info" });
        return;
      }

      await db.upsertUser({
        openId: userInfo.openId,
        name: userInfo.name || null,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
        lastSignedIn: new Date(),
      });

      const signedInUser = await db.getUserByOpenId(userInfo.openId);
      if (signedInUser?.role === "admin" && await isAdminMfaEnabled(signedInUser.id)) {
        const challenge = await sdk.signAdminMfaChallenge({
          userId: signedInUser.id,
          name: signedInUser.name || signedInUser.email || "admin",
          authVersion: (await import("./sdk")).sessionAuthVersion(signedInUser),
        });
        clearSessionCookieVariants(req, res);
        setAdminMfaChallengeCookie(req, res, challenge);
        const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
        const requestBase = `${forwardedProto === "https" ? "https" : req.protocol}://${req.get("host")}`;
        const frontendBase = new URL(String(process.env.FRONTEND_URL || "/"), requestBase);
        res.redirect(302, new URL("/login?mfa=1", frontendBase).toString());
        return;
      }

      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: userInfo.name || "",
        expiresInMs: SESSION_MAX_AGE_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      clearSessionCookieVariants(req, res);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: SESSION_MAX_AGE_MS });

      // 重定向到前端地址（如果配置了 FRONTEND_URL，否则重定向到根路径）
      const frontendUrl = process.env.FRONTEND_URL || "/";
      res.redirect(302, frontendUrl);
    } catch (error) {
      console.error("[OAuth] Callback failed", error);
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });
}
