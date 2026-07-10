import { eq, and, gt, or } from "drizzle-orm";
import { emailVerificationCodes, InsertEmailVerificationCode, smtpConfig, InsertSmtpConfig, SmtpConfig, passwordResetTokens, InsertPasswordResetToken, PasswordResetToken } from "../../drizzle/schema";
import { getDb } from "./connection";
import { decryptSecret, encryptSecret, isEncryptedSecret, keyedDigest } from "../_core/secret-protection";

/**
 * 创建邮箱验证码
 */
export async function createEmailVerificationCode(
  email: string,
  code: string,
  expiresInMinutes: number = 10
): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + expiresInMinutes);

  await db.insert(emailVerificationCodes).values({
    email,
    code: keyedDigest("email-code", code),
    expiresAt,
    used: "no",
  });
}

/**
 * 验证邮箱验证码
 */
export async function verifyEmailCode(
  email: string,
  code: string
): Promise<boolean> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  // 查找有效的验证码（未使用且未过期）
  const now = new Date();
  const codes = await db
    .select()
    .from(emailVerificationCodes)
    .where(
      and(
        eq(emailVerificationCodes.email, email),
        or(
          eq(emailVerificationCodes.code, keyedDigest("email-code", code)),
          eq(emailVerificationCodes.code, code),
        ),
        eq(emailVerificationCodes.used, "no"),
        gt(emailVerificationCodes.expiresAt, now) // 只查询未过期的
      )
    )
    .limit(1);

  if (codes.length === 0) {
    return false;
  }

  const verificationCode = codes[0];

  // 标记为已使用
  await db
    .update(emailVerificationCodes)
    .set({ used: "yes" })
    .where(eq(emailVerificationCodes.id, verificationCode.id));

  return true;
}

/**
 * 清理过期的验证码
 */
export async function cleanupExpiredVerificationCodes(): Promise<void> {
  const db = await getDb();
  if (!db) {
    return;
  }

  // 删除已过期或已使用的验证码（保留最近1小时的记录用于审计）
  const oneHourAgo = new Date();
  oneHourAgo.setHours(oneHourAgo.getHours() - 1);

  await db
    .delete(emailVerificationCodes)
    .where(
      and(
        or(
          eq(emailVerificationCodes.used, "yes"),
          // 这里需要检查过期时间，但drizzle不支持直接比较，所以我们在应用层处理
        )
      )
    );
}

/**
 * 获取SMTP配置
 */
export async function getSmtpConfig(): Promise<SmtpConfig | null> {
  const db = await getDb();
  if (!db) {
    return null;
  }

  const configs = await db.select().from(smtpConfig).limit(1);
  if (configs.length === 0) return null;
  const config = configs[0];
  if (!config.password) return config;
  const password = decryptSecret(config.password);
  if (!isEncryptedSecret(config.password)) {
    const encrypted = encryptSecret(config.password);
    await db.update(smtpConfig).set({ password: encrypted }).where(eq(smtpConfig.id, config.id));
  }
  return { ...config, password };
}

/**
 * 更新或创建SMTP配置
 */
export async function upsertSmtpConfig(
  config: Omit<InsertSmtpConfig, "id" | "updatedAt">,
  updatedBy?: number
): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  const existing = await getSmtpConfig();
  const protectedConfig = {
    ...config,
    password: config.password ? encryptSecret(String(config.password)) : config.password,
  };

  if (existing) {
    // 更新现有配置
    await db
      .update(smtpConfig)
      .set({
        ...protectedConfig,
        updatedBy: updatedBy || null,
      })
      .where(eq(smtpConfig.id, existing.id));
  } else {
    // 创建新配置
    await db.insert(smtpConfig).values({
      ...protectedConfig,
      updatedBy: updatedBy || null,
    });
  }
}

/**
 * 创建密码重置token
 */
export async function createPasswordResetToken(
  email: string,
  token: string,
  expiresInMinutes: number = 30
): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + expiresInMinutes);

  // 将同一邮箱的旧token标记为已使用
  await db
    .update(passwordResetTokens)
    .set({ used: "yes" })
    .where(
      and(
        eq(passwordResetTokens.email, email),
        eq(passwordResetTokens.used, "no")
      )
    );

  // 创建新token
  await db.insert(passwordResetTokens).values({
    email,
    token: keyedDigest("password-reset", token),
    expiresAt,
    used: "no",
  });
}

/**
 * 验证密码重置token
 */
export async function verifyPasswordResetToken(
  token: string
): Promise<PasswordResetToken | null> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  const tokens = await db
    .select()
    .from(passwordResetTokens)
    .where(
      and(
        or(
          eq(passwordResetTokens.token, keyedDigest("password-reset", token)),
          eq(passwordResetTokens.token, token),
        ),
        eq(passwordResetTokens.used, "no"),
        gt(passwordResetTokens.expiresAt, new Date())
      )
    )
    .limit(1);

  return tokens.length > 0 ? tokens[0] : null;
}

/**
 * 标记密码重置token为已使用
 */
export async function markPasswordResetTokenAsUsed(token: string): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  await db
    .update(passwordResetTokens)
    .set({ used: "yes" })
    .where(or(
      eq(passwordResetTokens.token, keyedDigest("password-reset", token)),
      eq(passwordResetTokens.token, token),
    ));
}
