import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { ForbiddenError } from "@shared/_core/errors";
import { AXIOS_TIMEOUT_MS, COOKIE_NAME } from "@shared/const";
import axios from "axios";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { ENV } from "./env";
import { touchAuthenticatedUserActivity } from "./session-activity";
import { sessionRevocations } from "./session-revocations";

export type SessionPayload = {
  openId?: string;
  userId?: number;
  appId?: string;
  name: string;
  authVersion?: string;
  mfaVerifiedAt?: number;
};

type VerifiedSession = {
  openId?: string;
  userId?: number;
  appId?: string;
  name: string;
  authVersion: string;
  mfaVerifiedAt?: number;
};

export type AuthenticatedUser = User & { mfaVerifiedAt?: number };

type ExternalAccessToken = {
  accessToken: string;
  tokenType?: string;
  expiresIn?: number;
  refreshToken?: string;
  scope?: string;
  idToken?: string;
};

type ExternalUserIdentity = {
  openId: string;
  projectId?: string;
  name: string;
  email?: string | null;
  platform?: string | null;
  platforms?: unknown;
  loginMethod?: string | null;
};

const MIN_SESSION_AGE_MS = 15 * 60 * 1000;
const DEFAULT_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function configuredSessionAge(): number {
  const requested = Number(
    process.env.SESSION_MAX_AGE_MS ?? DEFAULT_SESSION_AGE_MS
  );
  if (!Number.isFinite(requested)) return DEFAULT_SESSION_AGE_MS;
  return Math.min(
    MAX_SESSION_AGE_MS,
    Math.max(MIN_SESSION_AGE_MS, Math.floor(requested))
  );
}

export const SESSION_MAX_AGE_MS = configuredSessionAge();

export function sessionAuthVersion(user: {
  id: number;
  password?: string | null;
  openId?: string | null;
}): string {
  const identity = user.password
    ? `password:${user.password}`
    : `oauth:${user.openId ?? "local"}`;
  return createHmac("sha256", ENV.cookieSecret)
    .update(`${user.id}:${identity}`)
    .digest("base64url");
}

