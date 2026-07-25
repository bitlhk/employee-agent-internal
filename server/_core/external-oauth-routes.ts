import { COOKIE_NAME } from "@shared/const";
import { parse as parseCookieHeader } from "cookie";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { setAdminMfaChallengeCookie } from "./admin-mfa-cookie";
import { isAdminMfaEnabled } from "./admin-mfa";
import { clearSessionCookieVariants, getSessionCookieOptions } from "./cookies";
import { consumeOAuthState, createOAuthState } from "./oauth-state";
import { SESSION_MAX_AGE_MS, sdk, sessionAuthVersion } from "./sdk";

const STATE_COOKIE_NAME = "oauth_state";
const CALLBACK_PATH = "/api/oauth/callback";

type OAuthEnvironment = Record<string, string | undefined>;

type ExternalOAuthConfiguration = {
  applicationId: string;
  portalUrl: string;
};

export function readExternalOAuthConfiguration(
  environment: OAuthEnvironment = process.env
): ExternalOAuthConfiguration | null {
  const applicationId = String(environment.VITE_APP_ID || "").trim();
  const portalUrl = String(environment.OAUTH_PORTAL_URL || environment.VITE_OAUTH_PORTAL_URL || "").trim();
  const identityServer = String(environment.OAUTH_SERVER_URL || "").trim();
  return applicationId && portalUrl && identityServer
    ? { applicationId, portalUrl }
    : null;
}

export function buildExternalOAuthCallbackUrl(input: {
  explicitCallback?: string;
  configuredBase?: string;
  requestOrigin: string;
}): string {
  if (input.explicitCallback) return new URL(input.explicitCallback).toString();
  return new URL(CALLBACK_PATH, input.configuredBase || input.requestOrigin).toString();
}

export function buildExternalAuthorizationUrl(input: {
  portalUrl: string;
  applicationId: string;
  callbackUrl: string;
  state: string;
}): string {
  const authorizationUrl = new URL("/app-auth", input.portalUrl);
  authorizationUrl.search = new URLSearchParams({
    appId: input.applicationId,
    redirectUri: input.callbackUrl,
    state: input.state,
    type: "signIn",
  }).toString();
  return authorizationUrl.toString();
}

function queryString(req: Request, name: string): string | null {
  const value = req.query[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requestOrigin(req: Request): string {
  const host = req.get("host");
  if (!host) throw new Error("request host is missing");
  const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",", 1)[0].trim();
  const protocol = forwarded === "https" ? "https" : req.protocol;
  return `${protocol}://${host}`;
}

function callbackUrlFor(req: Request): string {
  const environment = process.env;
  return buildExternalOAuthCallbackUrl({
    explicitCallback: environment.OAUTH_CALLBACK_URL,
    configuredBase: environment.VITE_API_URL || environment.PUBLIC_BASE_URL || environment.FRONTEND_URL,
    requestOrigin: requestOrigin(req),
  });
}

function expireStateCookie(req: Request, res: Response) {
  res.clearCookie(STATE_COOKIE_NAME, {
    httpOnly: true,
    secure: req.protocol === "https" || String(req.headers["x-forwarded-proto"] || "").includes("https"),
    sameSite: "lax",
    path: CALLBACK_PATH,
  });
}

function redirectToMfa(req: Request, res: Response) {
  const base = new URL(String(process.env.FRONTEND_URL || "/"), requestOrigin(req));
  res.redirect(302, new URL("/login?mfa=1", base).toString());
}

function beginExternalSignIn(req: Request, res: Response) {
  const configuration = readExternalOAuthConfiguration();
  if (!configuration) {
    res.redirect(302, "/login");
    return;
  }

  try {
    const callbackUrl = callbackUrlFor(req);
    const grant = createOAuthState(callbackUrl);
    res.cookie(STATE_COOKIE_NAME, grant.state, {
      httpOnly: true,
      secure: callbackUrl.startsWith("https://"),
      sameSite: "lax",
      path: CALLBACK_PATH,
      maxAge: grant.maxAgeMs,
    });
    res.redirect(302, buildExternalAuthorizationUrl({
      portalUrl: configuration.portalUrl,
      applicationId: configuration.applicationId,
      callbackUrl,
      state: grant.state,
    }));
  } catch (error) {
    console.error("[OAuth] Unable to prepare authorization", error);
    res.status(500).json({ error: "OAuth configuration is invalid" });
  }
}

async function finishExternalSignIn(req: Request, res: Response) {
  const authorizationCode = queryString(req, "code");
  const returnedState = queryString(req, "state");
  if (!authorizationCode || !returnedState) {
    res.status(400).json({ error: "code and state are required" });
    return;
  }

  const stateCookie = parseCookieHeader(req.headers.cookie || "")[STATE_COOKIE_NAME];
  const callbackUrl = consumeOAuthState(returnedState, stateCookie);
  expireStateCookie(req, res);
  if (!callbackUrl) {
    res.status(400).json({ error: "invalid or expired OAuth state" });
    return;
  }

  try {
    const access = await sdk.exchangeCodeForToken(authorizationCode, callbackUrl);
    const identity = await sdk.getUserInfo(access.accessToken);
    if (!identity.openId) {
      res.status(400).json({ error: "openId missing from user info" });
      return;
    }

    await db.upsertUser({
      openId: identity.openId,
      name: identity.name || null,
      email: identity.email ?? null,
      loginMethod: identity.loginMethod ?? identity.platform ?? null,
      lastSignedIn: new Date(),
    });

    const user = await db.getUserByOpenId(identity.openId);
    if (user?.role === "admin" && await isAdminMfaEnabled(user.id)) {
      const challenge = await sdk.signAdminMfaChallenge({
        userId: user.id,
        name: user.name || user.email || "admin",
        authVersion: sessionAuthVersion(user),
      });
      clearSessionCookieVariants(req, res);
      setAdminMfaChallengeCookie(req, res, challenge);
      redirectToMfa(req, res);
      return;
    }

    const session = await sdk.createSessionToken(identity.openId, {
      name: identity.name || "",
      expiresInMs: SESSION_MAX_AGE_MS,
    });
    clearSessionCookieVariants(req, res);
    res.cookie(COOKIE_NAME, session, {
      ...getSessionCookieOptions(req),
      maxAge: SESSION_MAX_AGE_MS,
    });
    res.redirect(302, process.env.FRONTEND_URL || "/");
  } catch (error) {
    console.error("[OAuth] Sign-in callback failed", error);
    res.status(500).json({ error: "OAuth callback failed" });
  }
}

export function registerExternalOAuthRoutes(app: Express) {
  app.get("/api/oauth/start", beginExternalSignIn);
  app.get("/api/oauth/callback", finishExternalSignIn);
}
