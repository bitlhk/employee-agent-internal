import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { userRoleAssignments } from "../../drizzle/schema";
import { closeDbConnection, getDb } from "./connection";
import {
  ensureInitialUserRoleAssignment,
  listUserRoleAssignments,
  replaceUserRoleAssignments,
  resolveUserRoleAuthorization,
} from "./user-role-assignments";

const suite = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const userId = 2_000_000_000 - Math.floor(Math.random() * 100_000);

suite("user role assignments", () => {
  beforeAll(async () => {
    const db = await getDb();
    if (!db) throw new Error("DATABASE_URL is required for DB integration tests");
    await db.select().from(userRoleAssignments).limit(1);
  });

  afterAll(async () => {
    const db = await getDb();
    if (db) await db.delete(userRoleAssignments).where(eq(userRoleAssignments.userId, userId));
    await closeDbConnection();
  });

  it("keeps authorization separate from the default role selection", async () => {
    const initial = await ensureInitialUserRoleAssignment({
      userId,
      roleTemplate: "wealth-manager",
      assignedBy: userId,
    });
    expect(initial).toMatchObject({ roleTemplate: "wealth-manager", status: "active", isDefault: true });

    const assigned = await replaceUserRoleAssignments({
      userId,
      roleTemplates: ["wealth-manager", "insurance-advisor"],
      defaultRoleTemplate: "insurance-advisor",
      assignedBy: userId,
    });
    expect(assigned.map(row => row.roleTemplate).sort()).toEqual(["insurance-advisor", "wealth-manager"]);
    expect(assigned.find(row => row.isDefault)?.roleTemplate).toBe("insurance-advisor");
    await expect(resolveUserRoleAuthorization(userId, "wealth-manager")).resolves.toMatchObject({ managed: true, authorized: true });
    await expect(resolveUserRoleAuthorization(userId, "insurance-advisor")).resolves.toMatchObject({ managed: true, authorized: true });

    await replaceUserRoleAssignments({
      userId,
      roleTemplates: ["wealth-manager"],
      defaultRoleTemplate: "wealth-manager",
      assignedBy: userId,
    });
    await expect(resolveUserRoleAuthorization(userId, "insurance-advisor")).resolves.toMatchObject({ managed: true, authorized: false });
    await expect(listUserRoleAssignments(userId)).resolves.toHaveLength(1);
  });
});
