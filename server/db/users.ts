import { desc, eq, type SQL } from "drizzle-orm";
import {
  type InsertRegistration,
  type InsertUser,
  registrations,
  users,
} from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { getSystemConfigValue } from "./config";
import { getDb } from "./connection";

type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;

async function requireDatabase(): Promise<Database> {
  const database = await getDb();
  if (!database) throw new Error("Database not available");
  return database;
}

async function optionalDatabase(action: string): Promise<Database | undefined> {
  const database = await getDb();
  if (!database)
    console.warn(`[Database] Cannot ${action}: database not available`);
  return database ?? undefined;
}

async function findUser(database: Database, condition: SQL<unknown>) {
  const [record] = await database
    .select()
    .from(users)
    .where(condition)
    .limit(1);
  return record;
}

const mutableTextFields = ["name", "email", "loginMethod", "password"] as const;

function prepareUserWrite(input: InsertUser) {
  const values: InsertUser = input.openId ? { openId: input.openId } : {};
  const updates: Partial<InsertUser> = {};

  for (const field of mutableTextFields) {
    if (input[field] === undefined) continue;
    const value = input[field] ?? null;
    Object.assign(values, { [field]: value });
    Object.assign(updates, { [field]: value });
  }

  if (input.lastSignedIn !== undefined) {
    values.lastSignedIn = input.lastSignedIn;
    updates.lastSignedIn = input.lastSignedIn;
  }

  const role =
    input.role ?? (input.openId === ENV.ownerOpenId ? "admin" : undefined);
  if (role !== undefined) {
    values.role = role;
    updates.role = role;
  }

  values.lastSignedIn ??= new Date();
  if (Object.keys(updates).length === 0) updates.lastSignedIn = new Date();

  return { values, updates };
}

export async function upsertUser(input: InsertUser): Promise<void> {
  if (!input.openId && !input.email) {
    throw new Error("User openId or email is required for upsert");
  }

  const database = await optionalDatabase("upsert user");
  if (!database) return;

  const { values, updates } = prepareUserWrite(input);
  try {
    if (input.openId) {
      await database
        .insert(users)
        .values(values)
        .onDuplicateKeyUpdate({ set: updates });
      return;
    }

    const email = input.email as string;
    const existing = await findUser(database, eq(users.email, email));
    if (existing) {
      await database.update(users).set(updates).where(eq(users.email, email));
    } else {
      await database.insert(users).values(values);
    }
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

type UserLookup =
  | { field: "openId"; value: string }
  | { field: "email"; value: string }
  | { field: "id"; value: number };

async function lookupUser(request: UserLookup) {
  const database = await optionalDatabase("get user");
  if (!database) return undefined;

  switch (request.field) {
    case "openId":
      return findUser(database, eq(users.openId, request.value));
    case "email":
      return findUser(database, eq(users.email, request.value));
    case "id":
      return findUser(database, eq(users.id, request.value));
  }
}

export async function getUserByOpenId(openId: string) {
  return lookupUser({ field: "openId", value: openId });
}

export async function getUserByEmail(email: string) {
  return lookupUser({ field: "email", value: email });
}

export async function getUserById(id: number) {
  return lookupUser({ field: "id", value: id });
}

export async function createUser(user: InsertUser): Promise<number> {
  const database = await requireDatabase();
  const [result] = await database.insert(users).values(user);
  return result.insertId;
}

export async function updateUser(
  id: number,
  updates: Partial<InsertUser>
): Promise<void> {
  const database = await requireDatabase();
  await database.update(users).set(updates).where(eq(users.id, id));
}

export async function updateUserPasswordAndRevokeSessions(
  id: number,
  password: string
): Promise<void> {
  await updateUser(id, { password });
}

export async function getAllAuthUsers() {
  const database = await getDb();
  if (!database) return [];
  return database.select().from(users).orderBy(desc(users.createdAt));
}

export async function updateUserAccessLevel(
  userId: number,
  accessLevel: "public_only" | "all"
): Promise<void> {
  await updateUser(userId, { accessLevel });
}

export async function getInternalAccessWhitelistRules(): Promise<string[]> {
  const configured = await getSystemConfigValue(
    "internal_access_whitelist",
    ""
  );
  return configured
    .split(/\r?\n/u)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0 && !entry.startsWith("#"));
}

export async function isEmailInInternalAccessWhitelist(
  email: string
): Promise<boolean> {
  const candidate = email.trim().toLowerCase();
  if (!candidate) return false;

  const rules = await getInternalAccessWhitelistRules();
  return rules.some(entry => {
    const rule = entry.toLowerCase();
    return rule.startsWith("@") ? candidate.endsWith(rule) : candidate === rule;
  });
}

export async function createRegistration(
  data: InsertRegistration
): Promise<number> {
  const database = await requireDatabase();
  const [result] = await database.insert(registrations).values(data);
  return result.insertId;
}

export async function getRegistrationByEmail(email: string) {
  const database = await getDb();
  if (!database) return undefined;
  const [registration] = await database
    .select()
    .from(registrations)
    .where(eq(registrations.email, email))
    .limit(1);
  return registration;
}

export async function getAllRegistrations() {
  const database = await getDb();
  if (!database) return [];
  return database
    .select()
    .from(registrations)
    .orderBy(desc(registrations.createdAt));
}
