import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  lxCollabSpaces,
  lxCollabUserProfiles,
  lxCoopSessions,
  clawCollabRequests,
  users,
  type User,
  type LxCollabSpace,
  type LxCollabUserProfile,
  type LxCoopSession,
} from "../../drizzle/schema";
import { getDb } from "./connection";

export type CoopErrorKind =
  | "profile_missing"
  | "profile_pending"
  | "profile_disabled"
  | "space_missing"
  | "space_disabled"
  | "space_mismatch"
  | "not_session_member"
  | "legacy_archived"
  | "session_not_found";

export type CoopResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { kind: CoopErrorKind; detail: string } };

export type CoopProfileStatus = "pending" | "active" | "disabled";
export type CoopSpaceStatus = "active" | "disabled";

export type CoopProfile = {
  userId: number;
  realName: string | null;
  organizationName: string | null;
  departmentName: string | null;
  teamName: string | null;
  spaceId: number | null;
  spaceName: string | null;
  status: CoopProfileStatus;
};

export type CoopSessionAccess = {
  role: "creator" | "member" | "admin";
  profile: CoopProfile | null;
};

type CoopUserRecord = Pick<User, "id" | "role">;
type CoopSpaceRecord = Pick<LxCollabSpace, "id" | "name" | "status">;
type CoopProfileRecord = Pick<LxCollabUserProfile, "userId" | "realName" | "organizationName" | "departmentName" | "teamName" | "spaceId" | "status">;
type CoopSessionRecord = Pick<LxCoopSession, "id" | "creatorUserId"> & { spaceId?: number | null };

type CoopSessionMemberRecord = { targetUserId: number };

export interface CoopIdentityDirectory {
  getUser(userId: number): Promise<CoopUserRecord | null>;
  getProfile(userId: number): Promise<CoopProfileRecord | null>;
  getSpace(spaceId: number): Promise<CoopSpaceRecord | null>;
  getSession(sessionId: string): Promise<CoopSessionRecord | null>;
  listSessionMembers(sessionId: string): Promise<CoopSessionMemberRecord[]>;
}

class DatabaseCoopIdentityDirectory implements CoopIdentityDirectory {
  async getUser(userId: number): Promise<CoopUserRecord | null> {
    const db = await getDb();
    if (!db) return null;
    const rows = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    return rows[0] ?? null;
  }

