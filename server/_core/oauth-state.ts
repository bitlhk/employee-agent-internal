import { randomBytes, timingSafeEqual } from "crypto";

const STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map<string, { redirectUri: string; expiresAt: number }>();

function equalState(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function removeExpired(now: number) {
  for (const [state, entry] of pendingStates) {
    if (entry.expiresAt <= now) pendingStates.delete(state);
  }
}

export function createOAuthState(redirectUri: string, now = Date.now()) {
  removeExpired(now);
  const state = randomBytes(32).toString("base64url");
  pendingStates.set(state, { redirectUri, expiresAt: now + STATE_TTL_MS });
  return { state, maxAgeMs: STATE_TTL_MS };
}

export function consumeOAuthState(state: string, cookieState: string | undefined, now = Date.now()): string | null {
  removeExpired(now);
  if (!cookieState || !equalState(state, cookieState)) return null;
  const entry = pendingStates.get(state);
  pendingStates.delete(state);
  if (!entry || entry.expiresAt <= now) return null;
  return entry.redirectUri;
}

export function clearOAuthStatesForTest() {
  pendingStates.clear();
}
