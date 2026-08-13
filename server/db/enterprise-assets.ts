import { and, desc, eq, inArray, ne } from "drizzle-orm";
import {
  enterpriseAssetCandidates,
  enterpriseAssetSources,
  rolePackReleases,
  type EnterpriseAssetCandidate,
  type InsertEnterpriseAssetCandidate,
  type InsertEnterpriseAssetSource,
} from "../../drizzle/schema";
import { getDb } from "./connection";

async function database() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db;
}

export async function listEnterpriseAssetSources() {
  return (await database()).select().from(enterpriseAssetSources)
    .orderBy(desc(enterpriseAssetSources.updatedAt));
}

export async function getEnterpriseAssetSource(sourceId: string) {
  const [row] = await (await database()).select().from(enterpriseAssetSources)
    .where(eq(enterpriseAssetSources.sourceId, sourceId)).limit(1);
  return row || null;
}

export async function upsertEnterpriseAssetSource(input: InsertEnterpriseAssetSource) {
  const db = await database();
  await db.insert(enterpriseAssetSources).values(input).onDuplicateKeyUpdate({
    set: {
      displayName: input.displayName,
      sourceType: input.sourceType,
      sourceUri: input.sourceUri || null,
      ownerDepartment: input.ownerDepartment,
      ownerContact: input.ownerContact || null,
      syncMode: input.syncMode,
      status: input.status,
      updatedBy: input.updatedBy,
    },
  });
  return getEnterpriseAssetSource(input.sourceId);
}

export async function listEnterpriseAssetCandidates(input: { sourceId?: string; status?: EnterpriseAssetCandidate["status"] } = {}) {
  const db = await database();
  const filters = [
    input.sourceId ? eq(enterpriseAssetCandidates.sourceId, input.sourceId) : undefined,
    input.status ? eq(enterpriseAssetCandidates.status, input.status) : undefined,
  ].filter(Boolean);
  return db.select().from(enterpriseAssetCandidates)
    .where(filters.length ? and(...filters as any) : undefined)
    .orderBy(desc(enterpriseAssetCandidates.updatedAt));
}

export async function getEnterpriseAssetCandidate(candidateId: string) {
  const [row] = await (await database()).select().from(enterpriseAssetCandidates)
    .where(eq(enterpriseAssetCandidates.candidateId, candidateId)).limit(1);
  return row || null;
}

export async function upsertEnterpriseAssetCandidate(input: InsertEnterpriseAssetCandidate) {
  const db = await database();
  await db.insert(enterpriseAssetCandidates).values(input);
  const [row] = await db.select().from(enterpriseAssetCandidates).where(and(
    eq(enterpriseAssetCandidates.sourceId, input.sourceId),
    eq(enterpriseAssetCandidates.enterpriseAssetId, input.enterpriseAssetId),
    eq(enterpriseAssetCandidates.sourceVersion, input.sourceVersion || "1.0"),
  )).limit(1);
  return row;
}

export async function importEnterpriseAssetCandidates(inputs: InsertEnterpriseAssetCandidate[]) {
  const db = await database();
  return db.transaction(async tx => {
    const rows: EnterpriseAssetCandidate[] = [];
    for (const input of inputs) {
      const sourceVersion = input.sourceVersion || "1.0";
      const [existing] = await tx.select().from(enterpriseAssetCandidates).where(and(
        eq(enterpriseAssetCandidates.sourceId, input.sourceId),
        eq(enterpriseAssetCandidates.enterpriseAssetId, input.enterpriseAssetId),
        eq(enterpriseAssetCandidates.sourceVersion, sourceVersion),
      )).limit(1);
      if (existing) {
        if (existing.checksum !== input.checksum) {
          throw new Error(`资产 ${input.enterpriseAssetId} 版本 ${sourceVersion} 已存在但校验值不同；请发布新版本，不能覆盖既有证据`);
        }
        rows.push(existing);
        continue;
      }
      await tx.insert(enterpriseAssetCandidates).values({ ...input, sourceVersion });
      const [created] = await tx.select().from(enterpriseAssetCandidates)
        .where(eq(enterpriseAssetCandidates.candidateId, input.candidateId)).limit(1);
      if (!created) throw new Error(`资产候选 ${input.enterpriseAssetId} 创建失败`);
      rows.push(created);
    }
    return rows;
  });
}

export async function updateEnterpriseAssetCandidate(
  candidateId: string,
  values: Partial<typeof enterpriseAssetCandidates.$inferInsert>,
  expectedStatuses?: EnterpriseAssetCandidate["status"][],
) {
  const db = await database();
  await db.update(enterpriseAssetCandidates).set(values)
    .where(and(
      eq(enterpriseAssetCandidates.candidateId, candidateId),
      expectedStatuses?.length ? inArray(enterpriseAssetCandidates.status, expectedStatuses) : undefined,
    ));
  return getEnterpriseAssetCandidate(candidateId);
}

export async function staleRolePackReleases(rolePackIds: string[]) {
  if (!rolePackIds.length) return 0;
  const result = await (await database()).update(rolePackReleases).set({ status: "stale" }).where(and(
    inArray(rolePackReleases.rolePackId, rolePackIds),
    eq(rolePackReleases.status, "verified"),
  ));
  return Number((result as any)[0]?.affectedRows || 0);
}

export async function publishEnterpriseAssetCandidate(input: {
  candidate: EnterpriseAssetCandidate;
  targetAssetType: NonNullable<EnterpriseAssetCandidate["targetAssetType"]>;
  targetAssetId: string;
  impactAnalysisJson: Record<string, unknown>;
  affectedRolePackIds: string[];
  actor: string;
}) {
  const db = await database();
  return db.transaction(async tx => {
    await tx.update(enterpriseAssetCandidates).set({ status: "stale", updatedBy: input.actor }).where(and(
      eq(enterpriseAssetCandidates.enterpriseAssetId, input.candidate.enterpriseAssetId),
      eq(enterpriseAssetCandidates.status, "published"),
      ne(enterpriseAssetCandidates.candidateId, input.candidate.candidateId),
    ));
    await tx.update(enterpriseAssetCandidates).set({
      status: "published",
      targetAssetType: input.targetAssetType,
      targetAssetId: input.targetAssetId,
      impactAnalysisJson: input.impactAnalysisJson,
      publishedBy: input.actor,
      publishedAt: new Date(),
      updatedBy: input.actor,
    }).where(and(
      eq(enterpriseAssetCandidates.candidateId, input.candidate.candidateId),
      eq(enterpriseAssetCandidates.status, "approved"),
    ));
    if (input.affectedRolePackIds.length) {
      await tx.update(rolePackReleases).set({ status: "stale" }).where(and(
        inArray(rolePackReleases.rolePackId, input.affectedRolePackIds),
        eq(rolePackReleases.status, "verified"),
      ));
    }
    const [published] = await tx.select().from(enterpriseAssetCandidates)
      .where(eq(enterpriseAssetCandidates.candidateId, input.candidate.candidateId)).limit(1);
    if (!published || published.status !== "published"
      || published.targetAssetType !== input.targetAssetType
      || published.targetAssetId !== input.targetAssetId) {
      throw new Error("Asset publication state changed; retry review");
    }
    return published;
  });
}
