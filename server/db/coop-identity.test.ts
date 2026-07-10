import { describe, expect, it } from "vitest";
import {
  InMemoryCoopIdentityDirectory,
  canCollaborate,
  canViewCoopSession,
  getCoopProfile,
  requireActiveCoopProfile,
} from "./coop-identity";

function directory() {
  const dir = new InMemoryCoopIdentityDirectory();
  dir.spaces.set(1, { id: 1, name: "示例协作空间 A", status: "active" });
  dir.spaces.set(2, { id: 2, name: "示例试点组", status: "active" });
  dir.spaces.set(3, { id: 3, name: "停用空间", status: "disabled" });
  dir.users.set(1, { id: 1, role: "user" });
  dir.users.set(2, { id: 2, role: "user" });
  dir.users.set(3, { id: 3, role: "user" });
  dir.users.set(9, { id: 9, role: "admin" });
  dir.profiles.set(1, { userId: 1, realName: "示例用户A", organizationName: "示例企业", departmentName: "业务部", teamName: "项目组", spaceId: 1, status: "active" });
  dir.profiles.set(2, { userId: 2, realName: "示例用户B", organizationName: "示例企业", departmentName: "业务部", teamName: "项目组", spaceId: 1, status: "active" });
  dir.profiles.set(3, { userId: 3, realName: "示例用户C", organizationName: "示例机构", departmentName: "示例部门", teamName: "试点组", spaceId: 2, status: "active" });
  dir.profiles.set(4, { userId: 4, realName: "示例用户D", organizationName: "示例机构", departmentName: "AI", teamName: null, spaceId: null, status: "active" });
  dir.profiles.set(5, { userId: 5, realName: "待审", organizationName: "示例企业", departmentName: "业务部", teamName: null, spaceId: 1, status: "pending" });
  dir.profiles.set(6, { userId: 6, realName: "禁用", organizationName: "示例企业", departmentName: "业务部", teamName: null, spaceId: 1, status: "disabled" });
  dir.profiles.set(7, { userId: 7, realName: "空间停用", organizationName: "示例企业", departmentName: "业务部", teamName: null, spaceId: 3, status: "active" });
  dir.sessions.set("cs-a", { id: "cs-a", creatorUserId: 1, spaceId: 1 });
  dir.sessions.set("cs-b", { id: "cs-b", creatorUserId: 3, spaceId: 2 });
  dir.sessions.set("cs-legacy", { id: "cs-legacy", creatorUserId: 1, spaceId: null });
  dir.members.set("cs-a", [{ targetUserId: 2 }]);
  dir.members.set("cs-b", [{ targetUserId: 1 }]);
  dir.members.set("cs-legacy", [{ targetUserId: 2 }]);
  return dir;
}

describe("coop identity helpers", () => {
  it("returns profile metadata with space name", async () => {
    const result = await getCoopProfile(1, directory());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.realName).toBe("示例用户A");
    expect(result.value.spaceName).toBe("示例协作空间 A");
  });

  it("denies active profile with null space", async () => {
    const result = await requireActiveCoopProfile(4, directory());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("space_missing");
  });

  it("denies pending and disabled profiles", async () => {
    const pending = await requireActiveCoopProfile(5, directory());
    const disabled = await requireActiveCoopProfile(6, directory());
    expect(pending.ok).toBe(false);
    expect(!pending.ok && pending.error.kind).toBe("profile_pending");
    expect(disabled.ok).toBe(false);
    expect(!disabled.ok && disabled.error.kind).toBe("profile_disabled");
  });

  it("denies profiles in disabled spaces", async () => {
    const result = await requireActiveCoopProfile(7, directory());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("space_disabled");
  });

  it("allows collaboration within the same active space", async () => {
    const result = await canCollaborate(1, 2, directory());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requester.spaceId).toBe(1);
    expect(result.value.target.spaceId).toBe(1);
  });

  it("denies collaboration across spaces", async () => {
    const result = await canCollaborate(1, 3, directory());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("space_mismatch");
  });

  it("allows session creator and member in matching space", async () => {
    const creator = await canViewCoopSession(1, "cs-a", directory());
    const member = await canViewCoopSession(2, "cs-a", directory());
    expect(creator.ok).toBe(true);
    expect(creator.ok && creator.value.role).toBe("creator");
    expect(member.ok).toBe(true);
    expect(member.ok && member.value.role).toBe("member");
  });

  it("denies non-members and space mismatches", async () => {
    const notMember = await canViewCoopSession(3, "cs-a", directory());
    const movedUserMismatch = await canViewCoopSession(1, "cs-b", directory());
    expect(notMember.ok).toBe(false);
    expect(!notMember.ok && notMember.error.kind).toBe("not_session_member");
    expect(movedUserMismatch.ok).toBe(false);
    expect(!movedUserMismatch.ok && movedUserMismatch.error.kind).toBe("space_mismatch");
  });

  it("treats legacy sessions without space snapshot as archived for regular users", async () => {
    const result = await canViewCoopSession(1, "cs-legacy", directory());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("legacy_archived");
  });

  it("allows platform admins to inspect sessions across spaces", async () => {
    const result = await canViewCoopSession(9, "cs-b", directory());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.role).toBe("admin");
  });
});