function secureStringsMatch(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function signingKey(): Uint8Array {
  return new TextEncoder().encode(ENV.cookieSecret);
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function sessionClaims(payload: SessionPayload): Record<string, unknown> {
  const claims: Record<string, unknown> = {
    name: payload.name,
    authVersion: payload.authVersion,
  };
  if (payload.openId) {
    claims.openId = payload.openId;
    claims.appId = payload.appId ?? ENV.appId;
  }
  if (typeof payload.userId === "number") claims.userId = payload.userId;
  if (typeof payload.mfaVerifiedAt === "number") {
    claims.mfaVerifiedAt = payload.mfaVerifiedAt;
  }
  return claims;
}

async function issueJwt(
  claims: Record<string, unknown>,
  expiresAtSeconds: number
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(expiresAtSeconds)
    .sign(signingKey());
}

function sessionFromClaims(payload: JWTPayload): VerifiedSession | null {
  if (!nonEmptyText(payload.jti) || typeof payload.exp !== "number") {
    console.warn("[Auth] Session payload missing jti or expiry");
    return null;
  }
  if (sessionRevocations.isRevoked(payload.jti)) {
    console.warn("[Auth] Session has been explicitly revoked");
    return null;
  }
  if (!nonEmptyText(payload.name)) {
    console.warn("[Auth] Session payload missing name field");
    return null;
  }

  const openId = nonEmptyText(payload.openId) ? payload.openId : undefined;
  const userId =
    typeof payload.userId === "number" ? payload.userId : undefined;
  if (!openId && userId === undefined) {
    console.warn("[Auth] Session payload missing openId or userId");
    return null;
  }
  if (!nonEmptyText(payload.authVersion)) {
    console.warn("[Auth] Session payload missing auth version");
    return null;
  }

  return {
    ...(openId ? { openId } : {}),
    ...(userId !== undefined ? { userId } : {}),
    ...(nonEmptyText(payload.appId) ? { appId: payload.appId } : {}),
    name: payload.name,
    authVersion: payload.authVersion,
    ...(typeof payload.mfaVerifiedAt === "number"
      ? { mfaVerifiedAt: payload.mfaVerifiedAt }
      : {}),
  };
}

async function signSession(
  payload: SessionPayload,
  options: { expiresInMs?: number } = {}
): Promise<string> {
  if (!payload.authVersion) {
    throw new Error("authVersion is required to sign a session");
  }
  const lifetime = Math.min(
    options.expiresInMs ?? SESSION_MAX_AGE_MS,
    MAX_SESSION_AGE_MS
  );
  const expiresAt = Math.floor((Date.now() + lifetime) / 1000);
  return issueJwt(sessionClaims(payload), expiresAt);
}

async function verifySession(
  token: string | null | undefined,
  options: { quiet?: boolean } = {},
): Promise<VerifiedSession | null> {
  if (!token) {
    if (!options.quiet) console.warn("[Auth] Missing session cookie");
    return null;
  }
  try {
    const verified = await jwtVerify(token, signingKey(), {
      algorithms: ["HS256"],
    });
    return sessionFromClaims(verified.payload);
  } catch (error) {
    if (!options.quiet) {
      console.warn("[Auth] Session verification failed", String(error));
    }
    return null;
  }
}

const externalIdentityHttp = axios.create({
  baseURL: ENV.oAuthServerUrl,
  timeout: AXIOS_TIMEOUT_MS,
});

const externalIdentityPaths = {
  exchange: "/webdev.v1.WebDevAuthPublicService/ExchangeToken",
  user: "/webdev.v1.WebDevAuthPublicService/GetUserInfo",
  jwtUser: "/webdev.v1.WebDevAuthPublicService/GetUserInfoWithJwt",
} as const;

function requireExternalIdentityService(): void {
  if (!ENV.oAuthServerUrl) throw new Error("External OAuth is not configured");
}

function normalizedLoginMethod(identity: ExternalUserIdentity): string | null {
  if (identity.platform) return identity.platform;
  if (!Array.isArray(identity.platforms)) return null;

  const platforms = new Set(
    identity.platforms.filter(
      (value): value is string => typeof value === "string"
    )
  );
  const knownMethods = [
    ["REGISTERED_PLATFORM_EMAIL", "email"],
    ["REGISTERED_PLATFORM_GOOGLE", "google"],
    ["REGISTERED_PLATFORM_APPLE", "apple"],
    ["REGISTERED_PLATFORM_MICROSOFT", "microsoft"],
    ["REGISTERED_PLATFORM_AZURE", "microsoft"],
    ["REGISTERED_PLATFORM_GITHUB", "github"],
  ] as const;

  for (const [platform, method] of knownMethods) {
    if (platforms.has(platform)) return method;
  }
  const [first] = platforms;
  return first ? first.toLowerCase() : null;
}

function withLoginMethod(identity: ExternalUserIdentity): ExternalUserIdentity {
  const loginMethod = normalizedLoginMethod(identity);
  return { ...identity, platform: loginMethod, loginMethod };
}

async function exchangeCodeForToken(
  code: string,
  redirectUri: string
): Promise<ExternalAccessToken> {
  requireExternalIdentityService();
  const response = await externalIdentityHttp.post<ExternalAccessToken>(
    externalIdentityPaths.exchange,
    {
      clientId: ENV.appId,
      grantType: "authorization_code",
      code,
      redirectUri,
    }
  );
  return response.data;
}

async function getUserInfo(accessToken: string): Promise<ExternalUserIdentity> {
  requireExternalIdentityService();
  const response = await externalIdentityHttp.post<ExternalUserIdentity>(
    externalIdentityPaths.user,
    { accessToken }
  );
  return withLoginMethod(response.data);
}

async function getUserInfoWithJwt(
  jwtToken: string
): Promise<ExternalUserIdentity> {
  requireExternalIdentityService();
  const response = await externalIdentityHttp.post<ExternalUserIdentity>(
    externalIdentityPaths.jwtUser,
    { jwtToken, projectId: ENV.appId }
  );
  return withLoginMethod(response.data);
}

function cookieValues(
  cookieHeader: string | undefined,
  name: string
): string[] {
  if (!cookieHeader) return [];

  const values: string[] = [];
  for (const segment of cookieHeader.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0 || segment.slice(0, separator).trim() !== name) continue;
    const encoded = segment.slice(separator + 1).trim();
    try {
      values.push(decodeURIComponent(encoded));
    } catch {
      values.push(encoded);
    }
  }

  if (values.length === 0) {
    const fallback = parseCookieHeader(cookieHeader)[name];
    if (fallback) values.push(fallback);
  }
  return [...new Set(values.filter(Boolean))];
}

async function createSessionToken(
  openId: string,
  options: { expiresInMs?: number; name?: string } = {}
): Promise<string> {
  const user = await db.getUserByOpenId(openId);
  if (!user) throw new Error("Cannot create session for unknown OAuth user");
  return signSession(
    {
      openId,
      appId: ENV.appId,
      name: options.name ?? "",
      authVersion: sessionAuthVersion(user),
    },
    options
  );
}

async function signAdminMfaChallenge(payload: {
  userId: number;
  name: string;
  authVersion: string;
}): Promise<string> {
  return issueJwt(
    { ...payload, purpose: "admin-mfa-login" },
    Math.floor((Date.now() + 5 * 60 * 1000) / 1000)
  );
}

async function verifyAdminMfaChallenge(
  token: string
): Promise<{ userId: number; name: string; authVersion: string }> {
  const { payload } = await jwtVerify(token, signingKey(), {
    algorithms: ["HS256"],
  });
  const valid =
    payload.purpose === "admin-mfa-login" &&
    typeof payload.userId === "number" &&
    nonEmptyText(payload.name) &&
    nonEmptyText(payload.authVersion);
  if (!valid) throw new Error("invalid administrator MFA challenge");
  return {
    userId: payload.userId as number,
    name: payload.name as string,
    authVersion: payload.authVersion as string,
  };
}

async function revokeRequestSessions(req: Request): Promise<void> {
  const tokens = cookieValues(req.headers.cookie, COOKIE_NAME);
  await Promise.all(
    tokens.map(async token => {
      try {
        const { payload } = await jwtVerify(token, signingKey(), {
          algorithms: ["HS256"],
        });
        if (nonEmptyText(payload.jti) && typeof payload.exp === "number") {
          sessionRevocations.revoke(payload.jti, payload.exp);
        }
      } catch {
        // Invalid cookies have no active session to revoke.
      }
    })
  );
}

function developmentUser(session: VerifiedSession): User | undefined {
  if (process.env.NODE_ENV !== "development" || session.userId === undefined) {
    return undefined;
  }
  const administrator = session.name === "admin";
  return {
    id: session.userId,
    openId: null,
    name: session.name || (administrator ? "admin" : "test-user"),
    email: administrator
      ? "admin@example.com"
      : `${session.name || "test-user"}@local.dev`,
    password: null,
    loginMethod: "email",
    role: administrator ? "admin" : "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  } as User;
}

function externalIdentityUpdate(
  identity: ExternalUserIdentity,
  signedInAt: Date
) {
  return {
    openId: identity.openId,
    name: identity.name || null,
    email: identity.email ?? null,
    loginMethod: identity.loginMethod ?? identity.platform ?? null,
    lastSignedIn: signedInAt,
  };
}

async function oauthUser(
  session: VerifiedSession,
  token: string,
  signedInAt: Date
): Promise<User> {
  let user = await db.getUserByOpenId(session.openId as string);
  if (!user) {
    try {
      const identity = await getUserInfoWithJwt(token);
      await db.upsertUser(externalIdentityUpdate(identity, signedInAt));
      user = await db.getUserByOpenId(identity.openId);
    } catch (error) {
      console.error("[Auth] Failed to sync user from OAuth:", error);
      throw ForbiddenError("Failed to sync user info");
    }
  }
  if (!user) throw ForbiddenError("User not found");
  touchAuthenticatedUserActivity(user.id, signedInAt);
  return user;
}

async function passwordUser(
  session: VerifiedSession,
  signedInAt: Date
): Promise<User> {
  const userId = session.userId as number;
  let user = await db.getUserById(userId);
  user ??= developmentUser(session);
  if (!user) throw ForbiddenError("User not found");

  if (process.env.NODE_ENV !== "development") {
    touchAuthenticatedUserActivity(userId, signedInAt);
  }
  return user;
}

async function authenticateRequest(req: Request): Promise<AuthenticatedUser> {
  const tokens = cookieValues(req.headers.cookie, COOKIE_NAME);
  let accepted: { session: VerifiedSession; token: string } | undefined;

  for (const token of tokens) {
    const session = await verifySession(token);
    if (session) {
      accepted = { session, token };
      break;
    }
  }
  if (!accepted) throw ForbiddenError("Invalid session cookie");

  const signedInAt = new Date();
  const { session, token } = accepted;
  const user = session.openId
    ? await oauthUser(session, token, signedInAt)
    : session.userId !== undefined
      ? await passwordUser(session, signedInAt)
      : undefined;
  if (!user) throw ForbiddenError("Invalid session: missing openId or userId");

  if (!secureStringsMatch(sessionAuthVersion(user), session.authVersion)) {
    throw ForbiddenError("Session has been revoked");
  }
  return Object.assign(user, { mfaVerifiedAt: session.mfaVerifiedAt });
}

export const sdk = {
  authenticateRequest,
  createSessionToken,
  exchangeCodeForToken,
  getUserInfo,
  getUserInfoWithJwt,
  revokeRequestSessions,
  signAdminMfaChallenge,
  signSession,
  verifyAdminMfaChallenge,
  verifySession,
};
