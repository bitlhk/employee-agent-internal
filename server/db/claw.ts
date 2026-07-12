import { desc, eq, inArray, and, sql } from "drizzle-orm";
import { users, clawAdoptions, clawAdoptionEvents, clawProfileSettings, clawCollabSettings, InsertClawAdoption, InsertClawAdoptionEvent, InsertClawProfileSetting, ClawAdoption, registrations, lxGroups } from "../../drizzle/schema";
import { getDb } from "./connection";

// ============ 灵感龙虾方案（领养实例） ============

export type ClawAdoptionStatus = "creating" | "active" | "expiring" | "recycled" | "failed";
export type ClawPermissionProfile = "starter" | "plus" | "internal";
export type ClawEventType =
  | "create_requested"
  | "create_succeeded"
  | "create_failed"
  | "profile_updated"
  | "ttl_extended"
  | "recycle_requested"
  | "recycle_succeeded"
  | "recycle_failed";

/**
 * 获取用户当前活跃（或创建中）的虾
 */
export async function getCurrentClawByUserId(userId: number): Promise<ClawAdoption | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    const rows = await db
      .select()
      .from(clawAdoptions)
      .where(and(eq(clawAdoptions.userId, userId), inArray(clawAdoptions.status, ["creating", "active", "expiring"])))
      .orderBy(desc(clawAdoptions.id))
      .limit(1);

    return rows[0] || null;
  } catch (error) {
    console.error("[Database] Failed to get current claw by userId:", error);
    return null;
  }
}

/**
 * 列出用户所有活跃的虾（支持多 runtime: lgc-* / lgh-* legacy archived）
 * orderBy: OpenClaw (lgc-) 优先，其次按 id 升序（老虾在前）
 */
export async function listClawsByUserId(userId: number): Promise<ClawAdoption[]> {
  const db = await getDb();
  if (!db) return [];

  try {
    const rows = await db
      .select()
      .from(clawAdoptions)
      .where(and(eq(clawAdoptions.userId, userId), inArray(clawAdoptions.status, ["creating", "active", "expiring"])))
      .orderBy(clawAdoptions.id);

    // Stable sort: lgc-* 先（老 runtime），lgh-* 后
    return rows.sort((a, b) => {
      const aIsOpenClaw = a.adoptId.startsWith("lgc-");
      const bIsOpenClaw = b.adoptId.startsWith("lgc-");
      if (aIsOpenClaw && !bIsOpenClaw) return -1;
      if (!aIsOpenClaw && bIsOpenClaw) return 1;
      return Number(a.id) - Number(b.id);
    });
  } catch (error) {
    console.error("[Database] Failed to list claws by userId:", error);
    return [];
  }
}

/**
 * 按 adoptId 获取领养记录
 */
export async function getClawByAdoptId(adoptId: string): Promise<ClawAdoption | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    const rows = await db.select().from(clawAdoptions).where(eq(clawAdoptions.adoptId, adoptId)).limit(1);
    return rows[0] || null;
  } catch (error) {
    console.error("[Database] Failed to get claw by adoptId:", error);
    return null;
  }
}

/**
 * Look up an adoption by its runtime agent identity.
 *
 * Runtime-facing services receive agentId rather than a user-controlled adoptId,
 * so authorization checks should resolve the adoption from this value directly.
 */
export async function getClawByAgentId(agentId: string): Promise<ClawAdoption | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    const rows = await db.select().from(clawAdoptions).where(eq(clawAdoptions.agentId, agentId)).limit(1);
    return rows[0] || null;
  } catch (error) {
    console.error("[Database] Failed to get claw by agentId:", error);
    return null;
  }
}

/**
 * 创建领养记录
 */
export async function createClawAdoption(
  payload: Omit<InsertClawAdoption, "id" | "createdAt" | "updatedAt" | "lastError"> & { lastError?: string | null }
): Promise<number> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  try {
    const result = await db.insert(clawAdoptions).values({
      ...payload,
      lastError: payload.lastError ?? null,
    });
    return Number(result[0].insertId);
  } catch (error) {
    console.error("[Database] Failed to create claw adoption:", error);
    throw error;
  }
}

