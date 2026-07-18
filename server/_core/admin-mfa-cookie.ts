import { parse as parseCookieHeader } from "cookie";
import type { Request, Response } from "express";
import { getSessionCookieOptions } from "./cookies";

export const ADMIN_MFA_CHALLENGE_COOKIE = "admin_mfa_challenge";
export const ADMIN_MFA_CHALLENGE_MAX_AGE_MS = 5 * 60 * 1000;

export function readAdminMfaChallengeCookie(req: Request): string | null {
  return parseCookieHeader(req.headers.cookie || "")[ADMIN_MFA_CHALLENGE_COOKIE] || null;
}

export function setAdminMfaChallengeCookie(req: Request, res: Response, token: string): void {
  res.cookie(ADMIN_MFA_CHALLENGE_COOKIE, token, {
    ...getSessionCookieOptions(req),
    path: "/",
    maxAge: ADMIN_MFA_CHALLENGE_MAX_AGE_MS,
  });
}

export function clearAdminMfaChallengeCookie(req: Request, res: Response): void {
  const options = getSessionCookieOptions(req);
  res.clearCookie(ADMIN_MFA_CHALLENGE_COOKIE, { ...options, path: "/" });
}
