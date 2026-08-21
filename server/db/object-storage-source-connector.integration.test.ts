import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  enterpriseAssetCandidates,
  enterpriseAssetSourceItems,
  enterpriseAssetSourceRuns,
  enterpriseAssetSources,
} from "../../drizzle/schema";
import { ingestEnterpriseAssetSource } from "../_core/enterprise-asset-ingestion";
import { scanObjectStorageSource, type ObjectStorageClient } from "../_core/object-storage-source-connector";
import {
  getEnterpriseAssetSource,
  listEnterpriseAssetCandidates,
  listEnterpriseAssetSourceItems,
  listEnterpriseAssetSourceRuns,
  upsertEnterpriseAssetSource,
} from "./enterprise-assets";
import { getDb } from "./connection";

const run = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const suffix = `${Date.now()}_${process.pid}`;
const sourceId = `object_it_${suffix}`;
const endpoint = "http://127.0.0.1:5902";
const sourceUri = `obs://demo-bank/wealth/?${new URLSearchParams({
  endpoint,
  region: "cn-east-3",
  credentialRef: "env://TEST_OBS",
  forcePathStyle: "true",
})}`;
const originalEndpoints = process.env.ENTERPRISE_OBJECT_STORAGE_ENDPOINTS;
const originalStagingRoot = process.env.ENTERPRISE_ASSET_STAGING_ROOT;
let stagingRoot = "";

type StoredObject = { content: string; etag: string; lastModified: Date };
const objects = new Map<string, StoredObject>();
let failDownload = false;
let downloadCount = 0;

function objectClient(): ObjectStorageClient {
  return {
    async listPage(input) {
      const keys = [...objects.keys()].sort();
      const start = input.continuationToken ? Number(input.continuationToken) : 0;
      const pageKeys = keys.slice(start, start + 2);
      const next = start + pageKeys.length;
      return {
        items: pageKeys.map(key => {
          const item = objects.get(key)!;
          return {
            key,
            etag: item.etag,
            lastModified: item.lastModified,
            sizeBytes: Buffer.byteLength(item.content),
          };
        }),
        truncated: next < keys.length,
        nextContinuationToken: next < keys.length ? String(next) : undefined,
      };
    },
    async getObject(input) {
      if (failDownload) throw new Error("simulated object download failure");
      downloadCount += 1;
      const item = objects.get(input.key);
      if (!item) throw new Error("object missing");
      return { content: Buffer.from(item.content), etag: item.etag, lastModified: item.lastModified };
    },
  };
}