/**
 * 更新领养状态
 */
export async function updateClawAdoptionStatus(
  id: number,
  status: ClawAdoptionStatus,
  options?: {
    expiresAt?: Date | null;
    entryUrl?: string;
    permissionProfile?: ClawPermissionProfile;
    ttlDays?: number;
    lastError?: string | null;
  }
): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  const patch: Partial<InsertClawAdoption> = {
    status,
  };

  if (options && "expiresAt" in options) patch.expiresAt = options.expiresAt ?? null;
  if (options?.entryUrl) patch.entryUrl = options.entryUrl;
  if (options?.permissionProfile) patch.permissionProfile = options.permissionProfile;
  if (typeof options?.ttlDays === "number") patch.ttlDays = options.ttlDays;
  if (options && "lastError" in options) patch.lastError = options.lastError ?? null;

  try {
    await db.update(clawAdoptions).set(patch).where(eq(clawAdoptions.id, id));
  } catch (error) {
    console.error("[Database] Failed to update claw adoption status:", error);
    throw error;
  }
}

/** 更新 lastActivityAt（best-effort，不抛错） */
export async function touchClawActivity(adoptId: string): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.update(clawAdoptions).set({ lastActivityAt: new Date() }).where(eq(clawAdoptions.adoptId, adoptId));
  } catch {
    // best-effort, ignore
  }
}

export async function listClawAdoptionsAdmin(params?: {
  keyword?: string;
  status?: ClawAdoptionStatus | "all";
  limit?: number;
}) {
  const db = await getDb();
  if (!db) return [];

  const limit = Math.min(Math.max(params?.limit ?? 200, 20), 1000);

  try {
    const joined = await db
      .select({
        id: clawAdoptions.id,
        userId: clawAdoptions.userId,
        adoptId: clawAdoptions.adoptId,
        agentId: clawAdoptions.agentId,
        status: clawAdoptions.status,
        permissionProfile: clawAdoptions.permissionProfile,
        roleTemplate: clawAdoptions.roleTemplate,
        industry: clawAdoptions.industry,
        runtime: clawAdoptions.runtime,
        ttlDays: clawAdoptions.ttlDays,
        entryUrl: clawAdoptions.entryUrl,
        expiresAt: clawAdoptions.expiresAt,
        lastError: clawAdoptions.lastError,
        createdAt: clawAdoptions.createdAt,
        updatedAt: clawAdoptions.updatedAt,
        userName: users.name,
        userEmail: users.email,
        userGroupId: users.groupId,
        organizationName: sql<string | null>`COALESCE(${users.organization}, ${registrations.company})`,
        groupName: lxGroups.name,
      })
      .from(clawAdoptions)
      .leftJoin(users, eq(clawAdoptions.userId, users.id))
      .leftJoin(registrations, eq(registrations.email, users.email))
      .leftJoin(lxGroups, eq(lxGroups.id, users.groupId))
      .orderBy(desc(clawAdoptions.id))
      .limit(limit);

    let rows = joined;

    if (params?.status && params.status !== "all") {
      rows = rows.filter((r) => r.status === params.status);
    }

    if (params?.keyword?.trim()) {
      const q = params.keyword.trim().toLowerCase();
      rows = rows.filter((r) =>
        String(r.adoptId || "").toLowerCase().includes(q) ||
        String(r.agentId || "").toLowerCase().includes(q) ||
        String(r.userName || "").toLowerCase().includes(q) ||
        String(r.userEmail || "").toLowerCase().includes(q) ||
        String(r.userId || "").toLowerCase().includes(q)
      );
    }

    return rows;
  } catch (error) {
    console.error("[Database] Failed to list claw adoptions:", error);
    return [];
  }
}

