import { and, eq } from "drizzle-orm";
import { roleSkillPreinstalls } from "../../drizzle/schema";
import { getDb } from "./connection";

export type UpsertRoleSkillPreinstallInput = {
  roleKey: string;
  skillIdentityId: string;
  versionId: string;
  artifactSha256: string;
  rolePackReleaseId: string;
  goldenTaskRunId: string;
  providedArtifactSha256: string;
  enabled: boolean;
  updatedBy: number;
};

export async function getRoleSkillPreinstall(
  roleKey: string,
  skillIdentityId: string
) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  return (
    await db
      .select()
      .from(roleSkillPreinstalls)
      .where(
        and(
          eq(roleSkillPreinstalls.roleKey, roleKey),
          eq(roleSkillPreinstalls.skillIdentityId, skillIdentityId)
        )
      )
      .limit(1)
  )[0];
}

export async function upsertRoleSkillPreinstall(
  input: UpsertRoleSkillPreinstallInput
) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db
    .insert(roleSkillPreinstalls)
    .values(input)
    .onDuplicateKeyUpdate({
      set: {
        versionId: input.versionId,
        artifactSha256: input.artifactSha256,
        rolePackReleaseId: input.rolePackReleaseId,
        goldenTaskRunId: input.goldenTaskRunId,
        providedArtifactSha256: input.providedArtifactSha256,
        enabled: input.enabled,
        updatedBy: input.updatedBy,
      },
    });
  return getRoleSkillPreinstall(input.roleKey, input.skillIdentityId);
}

export async function deleteRoleSkillPreinstall(
  roleKey: string,
  skillIdentityId: string
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db
    .delete(roleSkillPreinstalls)
    .where(
      and(
        eq(roleSkillPreinstalls.roleKey, roleKey),
        eq(roleSkillPreinstalls.skillIdentityId, skillIdentityId)
      )
    );
}
