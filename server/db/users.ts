import { desc, eq } from "drizzle-orm";
import { InsertUser, users, registrations, InsertRegistration } from "../../drizzle/schema";
import { ENV } from '../_core/env';
import { getDb } from "./connection";
import { getSystemConfigValue } from "./config";

export async function upsertUser(user: InsertUser): Promise<void> {
  // OAuth用户必须有openId，邮箱密码用户不需要
  if (!user.openId && !user.email) {
    throw new Error("User openId or email is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {};
    const updateSet: Record<string, unknown> = {};

    // 如果有openId，使用openId作为唯一标识
    if (user.openId) {
      values.openId = user.openId;
    }

    const textFields = ["name", "email", "loginMethod", "password"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    // 如果有openId，使用openId作为唯一键；否则使用email
    if (user.openId) {
      await db.insert(users).values(values).onDuplicateKeyUpdate({
        set: updateSet,
      });
    } else if (user.email) {
      // 对于邮箱密码用户，使用email作为唯一标识
      const existing = await getUserByEmail(user.email);
      if (existing) {
        await db.update(users).set(updateSet).where(eq(users.email, user.email));
      } else {
        await db.insert(users).values(values);
      }
    }
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

/**
 * 根据邮箱获取用户
 */
export async function getUserByEmail(email: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.email, email)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

/**
 * 根据ID获取用户
 */
export async function getUserById(id: number) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

/**
 * 创建用户（用于邮箱密码注册）
 */
export async function createUser(user: InsertUser): Promise<number> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  const result = await db.insert(users).values(user);
  return result[0].insertId;
}

/**
 * 更新用户信息
 */
export async function updateUser(id: number, updates: Partial<InsertUser>): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  await db.update(users).set(updates).where(eq(users.id, id));
}

export async function updateUserPasswordAndRevokeSessions(id: number, password: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(users).set({ password }).where(eq(users.id, id));
}

/**
 * 获取全部登录用户（用于后台权限管理）
 */
export async function getAllAuthUsers() {
  const db = await getDb();
  if (!db) return [];
  return await db
    .select()
    .from(users)
    .orderBy(desc(users.createdAt));
}

/**
 * 更新用户访问级别
 */
export async function updateUserAccessLevel(userId: number, accessLevel: "public_only" | "all"): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(users)
    .set({ accessLevel })
    .where(eq(users.id, userId));
}

/**
 * 从系统配置读取内部访问白名单（支持邮箱或域名规则，一行一个）
 */
export async function getInternalAccessWhitelistRules(): Promise<string[]> {
  const raw = await getSystemConfigValue("internal_access_whitelist", "");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/**
 * 判断邮箱是否命中内部白名单
 */
export async function isEmailInInternalAccessWhitelist(email: string): Promise<boolean> {
  const normalized = (email || "").trim().toLowerCase();
  if (!normalized) return false;

  const rules = await getInternalAccessWhitelistRules();
  for (const rule of rules) {
    const r = rule.toLowerCase();
    if (!r) continue;
    if (r.startsWith("@")) {
      if (normalized.endsWith(r)) return true;
    } else if (normalized === r) {
      return true;
    }
  }
  return false;
}

// ==================== Registration Functions ====================

/**
 * 创建新的注册记录
 */
export async function createRegistration(data: InsertRegistration): Promise<number> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  const result = await db.insert(registrations).values(data);
  return result[0].insertId;
}

/**
 * 根据邮箱获取注册记录
 */
export async function getRegistrationByEmail(email: string) {
  const db = await getDb();
  if (!db) {
    return undefined;
  }

  const result = await db.select().from(registrations).where(eq(registrations.email, email)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

/**
 * 获取所有注册记录
 */
export async function getAllRegistrations() {
  const db = await getDb();
  if (!db) {
    return [];
  }

  return await db.select().from(registrations).orderBy(desc(registrations.createdAt));
}
