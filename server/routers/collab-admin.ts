import { adminProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  clawAdoptions,
  clawCollabRequests,
  lxCollabSpaces,
  lxCollabUserProfiles,
  lxCoopSessions,
  lxGroups,
  registrations,
  users,
} from "../../drizzle/schema";

const activeCoopSessionStatuses = ["drafting", "inviting", "running", "consolidating"] as const;
const acceptedCoopRequestStatuses = ["approved", "running", "completed", "failed", "partial_success", "waiting_input"] as const;

const spaceInput = z.object({
  name: z.string().min(2, "空间名称至少 2 个字").max(100, "空间名称最多 100 字"),
  description: z.string().max(2000).optional(),
  status: z.enum(["active", "disabled"]),
  sortOrder: z.number().int().min(0).max(999).default(99),
});

async function listCollabSpacesWithStats() {
  const db = await getDb();
  if (!db) throw new Error("database unavailable");
  const spaces = await db
    .select()
    .from(lxCollabSpaces)
    .orderBy(asc(lxCollabSpaces.sortOrder), asc(lxCollabSpaces.id));

  return Promise.all(spaces.map(async (space) => {
    const memberRows = await db
      .select({ c: sql<number>`count(*)` })
      .from(lxCollabUserProfiles)
      .where(and(
        eq(lxCollabUserProfiles.spaceId, space.id),
        eq(lxCollabUserProfiles.status, "active"),
      ));

    const activeSessionRows = await db
      .select({ c: sql<number>`count(*)` })
      .from(lxCoopSessions)
      .where(and(
        eq(lxCoopSessions.spaceId, space.id),
        inArray(lxCoopSessions.status, activeCoopSessionStatuses as any),
      ));

    const pendingInviteRows = await db
      .select({ c: sql<number>`count(*)` })
      .from(clawCollabRequests)
      .innerJoin(lxCoopSessions, eq(clawCollabRequests.sessionId, lxCoopSessions.id))
      .where(and(
        eq(lxCoopSessions.spaceId, space.id),
        eq(clawCollabRequests.status, "pending"),
      ));

    return {
      ...space,
      memberCount: Number(memberRows[0]?.c || 0),
      activeSessionCount: Number(activeSessionRows[0]?.c || 0),
      pendingInviteCount: Number(pendingInviteRows[0]?.c || 0),
    };
  }));
}

export const collabSpacesRouter = router({
  list: adminProcedure.query(async () => {
    return listCollabSpacesWithStats();
  }),

  create: adminProcedure
    .input(spaceInput)
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("database unavailable");
      const trimmedName = input.name.trim();
      const existing = await db
        .select({ id: lxCollabSpaces.id })
        .from(lxCollabSpaces)
        .where(eq(lxCollabSpaces.name, trimmedName))
        .limit(1);
      if (existing.length > 0) throw new Error("space name already exists");
      const result = await db.insert(lxCollabSpaces).values({
        name: trimmedName,
        description: input.description?.trim() || null,
        status: input.status,
        sortOrder: input.sortOrder,
        updatedBy: ctx.user.id,
      } as any);

      const insertId = Number((result as any)[0]?.insertId || (result as any).insertId || 0);
      if (!insertId) {
        const rows = await db
          .select({ id: lxCollabSpaces.id })
          .from(lxCollabSpaces)
          .where(eq(lxCollabSpaces.name, trimmedName))
          .limit(1);
        return { id: rows[0]?.id || 0 };
      }
      return { id: insertId };
    }),

  update: adminProcedure
    .input(spaceInput.extend({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("database unavailable");
      const trimmedName = input.name.trim();
      const existing = await db
        .select({ id: lxCollabSpaces.id })
        .from(lxCollabSpaces)
        .where(eq(lxCollabSpaces.name, trimmedName))
        .limit(1);
      if (existing.length > 0 && existing[0].id !== input.id) throw new Error("space name already exists");
      await db
        .update(lxCollabSpaces)
        .set({
          name: trimmedName,
          description: input.description?.trim() || null,
          status: input.status,
          sortOrder: input.sortOrder,
          updatedBy: ctx.user.id,
          updatedAt: new Date(),
        } as any)
        .where(eq(lxCollabSpaces.id, input.id));
      return { success: true };
    }),

  delete: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("database unavailable");
      const stats = (await listCollabSpacesWithStats()).find((space) => space.id === input.id);
      if (!stats) throw new Error("space not found");
      if (stats.memberCount > 0 || stats.activeSessionCount > 0 || stats.pendingInviteCount > 0) {
        throw new Error("space has members or active collaboration data");
      }
      await db.delete(lxCollabSpaces).where(eq(lxCollabSpaces.id, input.id));
      return { success: true };
    }),
});

const profileInput = z.object({
  userId: z.number().int().positive(),
  realName: z.string().max(100).optional(),
  organizationName: z.string().max(200).optional(),
  departmentName: z.string().max(200).optional(),
  teamName: z.string().max(200).optional(),
  spaceId: z.number().int().positive().nullable().optional(),
  status: z.enum(["pending", "active", "disabled"]),
  notes: z.string().max(2000).optional(),
});

