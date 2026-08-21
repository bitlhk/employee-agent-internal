import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  enterpriseAssetSourceItems,
  enterpriseAssetSourceRuns,
  enterpriseAssetSources,
} from "../../drizzle/schema";
import {
  beginEnterpriseAssetSourceRun,
  completeEnterpriseAssetSourceRun,
  listEnterpriseAssetSourceItems,
  listEnterpriseAssetSourceRuns,
  upsertEnterpriseAssetSource,
} from "./enterprise-assets";
import { getDb } from "./connection";

const run = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const suffix = `${Date.now()}_${process.pid}`;
const sourceId = `sync_it_${suffix}`;

run("enterprise asset sync persistence", () => {
  beforeAll(async () => {
    await upsertEnterpriseAssetSource({
      sourceId,
      displayName: "Sync integration source",
      sourceType: "document_repository",
      ownerDepartment: "Test",
      syncMode: "manual",
      status: "active",
      createdBy: "integration-test",
      updatedBy: "integration-test",
    });
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    await db.delete(enterpriseAssetSourceItems).where(eq(enterpriseAssetSourceItems.sourceId, sourceId));
    await db.delete(enterpriseAssetSourceRuns).where(eq(enterpriseAssetSourceRuns.sourceId, sourceId));
    await db.delete(enterpriseAssetSources).where(eq(enterpriseAssetSources.sourceId, sourceId));
  });

  it("persists a completed run, stable item, and safe missing tombstone", async () => {
    await beginEnterpriseAssetSourceRun({
      runId: `easr_${"1".repeat(32)}`,
      sourceId,
      activeRunKey: sourceId,
      scanMode: "incremental",
      status: "running",
      scanComplete: false,
      createdBy: "integration-test",
    });
    await expect(beginEnterpriseAssetSourceRun({
      runId: `easr_${"4".repeat(32)}`,
      sourceId,
      scanMode: "incremental",
      status: "running",
      scanComplete: false,
      createdBy: "integration-test",
    })).rejects.toThrow();
    await completeEnterpriseAssetSourceRun({
      runId: `easr_${"1".repeat(32)}`,
      sourceId,
      status: "succeeded",
      scanComplete: true,
      counts: { discovered: 1, created: 1, changed: 0, unchanged: 0, missing: 0, failed: 0 },
      items: [{
        action: "seen",
        sourceItemId: `easi_${"2".repeat(32)}`,
        externalItemId: "oa-item-1",
        enterpriseAssetId: `${sourceId}.asset-1`,
        relativePath: "制度/销售办法V1.0.pdf",
        contentHash: "a".repeat(64),
        latestSourceVersion: "1.0",
        sizeBytes: 100,
      }],
      actor: "integration-test",
    });
    await beginEnterpriseAssetSourceRun({
      runId: `easr_${"3".repeat(32)}`,
      sourceId,
      activeRunKey: sourceId,
      scanMode: "full",
      status: "running",
      scanComplete: false,
      createdBy: "integration-test",
    });
    await completeEnterpriseAssetSourceRun({
      runId: `easr_${"3".repeat(32)}`,
      sourceId,
      status: "succeeded",
      scanComplete: true,
      counts: { discovered: 0, created: 0, changed: 0, unchanged: 0, missing: 1, failed: 0 },
      items: [{
        action: "missing",
        sourceItemId: `easi_${"2".repeat(32)}`,
        externalItemId: "oa-item-1",
        enterpriseAssetId: `${sourceId}.asset-1`,
        relativePath: "制度/销售办法V1.0.pdf",
        contentHash: "a".repeat(64),
        latestSourceVersion: "1.0",
        sizeBytes: 100,
      }],
      actor: "integration-test",
    });

    const [items, runs] = await Promise.all([
      listEnterpriseAssetSourceItems(sourceId),
      listEnterpriseAssetSourceRuns(sourceId),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ state: "missing", missingSinceRunId: `easr_${"3".repeat(32)}` });
    expect(runs.map(item => item.status)).toEqual(["succeeded", "succeeded"]);
  });
});