run("object storage source connector persistence", () => {
  beforeAll(async () => {
    stagingRoot = await mkdtemp(path.join(os.tmpdir(), "ea-object-storage-staging-"));
    process.env.ENTERPRISE_ASSET_STAGING_ROOT = stagingRoot;
    process.env.ENTERPRISE_OBJECT_STORAGE_ENDPOINTS = endpoint;
    objects.set("wealth/policy-V1.0.md", { content: "# Policy V1.0\nactive\n", etag: "remote-policy-1", lastModified: new Date("2026-08-21T01:00:00Z") });
    objects.set("wealth/guide-V1.0.md", { content: "# Guide V1.0\nactive\n", etag: "remote-guide-1", lastModified: new Date("2026-08-21T01:00:00Z") });
    objects.set("wealth/retire-V1.0.md", { content: "# Retire V1.0\nactive\n", etag: "remote-retire-1", lastModified: new Date("2026-08-21T01:00:00Z") });
    await upsertEnterpriseAssetSource({
      sourceId,
      displayName: "Object storage integration source",
      sourceType: "document_repository",
      sourceUri,
      ownerDepartment: "Test",
      syncMode: "manual",
      status: "active",
      createdBy: "integration-test",
      updatedBy: "integration-test",
    });
  });

  afterAll(async () => {
    const db = await getDb();
    if (db) {
      await db.delete(enterpriseAssetCandidates).where(eq(enterpriseAssetCandidates.sourceId, sourceId));
      await db.delete(enterpriseAssetSourceItems).where(eq(enterpriseAssetSourceItems.sourceId, sourceId));
      await db.delete(enterpriseAssetSourceRuns).where(eq(enterpriseAssetSourceRuns.sourceId, sourceId));
      await db.delete(enterpriseAssetSources).where(eq(enterpriseAssetSources.sourceId, sourceId));
    }
    process.env.ENTERPRISE_OBJECT_STORAGE_ENDPOINTS = originalEndpoints;
    process.env.ENTERPRISE_ASSET_STAGING_ROOT = originalStagingRoot;
    await rm(stagingRoot, { recursive: true, force: true });
  });

  async function synchronize(resumeOfRunId?: string) {
    const source = await getEnterpriseAssetSource(sourceId);
    if (!source) throw new Error("test source missing");
    const existingItems = await listEnterpriseAssetSourceItems(sourceId);
    return ingestEnterpriseAssetSource({
      source,
      actor: "integration-test",
      mode: "object_storage_connector",
      scanMode: "full",
      resumeOfRunId,
      useModelSuggestion: false,
      allowContentProcessing: false,
      discover: async () => {
        const scan = await scanObjectStorageSource({ sourceUri, existingItems, client: objectClient() });
        return { artifacts: scan.artifacts, scanComplete: scan.scanComplete, cursorAfter: scan.cursorAfter };
      },
    });
  }

  it("creates, skips, revises, recovers a failed run, and stages a full-listing tombstone", async () => {
    const first = await synchronize();
    expect(first).toMatchObject({ discovered: 3, created: 3, changed: 0, unchanged: 0, tombstones: 0 });
    expect(downloadCount).toBe(3);
    const initialItems = await listEnterpriseAssetSourceItems(sourceId);
    const policyInitial = initialItems.find(item => item.relativePath === "policy-V1.0.md")!;

    const unchanged = await synchronize();
    expect(unchanged).toMatchObject({ discovered: 3, created: 0, changed: 0, unchanged: 3, tombstones: 0 });
    expect(downloadCount).toBe(3);

    objects.set("wealth/policy-V1.0.md", { content: "# Policy V1.0\nchanged without version bump\n", etag: "remote-policy-2", lastModified: new Date("2026-08-21T02:00:00Z") });
    objects.set("wealth/new-V1.0.md", { content: "# New V1.0\nactive\n", etag: "remote-new-1", lastModified: new Date("2026-08-21T02:00:00Z") });
    const changed = await synchronize();
    expect(changed).toMatchObject({ discovered: 4, created: 1, changed: 1, unchanged: 2, tombstones: 0 });
    const policyCurrent = (await listEnterpriseAssetSourceItems(sourceId)).find(item => item.sourceItemId === policyInitial.sourceItemId)!;
    expect(policyCurrent.enterpriseAssetId).toBe(policyInitial.enterpriseAssetId);
    expect(policyCurrent.latestSourceVersion).toMatch(/^1\.0\+revision\.[a-f0-9]{8}$/);

    objects.set("wealth/retry-V1.0.md", { content: "# Retry V1.0\nactive\n", etag: "remote-retry-1", lastModified: new Date("2026-08-21T03:00:00Z") });
    failDownload = true;
    await expect(synchronize()).rejects.toThrow(/simulated object download failure/);
    const [failedRun] = await listEnterpriseAssetSourceRuns(sourceId, 1);
    expect(failedRun).toMatchObject({ status: "failed", scanComplete: false });
    expect((await listEnterpriseAssetSourceItems(sourceId)).every(item => item.state === "active")).toBe(true);
    expect((await listEnterpriseAssetCandidates({ sourceId })).some(candidate => (
      candidate.syncRunId === failedRun.runId
      && Array.isArray(candidate.diagnosticsJson)
      && candidate.diagnosticsJson.some(item => item.code === "SOURCE_ITEM_DELETED")
    ))).toBe(false);
    failDownload = false;
    const recovered = await synchronize(failedRun.runId);
    expect(recovered.created).toBe(1);
    const [recoveredRun] = await listEnterpriseAssetSourceRuns(sourceId, 1);
    expect(recoveredRun).toMatchObject({ status: "succeeded", resumeOfRunId: failedRun.runId, attempt: 2 });

    objects.delete("wealth/retire-V1.0.md");
    const deleted = await synchronize();
    expect(deleted).toMatchObject({ deletionDetectionApplied: true, tombstones: 1, missing: 1 });
    const candidates = await listEnterpriseAssetCandidates({ sourceId });
    expect(candidates.some(candidate => (
      Array.isArray(candidate.diagnosticsJson)
      && candidate.diagnosticsJson.some(item => item.code === "SOURCE_ITEM_DELETED")
    ))).toBe(true);
  });
});
