import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { userRoleAssignments, type UserRoleAssignment } from "../../drizzle/schema";
import { getDb } from "./connection";

export type UserRoleAuthorizationState = {
  managed: boolean;
  authorized: boolean;
  assignment: UserRoleAssignment | null;
};

export async function listUserRoleAssignments(
  userId: number,
  options: { includeRevoked?: boolean } = {},
): Promise<UserRoleAssignment[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(userRoleAssignments)
    .where(options.includeRevoked
      ? eq(userRoleAssignments.userId, userId)
      : and(eq(userRoleAssignments.userId, userId), eq(userRoleAssignments.status, "active")))
    .orderBy(desc(userRoleAssignments.isDefault), asc(userRoleAssignments.assignedAt));
  return rows;
}

export async function listUserRoleAssignmentsForUsers(
  userIds: number[],
): Promise<Map<number, UserRoleAssignment[]>> {
  const db = await getDb();
  const result = new Map<number, UserRoleAssignment[]>();
  const normalizedIds = [...new Set(userIds.filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!db || normalizedIds.length === 0) return result;
  const rows = await db
    .select()
    .from(userRoleAssignments)
    .where(and(
      inArray(userRoleAssignments.userId, normalizedIds),
      eq(userRoleAssignments.status, "active"),
    ))
    .orderBy(desc(userRoleAssignments.isDefault), asc(userRoleAssignments.assignedAt));
  for (const row of rows) {
    const existing = result.get(row.userId) || [];
    existing.push(row);
    result.set(row.userId, existing);
  }
  return result;
}

export async function resolveUserRoleAuthorization(
  userId: number,
  roleTemplate: string,
): Promise<UserRoleAuthorizationState> {
  const assignments = await listUserRoleAssignments(userId, { includeRevoked: true });
  const assignment = assignments.find(row => row.roleTemplate === roleTemplate) || null;
  return {
    managed: assignments.length > 0,
    authorized: assignments.length === 0 || assignment?.status === "active",
    assignment,
  };
}

export async function ensureInitialUserRoleAssignment(input: {
  userId: number;
  roleTemplate: string;
  assignedBy?: number | null;
}): Promise<UserRoleAssignment> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const active = await listUserRoleAssignments(input.userId);
  const isDefault = active.length === 0;
  await db
    .insert(userRoleAssignments)
    .values({
      assignmentId: `ura_${nanoid(24)}`,
      userId: input.userId,
      roleTemplate: input.roleTemplate,
      status: "active",
      isDefault,
      assignedBy: input.assignedBy ?? input.userId,
      revokedAt: null,
    })
    .onDuplicateKeyUpdate({
      set: {
        status: "active",
        isDefault,
        assignedBy: input.assignedBy ?? input.userId,
        assignedAt: new Date(),
        revokedAt: null,
      },
    });
  const assignment = (await listUserRoleAssignments(input.userId))
    .find(row => row.roleTemplate === input.roleTemplate);
  if (!assignment) throw new Error("Failed to create user role assignment");
  return assignment;
}

export async function replaceUserRoleAssignments(input: {
  userId: number;
  roleTemplates: string[];
  defaultRoleTemplate: string;
  assignedBy: number;
}): Promise<UserRoleAssignment[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const roles = [...new Set(input.roleTemplates.map(role => role.trim()).filter(Boolean))];
  if (roles.length === 0) throw new Error("At least one role assignment is required");
  if (!roles.includes(input.defaultRoleTemplate)) throw new Error("Default role must be assigned");

  await db.transaction(async tx => {
    await tx
      .update(userRoleAssignments)
      .set({ status: "revoked", isDefault: false, revokedAt: new Date() })
      .where(and(
        eq(userRoleAssignments.userId, input.userId),
        notInArray(userRoleAssignments.roleTemplate, roles),
      ));

    for (const roleTemplate of roles) {
      await tx
        .insert(userRoleAssignments)
        .values({
          assignmentId: `ura_${nanoid(24)}`,
          userId: input.userId,
          roleTemplate,
          status: "active",
          isDefault: false,
          assignedBy: input.assignedBy,
          revokedAt: null,
        })
        .onDuplicateKeyUpdate({
          set: {
            status: "active",
            isDefault: false,
            assignedBy: input.assignedBy,
            assignedAt: new Date(),
            revokedAt: null,
          },
        });
    }

    await tx
      .update(userRoleAssignments)
      .set({ isDefault: false })
      .where(eq(userRoleAssignments.userId, input.userId));
    await tx
      .update(userRoleAssignments)
      .set({ isDefault: true })
      .where(and(
        eq(userRoleAssignments.userId, input.userId),
        eq(userRoleAssignments.roleTemplate, input.defaultRoleTemplate),
        eq(userRoleAssignments.status, "active"),
      ));
  });

  return listUserRoleAssignments(input.userId);
}