  async getProfile(userId: number): Promise<CoopProfileRecord | null> {
    const db = await getDb();
    if (!db) return null;
    const rows = await db
      .select({
        userId: lxCollabUserProfiles.userId,
        realName: lxCollabUserProfiles.realName,
        organizationName: lxCollabUserProfiles.organizationName,
        departmentName: lxCollabUserProfiles.departmentName,
        teamName: lxCollabUserProfiles.teamName,
        spaceId: lxCollabUserProfiles.spaceId,
        status: lxCollabUserProfiles.status,
      })
      .from(lxCollabUserProfiles)
      .where(eq(lxCollabUserProfiles.userId, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  async getSpace(spaceId: number): Promise<CoopSpaceRecord | null> {
    const db = await getDb();
    if (!db) return null;
    const rows = await db
      .select({ id: lxCollabSpaces.id, name: lxCollabSpaces.name, status: lxCollabSpaces.status })
      .from(lxCollabSpaces)
      .where(eq(lxCollabSpaces.id, spaceId))
      .limit(1);
    return rows[0] ?? null;
  }

  async getSession(sessionId: string): Promise<CoopSessionRecord | null> {
    const db = await getDb();
    if (!db) return null;
    const rows = await db
      .select({ id: lxCoopSessions.id, creatorUserId: lxCoopSessions.creatorUserId, spaceId: lxCoopSessions.spaceId })
      .from(lxCoopSessions)
      .where(eq(lxCoopSessions.id, sessionId))
      .limit(1);
    return rows[0] ?? null;
  }

  async listSessionMembers(sessionId: string): Promise<CoopSessionMemberRecord[]> {
    const db = await getDb();
    if (!db) return [];
    return db
      .select({ targetUserId: clawCollabRequests.targetUserId })
      .from(clawCollabRequests)
      .where(eq(clawCollabRequests.sessionId, sessionId));
  }
}

const defaultDirectory = new DatabaseCoopIdentityDirectory();

function err<T>(kind: CoopErrorKind, detail: string): CoopResult<T> {
  return { ok: false, error: { kind, detail } };
}

function profileFromRow(row: CoopProfileRecord, space: CoopSpaceRecord | null): CoopProfile {
  return {
    userId: row.userId,
    realName: row.realName ?? null,
    organizationName: row.organizationName ?? null,
    departmentName: row.departmentName ?? null,
    teamName: row.teamName ?? null,
    spaceId: row.spaceId ?? null,
    spaceName: space?.name ?? null,
    status: row.status as CoopProfileStatus,
  };
}

export async function isPlatformAdmin(userId: number, directory: CoopIdentityDirectory = defaultDirectory): Promise<boolean> {
  const user = await directory.getUser(userId);
  return user?.role === "admin";
}

export async function getCoopProfile(
  userId: number,
  directory: CoopIdentityDirectory = defaultDirectory,
): Promise<CoopResult<CoopProfile>> {
  const row = await directory.getProfile(userId);
  if (!row) return err("profile_missing", `user ${userId} has no collaboration profile`);

  const space = row.spaceId ? await directory.getSpace(row.spaceId) : null;
  return { ok: true, value: profileFromRow(row, space) };
}

// Returns ok only if profile.status === "active" and the profile belongs to an active non-null space.
// Callers decide whether to throw, show an empty state, or surface a validation message.
export async function requireActiveCoopProfile(
  userId: number,
  directory: CoopIdentityDirectory = defaultDirectory,
): Promise<CoopResult<CoopProfile>> {
  const profileResult = await getCoopProfile(userId, directory);
  if (!profileResult.ok) return profileResult;
  const profile = profileResult.value;

  if (profile.status === "pending") return err("profile_pending", `user ${userId} collaboration profile is pending`);
  if (profile.status === "disabled") return err("profile_disabled", `user ${userId} collaboration profile is disabled`);
  if (!profile.spaceId) return err("space_missing", `user ${userId} has no collaboration space`);

  const space = await directory.getSpace(profile.spaceId);
  if (!space) return err("space_missing", `collaboration space ${profile.spaceId} does not exist`);
  if (space.status !== "active") return err("space_disabled", `collaboration space ${profile.spaceId} is disabled`);

  return { ok: true, value: { ...profile, spaceName: space.name } };
}

export async function canCollaborate(
  requesterUserId: number,
  targetUserId: number,
  directory: CoopIdentityDirectory = defaultDirectory,
): Promise<CoopResult<{ requester: CoopProfile; target: CoopProfile }>> {
  const requester = await requireActiveCoopProfile(requesterUserId, directory);
  if (!requester.ok) return requester;
  const target = await requireActiveCoopProfile(targetUserId, directory);
  if (!target.ok) return target;

  if (!requester.value.spaceId || !target.value.spaceId || requester.value.spaceId !== target.value.spaceId) {
    return err("space_mismatch", `users ${requesterUserId} and ${targetUserId} are not in the same collaboration space`);
  }

  return { ok: true, value: { requester: requester.value, target: target.value } };
}

// Shared assertions for existing collaboration entry points, including calendar tools.
export async function assertCoopMember(userId: number, directory: CoopIdentityDirectory = defaultDirectory) {
  const access = await requireActiveCoopProfile(userId, directory);
  if (!access.ok) throw new TRPCError({ code: "FORBIDDEN", message: "请联系管理员开通组织协作权限并分配有效组织" });
  return access.value;
}

export async function assertCoopParticipants(userId: number, participantIds: number[], directory: CoopIdentityDirectory = defaultDirectory) {
  if (!participantIds.length) return;
  await assertCoopMember(userId, directory);
  for (const participantId of new Set(participantIds)) {
    const access = await canCollaborate(userId, participantId, directory);
    if (!access.ok) throw new TRPCError({ code: "FORBIDDEN", message: "只能与同一有效组织内的成员协作，请重新选择参与人" });
  }
}

export async function canViewCoopSession(
  viewerUserId: number,
  sessionId: string,
  directory: CoopIdentityDirectory = defaultDirectory,
): Promise<CoopResult<CoopSessionAccess>> {
  const session = await directory.getSession(sessionId);
  if (!session) return err("session_not_found", `coop session ${sessionId} not found`);

  if (await isPlatformAdmin(viewerUserId, directory)) {
    const profile = await getCoopProfile(viewerUserId, directory);
    // Platform-admin override, not a session-level admin role.
    return { ok: true, value: { role: "admin", profile: profile.ok ? profile.value : null } };
  }

  const profile = await requireActiveCoopProfile(viewerUserId, directory);
  if (!profile.ok) return profile;

  const isCreator = session.creatorUserId === viewerUserId;
  const members = await directory.listSessionMembers(sessionId);
  const isMember = members.some((m) => m.targetUserId === viewerUserId);
  if (!isCreator && !isMember) return err("not_session_member", `user ${viewerUserId} is not a member of session ${sessionId}`);

  if (!session.spaceId) return err("legacy_archived", `coop session ${sessionId} has no collaboration space snapshot`);
  if (!profile.value.spaceId || profile.value.spaceId !== session.spaceId) {
    return err("space_mismatch", `user ${viewerUserId} is not in session ${sessionId} space`);
  }

  return { ok: true, value: { role: isCreator ? "creator" : "member", profile: profile.value } };
}

export class InMemoryCoopIdentityDirectory implements CoopIdentityDirectory {
  users = new Map<number, CoopUserRecord>();
  profiles = new Map<number, CoopProfileRecord>();
  spaces = new Map<number, CoopSpaceRecord>();
  sessions = new Map<string, CoopSessionRecord>();
  members = new Map<string, CoopSessionMemberRecord[]>();

  async getUser(userId: number): Promise<CoopUserRecord | null> { return this.users.get(userId) ?? null; }
  async getProfile(userId: number): Promise<CoopProfileRecord | null> { return this.profiles.get(userId) ?? null; }
  async getSpace(spaceId: number): Promise<CoopSpaceRecord | null> { return this.spaces.get(spaceId) ?? null; }
  async getSession(sessionId: string): Promise<CoopSessionRecord | null> { return this.sessions.get(sessionId) ?? null; }
  async listSessionMembers(sessionId: string): Promise<CoopSessionMemberRecord[]> { return this.members.get(sessionId) ?? []; }
}
