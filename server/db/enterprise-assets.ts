import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  enterpriseAssetCandidates,
  enterpriseAssetSourceItems,
  enterpriseAssetSourceRuns,
  enterpriseAssetSources,
  knowledgeDocuments,
  rolePackReleases,
  type EnterpriseAssetCandidate,
  type EnterpriseAssetSourceRun,
  type InsertEnterpriseAssetCandidate,
  type InsertEnterpriseAssetSourceRun,
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

export async function listEnterpriseAssetSourceRuns(sourceId: string, limit = 20) {
  return (await database()).select().from(enterpriseAssetSourceRuns)
    .where(eq(enterpriseAssetSourceRuns.sourceId, sourceId))
    .orderBy(desc(enterpriseAssetSourceRuns.startedAt))
    .limit(Math.max(1, Math.min(limit, 100)));
}

export async function getEnterpriseAssetSourceRun(runId: string) {
  const [row] = await (await database()).select().from(enterpriseAssetSourceRuns)
    .where(eq(enterpriseAssetSourceRuns.runId, runId)).limit(1);
  return row || null;
}

export async function listEnterpriseAssetSourceItems(sourceId: string) {
  return (await database()).select().from(enterpriseAssetSourceItems)
    .where(eq(enterpriseAssetSourceItems.sourceId, sourceId))
    .orderBy(desc(enterpriseAssetSourceItems.lastSeenAt));
}

export async function beginEnterpriseAssetSourceRun(input: InsertEnterpriseAssetSourceRun) {
  const db = await database();
  await db.insert(enterpriseAssetSourceRuns).values({ ...input, activeRunKey: input.sourceId });
  const [row] = await db.select().from(enterpriseAssetSourceRuns)
    .where(eq(enterpriseAssetSourceRuns.runId, input.runId)).limit(1);
  return row || null;
}

export async function failEnterpriseAssetSourceRun(input: {
  runId: string;
  error: Record<string, unknown>;
  failedCount?: number;
}) {
  const db = await database();
  await db.update(enterpriseAssetSourceRuns).set({
    status: "failed",
    activeRunKey: null,
    scanComplete: false,
    failedCount: input.failedCount || 1,
    errorJson: input.error,
    completedAt: new Date(),
  }).where(and(
    eq(enterpriseAssetSourceRuns.runId, input.runId),
    eq(enterpriseAssetSourceRuns.status, "running"),
  ));
}

