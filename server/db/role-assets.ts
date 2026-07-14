import { and, eq, inArray } from "drizzle-orm";
import { roleAssetGrants, skillMarketplace, type InsertRoleAssetGrant, type RoleAssetGrant } from "../../drizzle/schema";
import {
  buildSeedRoleAssetGrants,
  planRoleAssetSeedSync,
  resolveEffectiveRoleAssetsFromBaseline,
  type EffectiveRoleAssets,
  type RoleAssetGrantRecord,
  type RoleAssetGrantSeed,
  type RoleAssetSeedSyncPlan,
} from "../_core/role-asset-grants";
import { listAgentRoleTemplates } from "../_core/role-templates";
import { getDb } from "./connection";

function toCoreGrant(row: RoleAssetGrant): RoleAssetGrantRecord {
  return {
    roleKey: row.roleKey,
    assetType: row.assetType,
    assetId: row.assetId,
    grantMode: row.grantMode,
    source: row.source,
    enabled: Boolean(row.enabled),
  };
}

function fromSeedGrant(grant: RoleAssetGrantSeed): InsertRoleAssetGrant {
  return {
    roleKey: grant.roleKey,
    assetType: grant.assetType,
    assetId: grant.assetId,
    grantMode: grant.grantMode,
    source: "seed",
    enabled: true,
    createdBy: "role-seed-sync",
    updatedBy: "role-seed-sync",
  };
}

export async function listRoleAssetGrants(): Promise<RoleAssetGrantRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(roleAssetGrants);
  return rows.map(toCoreGrant);
}

export type AdminRoleAssetGrantPatch = {
  roleKey: string;
  grantMode: "default" | "optional";
};

export async function replaceAdminRoleAssetGrantsForAsset(input: {
  assetType: "skill" | "mcp_server";
  assetId: string;
  grants: AdminRoleAssetGrantPatch[];
  actor?: string | null;
}): Promise<RoleAssetGrantRecord[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const assetId = String(input.assetId || "").trim();
  if (!assetId) throw new Error("assetId is required");
  const actor = String(input.actor || "admin").slice(0, 128);

  await db
    .update(roleAssetGrants)
    .set({ enabled: false, updatedBy: actor })
    .where(
      and(
        eq(roleAssetGrants.assetType, input.assetType),
        eq(roleAssetGrants.assetId, assetId),
        eq(roleAssetGrants.source, "admin"),
        eq(roleAssetGrants.enabled, true),
      ),
    );

  const byRole = new Map<string, AdminRoleAssetGrantPatch>();
  for (const grant of input.grants) {
    const roleKey = String(grant.roleKey || "").trim();
    if (!roleKey) continue;
    byRole.set(roleKey, {
      roleKey,
      grantMode: grant.grantMode === "default" ? "default" : "optional",
    });
  }

  for (const grant of byRole.values()) {
    await db
      .insert(roleAssetGrants)
      .values({
        roleKey: grant.roleKey,
        assetType: input.assetType,
        assetId,
        grantMode: grant.grantMode,
        source: "admin",
        enabled: true,
        createdBy: actor,
        updatedBy: actor,
      })
      .onDuplicateKeyUpdate({
        set: {
          grantMode: grant.grantMode,
          enabled: true,
          updatedBy: actor,
        },
      });
  }

  const rows = await db
    .select()
    .from(roleAssetGrants)
    .where(and(eq(roleAssetGrants.assetType, input.assetType), eq(roleAssetGrants.assetId, assetId)));
  return rows.map(toCoreGrant);
}

export async function syncGlobalOpenSourceSkillGrants(input: {
  actor?: string | null;
} = {}): Promise<{ desiredCount: number; upsertedCount: number; prunedCount: number }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const actor = String(input.actor || "opensource-skill-grant-sync").slice(0, 128);
  const approvedOpenSourceRows = await db
    .select({ skillId: skillMarketplace.skillId })
    .from(skillMarketplace)
    .where(and(eq(skillMarketplace.status, "approved"), eq(skillMarketplace.origin, "opensource")));

  const desired = Array.from(new Set(approvedOpenSourceRows.map((row) => String(row.skillId || "").trim()).filter(Boolean))).sort();
  let upsertedCount = 0;
  for (const assetId of desired) {
    await db
      .insert(roleAssetGrants)
      .values({
        roleKey: "*",
        assetType: "skill",
        assetId,
        grantMode: "optional",
        source: "market",
        enabled: true,
        createdBy: actor,
        updatedBy: actor,
      })
      .onDuplicateKeyUpdate({
        set: {
          grantMode: "optional",
          enabled: true,
          updatedBy: actor,
        },
      });
    upsertedCount += 1;
  }

  const existingMarketRows = await db
    .select()
    .from(roleAssetGrants)
    .where(and(eq(roleAssetGrants.roleKey, "*"), eq(roleAssetGrants.assetType, "skill"), eq(roleAssetGrants.source, "market")));
  const desiredSet = new Set(desired);
  let prunedCount = 0;
  for (const row of existingMarketRows) {
    if (desiredSet.has(String(row.assetId || "")) || !row.enabled) continue;
    await db
      .update(roleAssetGrants)
      .set({ enabled: false, updatedBy: actor })
      .where(eq(roleAssetGrants.id, row.id));
    prunedCount += 1;
  }

  return { desiredCount: desired.length, upsertedCount, prunedCount };
}

export async function resolveEffectiveRoleAssets(roleKey: string): Promise<EffectiveRoleAssets> {
  const db = await getDb();
  if (!db) {
    return resolveEffectiveRoleAssetsFromBaseline(roleKey, listAgentRoleTemplates(), []);
  }
  try {
    const rows = await db
      .select()
      .from(roleAssetGrants)
      .where(inArray(roleAssetGrants.roleKey, [roleKey, "*"]));
    return resolveEffectiveRoleAssetsFromBaseline(
      roleKey,
      listAgentRoleTemplates(),
      rows.map(toCoreGrant),
    );
  } catch (error) {
    console.warn("[ROLE-ASSETS] grant table unavailable; falling back to JSON seed", {
      roleKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return resolveEffectiveRoleAssetsFromBaseline(roleKey, listAgentRoleTemplates(), []);
  }
}

export async function previewRoleAssetSeedSync(): Promise<RoleAssetSeedSyncPlan> {
  const desired = buildSeedRoleAssetGrants(listAgentRoleTemplates());
  const existing = await listRoleAssetGrants();
  return planRoleAssetSeedSync(desired, existing);
}

export async function syncRoleAssetSeed(): Promise<RoleAssetSeedSyncPlan> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const desired = buildSeedRoleAssetGrants(listAgentRoleTemplates());
  const existingRows = await db.select().from(roleAssetGrants);
  const existing = existingRows.map(toCoreGrant);
  const plan = planRoleAssetSeedSync(desired, existing);

  for (const grant of plan.desired) {
    await db
      .insert(roleAssetGrants)
      .values(fromSeedGrant(grant))
      .onDuplicateKeyUpdate({
        set: {
          grantMode: grant.grantMode,
          enabled: true,
          updatedBy: "role-seed-sync",
        },
      });
  }

  for (const grant of plan.prune) {
    await db
      .update(roleAssetGrants)
      .set({ enabled: false, updatedBy: "role-seed-sync" })
      .where(
        and(
          eq(roleAssetGrants.roleKey, grant.roleKey),
          eq(roleAssetGrants.assetType, grant.assetType),
          eq(roleAssetGrants.assetId, grant.assetId),
          eq(roleAssetGrants.source, "seed"),
          eq(roleAssetGrants.enabled, true),
        ),
      );
  }

  return plan;
}
