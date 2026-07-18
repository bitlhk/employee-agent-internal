import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { adminMfaCredentials } from "../../drizzle/schema";
import { getDb } from "../db";
import { decryptSecret, encryptSecret, keyedDigest } from "./secret-protection";

const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const RECOVERY_CODE_COUNT = 10;

export type AdminMfaStatus = {
  enabled: boolean;
  pending: boolean;
  enabledAt: Date | null;
  recoveryCodesRemaining: number;
};

export async function getAdminMfaStatus(userId: number): Promise<AdminMfaStatus> {
  const row = await getCredential(userId);
  const recoveryCodes = parseRecoveryCodeDigests(row?.recoveryCodeDigests);
  return {
    enabled: Boolean(row?.enabled),
    pending: Boolean(row && !row.enabled),
    enabledAt: row?.enabledAt || null,
    recoveryCodesRemaining: recoveryCodes.length,
  };
}

export async function isAdminMfaEnabled(userId: number): Promise<boolean> {
  return (await getAdminMfaStatus(userId)).enabled;
}

export async function beginAdminMfaSetup(userId: number, accountName: string): Promise<{
  secret: string;
  otpauthUri: string;
}> {
  const current = await getCredential(userId);
  if (current?.enabled) throw new Error("管理员二次验证已经启用");

  const db = await requireDb();
  const secret = base32Encode(randomBytes(20));
  await db.insert(adminMfaCredentials).values({
    userId,
    secretEncrypted: encryptSecret(secret),
    recoveryCodeDigests: null,
    enabled: false,
    lastUsedStep: null,
  }).onDuplicateKeyUpdate({
    set: {
      secretEncrypted: encryptSecret(secret),
      recoveryCodeDigests: null,
      enabled: false,
      lastUsedStep: null,
      enabledAt: null,
    },
  });

  const issuer = String(process.env.ADMIN_MFA_ISSUER || "Workforce Agent Platform").trim();
  const label = `${issuer}:${accountName || `admin-${userId}`}`;
  const otpauthUri = `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
  return { secret, otpauthUri };
}

export async function confirmAdminMfaSetup(userId: number, code: string): Promise<string[]> {
  const row = await getCredential(userId);
  if (!row || row.enabled) throw new Error("没有待确认的管理员二次验证配置");
  const secret = decryptSecret(row.secretEncrypted);
  const matchedStep = findMatchingTotpStep(secret, code);
  if (matchedStep === null) throw new Error("验证码错误或已过期");

  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, createRecoveryCode);
  const db = await requireDb();
  await db.update(adminMfaCredentials).set({
    enabled: true,
    enabledAt: new Date(),
    lastUsedStep: matchedStep,
    recoveryCodeDigests: JSON.stringify(recoveryCodes.map(recoveryCodeDigest)),
  }).where(eq(adminMfaCredentials.userId, userId));
  return recoveryCodes;
}

export async function verifyAdminMfaCode(userId: number, rawCode: string): Promise<"totp" | "recovery"> {
  const row = await getCredential(userId);
  if (!row?.enabled) throw new Error("管理员二次验证尚未启用");
  const code = String(rawCode || "").trim();
  const secret = decryptSecret(row.secretEncrypted);
  const matchedStep = findMatchingTotpStep(secret, code);
  const db = await requireDb();

  if (matchedStep !== null) {
    const result: any = await db.update(adminMfaCredentials).set({ lastUsedStep: matchedStep }).where(and(
      eq(adminMfaCredentials.userId, userId),
      or(isNull(adminMfaCredentials.lastUsedStep), lt(adminMfaCredentials.lastUsedStep, matchedStep)),
    ));
    const affectedRows = Number(result?.[0]?.affectedRows ?? result?.affectedRows ?? 0);
    if (affectedRows < 1) throw new Error("验证码已使用，请等待下一组验证码");
    return "totp";
  }

  const normalizedRecovery = normalizeRecoveryCode(code);
  if (!normalizedRecovery) throw new Error("验证码错误或已过期");
  const digest = recoveryCodeDigest(normalizedRecovery);
  const existing = parseRecoveryCodeDigests(row.recoveryCodeDigests);
  const index = existing.findIndex((item) => safeEqual(item, digest));
  if (index < 0) throw new Error("验证码错误或已过期");
  existing.splice(index, 1);
  await db.update(adminMfaCredentials).set({ recoveryCodeDigests: JSON.stringify(existing) })
    .where(eq(adminMfaCredentials.userId, userId));
  return "recovery";
}

export async function disableAdminMfa(userId: number): Promise<void> {
  const db = await requireDb();
  await db.delete(adminMfaCredentials).where(eq(adminMfaCredentials.userId, userId));
}

export function generateTotp(secret: string, timestampMs = Date.now()): string {
  return totpAtStep(secret, Math.floor(timestampMs / 1000 / TOTP_PERIOD_SECONDS));
}

function findMatchingTotpStep(secret: string, code: string, timestampMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(timestampMs / 1000 / TOTP_PERIOD_SECONDS);
  for (const offset of [-1, 0, 1]) {
    const step = current + offset;
    if (safeEqual(totpAtStep(secret, step), code)) return step;
  }
  return null;
}

function totpAtStep(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, "0");
}

function base32Encode(value: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let accumulator = 0;
  let output = "";
  for (const byte of value) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(accumulator >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(accumulator << (5 - bits)) & 31];
  return output;
}

function base32Decode(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let accumulator = 0;
  const output: number[] = [];
  for (const char of value.toUpperCase().replace(/=|\s/g, "")) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("invalid TOTP secret");
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((accumulator >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function createRecoveryCode(): string {
  const raw = randomBytes(5).toString("hex").toUpperCase();
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

function normalizeRecoveryCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function recoveryCodeDigest(code: string): string {
  return keyedDigest("mfa-recovery", normalizeRecoveryCode(code));
}

function parseRecoveryCodeDigests(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function getCredential(userId: number) {
  const db = await requireDb();
  const rows = await db.select().from(adminMfaCredentials).where(eq(adminMfaCredentials.userId, userId)).limit(1);
  return rows[0];
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return db;
}