export async function completeEnterpriseAssetSourceRun(input: {
  runId: string;
  sourceId: string;
  status: Extract<EnterpriseAssetSourceRun["status"], "succeeded" | "partial">;
  scanComplete: boolean;
  cursorAfter?: string | null;
  counts: {
    discovered: number;
    created: number;
    changed: number;
    unchanged: number;
    missing: number;
    failed: number;
  };
  items: Array<{
    action: "seen" | "missing";
    sourceItemId: string;
    externalItemId: string;
    enterpriseAssetId: string;
    relativePath: string;
    sourceUri?: string | null;
    etag?: string | null;
    sourceModifiedAt?: Date | null;
    contentHash: string;
    latestSourceVersion?: string | null;
    sizeBytes: number;
    latestCandidateId?: string | null;
  }>;
  actor: string;
}) {
  if (input.status === "partial" && input.scanComplete) {
    throw new Error("A partial source scan cannot be marked complete");
  }
  const db = await database();
  return db.transaction(async tx => {
    const completedAt = new Date();
    for (const item of input.items) {
      if (item.action === "missing") {
        await tx.update(enterpriseAssetSourceItems).set({
          state: "missing",
          missingSinceRunId: input.runId,
        }).where(and(
          eq(enterpriseAssetSourceItems.sourceId, input.sourceId),
          eq(enterpriseAssetSourceItems.sourceItemId, item.sourceItemId),
          eq(enterpriseAssetSourceItems.state, "active"),
        ));
        continue;
      }
      await tx.insert(enterpriseAssetSourceItems).values({
        sourceItemId: item.sourceItemId,
        sourceId: input.sourceId,
        externalItemId: item.externalItemId,
        enterpriseAssetId: item.enterpriseAssetId,
        relativePath: item.relativePath,
        sourceUri: item.sourceUri || null,
        etag: item.etag || null,
        sourceModifiedAt: item.sourceModifiedAt || null,
        contentHash: item.contentHash,
        latestSourceVersion: item.latestSourceVersion || null,
        sizeBytes: item.sizeBytes,
        state: "active",
        lastSeenRunId: input.runId,
        latestCandidateId: item.latestCandidateId || null,
        lastSeenAt: completedAt,
      }).onDuplicateKeyUpdate({ set: {
        enterpriseAssetId: item.enterpriseAssetId,
        relativePath: item.relativePath,
        sourceUri: item.sourceUri || null,
        etag: item.etag || null,
        sourceModifiedAt: item.sourceModifiedAt || null,
        contentHash: item.contentHash,
        ...(item.latestSourceVersion ? { latestSourceVersion: item.latestSourceVersion } : {}),
        sizeBytes: item.sizeBytes,
        state: "active",
        lastSeenRunId: input.runId,
        missingSinceRunId: null,
        ...(item.latestCandidateId ? { latestCandidateId: item.latestCandidateId } : {}),
        lastSeenAt: completedAt,
      } });
    }
    await tx.update(enterpriseAssetSourceRuns).set({
      status: input.status,
      activeRunKey: null,
      scanComplete: input.scanComplete,
      cursorAfter: input.cursorAfter || null,
      discoveredCount: input.counts.discovered,
      createdCount: input.counts.created,
      changedCount: input.counts.changed,
      unchangedCount: input.counts.unchanged,
      missingCount: input.counts.missing,
      failedCount: input.counts.failed,
      completedAt,
    }).where(and(
      eq(enterpriseAssetSourceRuns.runId, input.runId),
      eq(enterpriseAssetSourceRuns.status, "running"),
    ));
    if (input.status === "succeeded") {
      await tx.update(enterpriseAssetSources).set({
        lastSyncAt: completedAt,
        updatedBy: input.actor,
      }).where(eq(enterpriseAssetSources.sourceId, input.sourceId));
    }
    const [run] = await tx.select().from(enterpriseAssetSourceRuns)
      .where(eq(enterpriseAssetSourceRuns.runId, input.runId)).limit(1);
    if (!run || run.status !== input.status) throw new Error("Source sync run state changed; retry completion");
    return run;
  });
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

export async function listEnterpriseAssetCandidatesByChecksums(checksums: string[]) {
  if (!checksums.length) return [];
  return (await database()).select().from(enterpriseAssetCandidates)
    .where(inArray(enterpriseAssetCandidates.checksum, [...new Set(checksums)]));
}

export async function markEnterpriseAssetSourceSynced(sourceId: string, actor: string) {
  await (await database()).update(enterpriseAssetSources).set({
    lastSyncAt: new Date(),
    updatedBy: actor,
  }).where(eq(enterpriseAssetSources.sourceId, sourceId));
  return getEnterpriseAssetSource(sourceId);
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

export async function stageEnterpriseKnowledgeCandidate(input: {
  candidate: EnterpriseAssetCandidate;
  documentId: string;
  impactAnalysisJson: Record<string, unknown>;
  affectedRolePackIds: string[];
  actor: string;
}) {
  const db = await database();
  return db.transaction(async tx => {
    await tx.update(enterpriseAssetCandidates).set({
      targetAssetType: "knowledge_document",
      targetAssetId: input.documentId,
      impactAnalysisJson: input.impactAnalysisJson,
      updatedBy: input.actor,
    }).where(and(
      eq(enterpriseAssetCandidates.candidateId, input.candidate.candidateId),
      eq(enterpriseAssetCandidates.status, "approved"),
      isNull(enterpriseAssetCandidates.targetAssetId),
    ));
    if (input.affectedRolePackIds.length) {
      await tx.update(rolePackReleases).set({ status: "stale" }).where(and(
        inArray(rolePackReleases.rolePackId, input.affectedRolePackIds),
        eq(rolePackReleases.status, "verified"),
      ));
    }
    const [staged] = await tx.select().from(enterpriseAssetCandidates)
      .where(eq(enterpriseAssetCandidates.candidateId, input.candidate.candidateId)).limit(1);
    if (!staged || staged.status !== "approved" || staged.targetAssetId !== input.documentId) {
      throw new Error("Asset staging state changed; retry publication");
    }
    return staged;
  });
}

export async function activateEnterpriseKnowledgeCandidate(input: {
  candidate: EnterpriseAssetCandidate;
  documentId: string;
  actor: string;
}) {
  const db = await database();
  return db.transaction(async tx => {
    await tx.update(knowledgeDocuments).set({ lifecycle: "active" }).where(and(
      eq(knowledgeDocuments.publicId, input.documentId),
      eq(knowledgeDocuments.lifecycle, "draft"),
    ));
    await tx.update(enterpriseAssetCandidates).set({ status: "stale", updatedBy: input.actor }).where(and(
      eq(enterpriseAssetCandidates.enterpriseAssetId, input.candidate.enterpriseAssetId),
      eq(enterpriseAssetCandidates.status, "published"),
      ne(enterpriseAssetCandidates.candidateId, input.candidate.candidateId),
    ));
    await tx.update(enterpriseAssetCandidates).set({
      status: "published",
      publishedBy: input.actor,
      publishedAt: new Date(),
      updatedBy: input.actor,
    }).where(and(
      eq(enterpriseAssetCandidates.candidateId, input.candidate.candidateId),
      eq(enterpriseAssetCandidates.status, "approved"),
      eq(enterpriseAssetCandidates.targetAssetId, input.documentId),
    ));
    const [document] = await tx.select().from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.publicId, input.documentId)).limit(1);
    const [published] = await tx.select().from(enterpriseAssetCandidates)
      .where(eq(enterpriseAssetCandidates.candidateId, input.candidate.candidateId)).limit(1);
    if (!document || document.lifecycle !== "active" || !published || published.status !== "published") {
      throw new Error("Knowledge activation state changed; retry activation");
    }
    return published;
  });
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
