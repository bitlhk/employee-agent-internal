import type { AuthenticatedUser } from "./sdk";
import { isAdminMfaEnabled } from "./admin-mfa";

const DEFAULT_STEP_UP_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function adminMfaStepUpMaxAgeMs(): number {
  const configured = Number(process.env.ADMIN_MFA_STEP_UP_MAX_AGE_MS || DEFAULT_STEP_UP_MAX_AGE_MS);
  return Number.isFinite(configured)
    ? Math.max(5 * 60 * 1000, Math.min(24 * 60 * 60 * 1000, configured))
    : DEFAULT_STEP_UP_MAX_AGE_MS;
}

export function isAdminMfaSessionFresh(user: AuthenticatedUser, now = Date.now()): boolean {
  return typeof user.mfaVerifiedAt === "number"
    && user.mfaVerifiedAt <= now + 60_000
    && now - user.mfaVerifiedAt <= adminMfaStepUpMaxAgeMs();
}

export async function adminMfaWriteAccess(user: AuthenticatedUser): Promise<{ required: boolean; fresh: boolean }> {
  if (user.role !== "admin") return { required: false, fresh: true };
  const required = await isAdminMfaEnabled(user.id);
  return { required, fresh: !required || isAdminMfaSessionFresh(user) };
}