export async function updateClawAdoptionAdmin(
  id: number,
  patch: {
    permissionProfile?: ClawPermissionProfile;
    roleTemplate?: string;
    industry?: string;
    runtime?: string;
    ttlDays?: number;
    status?: ClawAdoptionStatus;
    expiresAt?: Date | null;
  }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const nextPatch: Partial<InsertClawAdoption> = {};
  if (patch.permissionProfile) nextPatch.permissionProfile = patch.permissionProfile;
  if (patch.roleTemplate) nextPatch.roleTemplate = patch.roleTemplate;
  if (patch.industry) nextPatch.industry = patch.industry;
  if (patch.runtime) nextPatch.runtime = patch.runtime;
  if (typeof patch.ttlDays === "number") {
    nextPatch.ttlDays = patch.ttlDays;
    nextPatch.expiresAt = patch.ttlDays > 0
      ? new Date(Date.now() + patch.ttlDays * 24 * 60 * 60 * 1000)
      : null;
  }
  if ("expiresAt" in patch) nextPatch.expiresAt = patch.expiresAt ?? null;
  if (patch.status) nextPatch.status = patch.status;

  await db.update(clawAdoptions).set(nextPatch).where(eq(clawAdoptions.id, id));
}

export async function batchUpdateClawAdoptionAdmin(
  ids: number[],
  patch: {
    permissionProfile?: ClawPermissionProfile;
    roleTemplate?: string;
    industry?: string;
    runtime?: string;
    ttlDays?: number;
    status?: ClawAdoptionStatus;
  }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (!ids.length) return;

  const nextPatch: Partial<InsertClawAdoption> = {};
  if (patch.permissionProfile) nextPatch.permissionProfile = patch.permissionProfile;
  if (patch.roleTemplate) nextPatch.roleTemplate = patch.roleTemplate;
  if (patch.industry) nextPatch.industry = patch.industry;
  if (patch.runtime) nextPatch.runtime = patch.runtime;
  if (typeof patch.ttlDays === "number") {
    nextPatch.ttlDays = patch.ttlDays;
    nextPatch.expiresAt = patch.ttlDays > 0
      ? new Date(Date.now() + patch.ttlDays * 24 * 60 * 60 * 1000)
      : null;
  }
  if (patch.status) nextPatch.status = patch.status;

  await db.update(clawAdoptions).set(nextPatch).where(inArray(clawAdoptions.id, ids));
}

export async function getClawAdoptionAdminById(id: number): Promise<ClawAdoption | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db.select().from(clawAdoptions).where(eq(clawAdoptions.id, id)).limit(1);
  return rows[0] || null;
}

export async function deleteClawAdoptionAdmin(id: number): Promise<ClawAdoption> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db.select().from(clawAdoptions).where(eq(clawAdoptions.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new Error("claw adoption not found");
  if (!["recycled", "failed"].includes(row.status)) {
    throw new Error("only recycled or failed claws can be deleted");
  }

  await db.delete(clawProfileSettings).where(eq(clawProfileSettings.adoptionId, id));
  await db.delete(clawCollabSettings).where(eq(clawCollabSettings.adoptionId, id));
  await db.delete(clawAdoptions).where(eq(clawAdoptions.id, id));
  return row;
}


/**
 * 记录领养生命周期事件
 */
export async function appendClawAdoptionEvent(
  payload: Omit<InsertClawAdoptionEvent, "id" | "createdAt">
): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  try {
    await db.insert(clawAdoptionEvents).values(payload);
  } catch (error) {
    console.error("[Database] Failed to append claw adoption event:", error);
    throw error;
  }
}

export async function getClawProfileSettings(adoptionId: number) {
  const db = await getDb();
  if (!db) return null;

  try {
    const rows = await db
      .select()
      .from(clawProfileSettings)
      .where(eq(clawProfileSettings.adoptionId, adoptionId))
      .limit(1);
    return rows[0] || null;
  } catch (error) {
    console.error("[Database] Failed to get claw profile settings:", error);
    return null;
  }
}

export async function upsertClawProfileSettings(
  adoptionId: number,
  payload: Partial<Omit<InsertClawProfileSetting, "id" | "adoptionId" | "createdAt" | "updatedAt">>
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const existing = await getClawProfileSettings(adoptionId);
  if (existing) {
    await db.update(clawProfileSettings).set(payload).where(eq(clawProfileSettings.adoptionId, adoptionId));
    return await getClawProfileSettings(adoptionId);
  }

  await db.insert(clawProfileSettings).values({ adoptionId, ...payload });
  return await getClawProfileSettings(adoptionId);
}