async function getUserCoopStats(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("database unavailable");

  const createdRows = await db
    .select({ c: sql<number>`count(*)` })
    .from(lxCoopSessions)
    .where(and(
      eq(lxCoopSessions.creatorUserId, userId),
      inArray(lxCoopSessions.status, activeCoopSessionStatuses as any),
    ));

  const memberRows = await db
    .select({ c: sql<number>`count(distinct ${lxCoopSessions.id})` })
    .from(clawCollabRequests)
    .innerJoin(lxCoopSessions, eq(clawCollabRequests.sessionId, lxCoopSessions.id))
    .where(and(
      eq(clawCollabRequests.targetUserId, userId),
      inArray(clawCollabRequests.status, acceptedCoopRequestStatuses as any),
      inArray(lxCoopSessions.status, activeCoopSessionStatuses as any),
    ));

  const pendingRows = await db
    .select({ c: sql<number>`count(*)` })
    .from(clawCollabRequests)
    .where(and(
      eq(clawCollabRequests.targetUserId, userId),
      eq(clawCollabRequests.status, "pending"),
    ));

  return {
    activeSessionCount: Number(createdRows[0]?.c || 0) + Number(memberRows[0]?.c || 0),
    pendingInviteCount: Number(pendingRows[0]?.c || 0),
  };
}

export const collabMembersRouter = router({
  list: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new Error("database unavailable");
    const adoptionRows = await db
      .select({ userId: clawAdoptions.userId })
      .from(clawAdoptions)
      .where(inArray(clawAdoptions.status, ["creating", "active", "expiring"]));
    const profileRows = await db
      .select({ userId: lxCollabUserProfiles.userId })
      .from(lxCollabUserProfiles);
    const agentUserIds = Array.from(new Set([
      ...adoptionRows.map((row) => row.userId),
      ...profileRows.map((row) => row.userId),
    ]));
    if (agentUserIds.length === 0) return [];
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        groupId: users.groupId,
        groupName: lxGroups.name,
        organization: users.organization,
        registrationName: registrations.name,
        registrationCompany: registrations.company,
        profileUserId: lxCollabUserProfiles.userId,
        realName: lxCollabUserProfiles.realName,
        organizationName: lxCollabUserProfiles.organizationName,
        departmentName: lxCollabUserProfiles.departmentName,
        teamName: lxCollabUserProfiles.teamName,
        spaceId: lxCollabUserProfiles.spaceId,
        profileStatus: lxCollabUserProfiles.status,
        notes: lxCollabUserProfiles.notes,
        profileUpdatedAt: lxCollabUserProfiles.updatedAt,
        spaceName: lxCollabSpaces.name,
        spaceStatus: lxCollabSpaces.status,
      })
      .from(users)
      .leftJoin(lxGroups, eq(lxGroups.id, users.groupId))
      .leftJoin(registrations, eq(registrations.email, users.email))
      .leftJoin(lxCollabUserProfiles, eq(lxCollabUserProfiles.userId, users.id))
      .leftJoin(lxCollabSpaces, eq(lxCollabSpaces.id, lxCollabUserProfiles.spaceId))
      .where(inArray(users.id, agentUserIds))
      .orderBy(desc(users.createdAt));

    return Promise.all(rows.map(async (row) => ({
      ...row,
      hasProfile: row.profileUserId !== null,
      status: row.profileStatus || "pending",
      ...(await getUserCoopStats(row.id)),
    })));
  }),

  update: adminProcedure
    .input(profileInput)
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("database unavailable");
      const payload = {
        realName: input.realName?.trim() || null,
        organizationName: input.organizationName?.trim() || null,
        departmentName: input.departmentName?.trim() || null,
        teamName: input.teamName?.trim() || null,
        spaceId: input.spaceId ?? null,
        status: input.status,
        notes: input.notes?.trim() || null,
        updatedBy: ctx.user.id,
        updatedAt: new Date(),
      } as any;
      if (payload.status === "active" && !payload.realName) {
        throw new Error("status=active requires realName");
      }

      const existing = await db
        .select({ userId: lxCollabUserProfiles.userId })
        .from(lxCollabUserProfiles)
        .where(eq(lxCollabUserProfiles.userId, input.userId))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(lxCollabUserProfiles)
          .set(payload)
          .where(eq(lxCollabUserProfiles.userId, input.userId));
      } else {
        await db.insert(lxCollabUserProfiles).values({
          userId: input.userId,
          ...payload,
        } as any);
      }
      return { success: true };
    }),

  bulkUpdate: adminProcedure
    .input(z.object({
      userIds: z.array(z.number().int().positive()).min(1),
      spaceId: z.number().int().positive().nullable().optional(),
      status: z.enum(["pending", "active", "disabled"]).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("database unavailable");
      if (input.status === "active") {
        const rows = await db
          .select({
            userId: lxCollabUserProfiles.userId,
            realName: lxCollabUserProfiles.realName,
          })
          .from(lxCollabUserProfiles)
          .where(inArray(lxCollabUserProfiles.userId, input.userIds));
        const namesByUser = new Map(rows.map((row) => [row.userId, row.realName?.trim() || ""]));
        const missing = input.userIds.filter((userId) => !namesByUser.get(userId));
        if (missing.length > 0) {
          throw new Error(`status=active requires realName for users: ${missing.join(", ")}`);
        }
      }
      for (const userId of input.userIds) {
        const existing = await db
          .select({ userId: lxCollabUserProfiles.userId })
          .from(lxCollabUserProfiles)
          .where(eq(lxCollabUserProfiles.userId, userId))
          .limit(1);
        const patch: any = { updatedBy: ctx.user.id, updatedAt: new Date() };
        if ("spaceId" in input) patch.spaceId = input.spaceId ?? null;
        if (input.status) patch.status = input.status;
        if (existing.length > 0) {
          await db.update(lxCollabUserProfiles).set(patch).where(eq(lxCollabUserProfiles.userId, userId));
        } else {
          await db.insert(lxCollabUserProfiles).values({
            userId,
            realName: null,
            organizationName: null,
            departmentName: null,
            teamName: null,
            spaceId: "spaceId" in input ? input.spaceId ?? null : null,
            status: input.status || "pending",
            notes: null,
            updatedBy: ctx.user.id,
          } as any);
        }
      }
      return { success: true, updated: input.userIds.length };
    }),
});
