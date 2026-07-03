import { AXIOS_TIMEOUT_MS, COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { ForbiddenError } from "@shared/_core/errors";
import axios, { type AxiosInstance } from "axios";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { ENV } from "./env";
import type {
  ExchangeTokenRequest,
  ExchangeTokenResponse,
  GetUserInfoResponse,
  GetUserInfoWithJwtRequest,
  GetUserInfoWithJwtResponse,
} from "./types/manusTypes";
// Utility function
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export type SessionPayload = {
  openId?: string;
  userId?: number;
  appId?: string;
  name: string;
};

const EXCHANGE_TOKEN_PATH = `/webdev.v1.WebDevAuthPublicService/ExchangeToken`;
const GET_USER_INFO_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfo`;
const GET_USER_INFO_WITH_JWT_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfoWithJwt`;

class OAuthService {
  constructor(private client: ReturnType<typeof axios.create>) {
    console.log("[OAuth] Initialized with baseURL:", ENV.oAuthServerUrl);
    if (!ENV.oAuthServerUrl) {
      console.error(
        "[OAuth] ERROR: OAUTH_SERVER_URL is not configured! Set OAUTH_SERVER_URL environment variable."
      );
    }
  }

  private decodeState(state: string): string {
    const redirectUri = atob(state);
    return redirectUri;
  }

  async getTokenByCode(
    code: string,
    state: string
  ): Promise<ExchangeTokenResponse> {
    const payload: ExchangeTokenRequest = {
      clientId: ENV.appId,
      grantType: "authorization_code",
      code,
      redirectUri: this.decodeState(state),
    };

    const { data } = await this.client.post<ExchangeTokenResponse>(
      EXCHANGE_TOKEN_PATH,
      payload
    );

    return data;
  }

  async getUserInfoByToken(
    token: ExchangeTokenResponse
  ): Promise<GetUserInfoResponse> {
    const { data } = await this.client.post<GetUserInfoResponse>(
      GET_USER_INFO_PATH,
      {
        accessToken: token.accessToken,
      }
    );

    return data;
  }
}

const createOAuthHttpClient = (): AxiosInstance =>
  axios.create({
    baseURL: ENV.oAuthServerUrl,
    timeout: AXIOS_TIMEOUT_MS,
  });

class SDKServer {
  private readonly client: AxiosInstance;
  private readonly oauthService: OAuthService;

  constructor(client: AxiosInstance = createOAuthHttpClient()) {
    this.client = client;
    this.oauthService = new OAuthService(this.client);
  }

  private deriveLoginMethod(
    platforms: unknown,
    fallback: string | null | undefined
  ): string | null {
    if (fallback && fallback.length > 0) return fallback;
    if (!Array.isArray(platforms) || platforms.length === 0) return null;
    const set = new Set<string>(
      platforms.filter((p): p is string => typeof p === "string")
    );
    if (set.has("REGISTERED_PLATFORM_EMAIL")) return "email";
    if (set.has("REGISTERED_PLATFORM_GOOGLE")) return "google";
    if (set.has("REGISTERED_PLATFORM_APPLE")) return "apple";
    if (
      set.has("REGISTERED_PLATFORM_MICROSOFT") ||
      set.has("REGISTERED_PLATFORM_AZURE")
    )
      return "microsoft";
    if (set.has("REGISTERED_PLATFORM_GITHUB")) return "github";
    const first = Array.from(set)[0];
    return first ? first.toLowerCase() : null;
  }

  /**
   * Exchange OAuth authorization code for access token
   * @example
   * const tokenResponse = await sdk.exchangeCodeForToken(code, state);
   */
  async exchangeCodeForToken(
    code: string,
    state: string
  ): Promise<ExchangeTokenResponse> {
    return this.oauthService.getTokenByCode(code, state);
  }

  /**
   * Get user information using access token
   * @example
   * const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
   */
  async getUserInfo(accessToken: string): Promise<GetUserInfoResponse> {
    const data = await this.oauthService.getUserInfoByToken({
      accessToken,
    } as ExchangeTokenResponse);
    const loginMethod = this.deriveLoginMethod(
      (data as any)?.platforms,
      (data as any)?.platform ?? data.platform ?? null
    );
    return {
      ...(data as any),
      platform: loginMethod,
      loginMethod,
    } as GetUserInfoResponse;
  }

  private parseCookies(cookieHeader: string | undefined) {
    if (!cookieHeader) {
      return new Map<string, string>();
    }

    const parsed = parseCookieHeader(cookieHeader);
    return new Map(Object.entries(parsed));
  }

  private getCookieValues(cookieHeader: string | undefined, name: string) {
    if (!cookieHeader) return [];

    const values: string[] = [];
    for (const part of cookieHeader.split(";")) {
      const index = part.indexOf("=");
      if (index < 0) continue;

      const key = part.slice(0, index).trim();
      if (key !== name) continue;

      const rawValue = part.slice(index + 1).trim();
      try {
        values.push(decodeURIComponent(rawValue));
      } catch {
        values.push(rawValue);
      }
    }

    return Array.from(new Set(values.filter(Boolean)));
  }

  private getSessionSecret() {
    const secret = ENV.cookieSecret;
    return new TextEncoder().encode(secret);
  }

  /**
   * Create a session token for a Manus user openId
   * @example
   * const sessionToken = await sdk.createSessionToken(userInfo.openId);
   */
  async createSessionToken(
    openId: string,
    options: { expiresInMs?: number; name?: string } = {}
  ): Promise<string> {
    return this.signSession(
      {
        openId,
        appId: ENV.appId,
        name: options.name || "",
      },
      options
    );
  }

  async signSession(
    payload: SessionPayload,
    options: { expiresInMs?: number } = {}
  ): Promise<string> {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1000);
    const secretKey = this.getSessionSecret();

    const jwtPayload: Record<string, unknown> = {
      name: payload.name,
    };
    
    if (payload.openId) {
      jwtPayload.openId = payload.openId;
      jwtPayload.appId = payload.appId || ENV.appId;
    }
    
    if (payload.userId) {
      jwtPayload.userId = payload.userId;
    }

    return new SignJWT(jwtPayload)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setExpirationTime(expirationSeconds)
      .sign(secretKey);
  }

  async verifySession(
    cookieValue: string | undefined | null
  ): Promise<{ openId?: string; userId?: number; appId?: string; name: string } | null> {
    if (!cookieValue) {
      console.warn("[Auth] Missing session cookie");
      return null;
    }

    try {
      const secretKey = this.getSessionSecret();
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"],
      });
      const { openId, userId, appId, name } = payload as Record<string, unknown>;

      if (!isNonEmptyString(name)) {
        console.warn("[Auth] Session payload missing name field");
        return null;
      }

      // 支持两种认证方式：OAuth (openId) 或 邮箱密码 (userId)
      if (!openId && !userId) {
        console.warn("[Auth] Session payload missing openId or userId");
        return null;
      }

      return {
        openId: isNonEmptyString(openId) ? openId : undefined,
        userId: typeof userId === 'number' ? userId : undefined,
        appId: isNonEmptyString(appId) ? appId : undefined,
        name,
      };
    } catch (error) {
      console.warn("[Auth] Session verification failed", String(error));
      return null;
    }
  }

  async getUserInfoWithJwt(
    jwtToken: string
  ): Promise<GetUserInfoWithJwtResponse> {
    const payload: GetUserInfoWithJwtRequest = {
      jwtToken,
      projectId: ENV.appId,
    };

    const { data } = await this.client.post<GetUserInfoWithJwtResponse>(
      GET_USER_INFO_WITH_JWT_PATH,
      payload
    );

    const loginMethod = this.deriveLoginMethod(
      (data as any)?.platforms,
      (data as any)?.platform ?? data.platform ?? null
    );
    return {
      ...(data as any),
      platform: loginMethod,
      loginMethod,
    } as GetUserInfoWithJwtResponse;
  }

  async authenticateRequest(req: Request): Promise<User> {
    // Regular authentication flow
    const sessionCookies = this.getCookieValues(req.headers.cookie, COOKIE_NAME);
    const fallbackCookie = this.parseCookies(req.headers.cookie).get(COOKIE_NAME);
    const candidates = sessionCookies.length > 0
      ? sessionCookies
      : fallbackCookie
        ? [fallbackCookie]
        : [];
    let session: Awaited<ReturnType<typeof this.verifySession>> = null;
    let sessionCookie: string | undefined;

    for (const candidate of candidates) {
      const verified = await this.verifySession(candidate);
      if (verified) {
        session = verified;
        sessionCookie = candidate;
        break;
      }
    }

    if (!session) {
      throw ForbiddenError("Invalid session cookie");
    }

    const signedInAt = new Date();
    let user: User | undefined;

    // 支持两种认证方式
    if (session.openId) {
      // OAuth 认证流程
      user = await db.getUserByOpenId(session.openId);

      // If user not in DB, sync from OAuth server automatically
      if (!user) {
        try {
          const userInfo = await this.getUserInfoWithJwt(sessionCookie ?? "");
          await db.upsertUser({
            openId: userInfo.openId,
            name: userInfo.name || null,
            email: userInfo.email ?? null,
            loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
            lastSignedIn: signedInAt,
          });
          user = await db.getUserByOpenId(userInfo.openId);
        } catch (error) {
          console.error("[Auth] Failed to sync user from OAuth:", error);
          throw ForbiddenError("Failed to sync user info");
        }
      }

      if (!user) {
        throw ForbiddenError("User not found");
      }

      await db.upsertUser({
        openId: user.openId,
        lastSignedIn: signedInAt,
      });
    } else if (session.userId) {
      // 邮箱密码认证流程
      user = await db.getUserById(session.userId);

      // 开发模式下允许无数据库联调：根据 session 直接构造测试用户
      if (!user && process.env.NODE_ENV === "development") {
        const isAdmin = session.name === "admin";
        user = {
          id: session.userId,
          openId: null,
          name: session.name || (isAdmin ? "admin" : "test-user"),
          email: isAdmin ? "admin@example.com" : `${session.name || "test-user"}@local.dev`,
          password: null,
          loginMethod: "email",
          role: isAdmin ? "admin" : "user",
          createdAt: new Date(),
          updatedAt: new Date(),
          lastSignedIn: new Date(),
        } as User;
      }

      if (!user) {
        throw ForbiddenError("User not found");
      }

      // 仅真实数据库用户才更新最后登录时间
      if (process.env.NODE_ENV !== "development") {
        await db.updateUser(session.userId, {
          lastSignedIn: signedInAt,
        });
        user = await db.getUserById(session.userId);
      }
    } else {
      throw ForbiddenError("Invalid session: missing openId or userId");
    }

    if (!user) {
      throw ForbiddenError("User not found");
    }

    return user;
  }
}

export const sdk = new SDKServer();
