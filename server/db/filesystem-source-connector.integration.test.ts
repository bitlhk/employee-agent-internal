import { eq } from "drizzle-orm";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  enterpriseAssetCandidates,
  enterpriseAssetSourceItems,
  enterpriseAssetSourceRuns,
  enterpriseAssetSources,
} from "../../drizzle/schema";
import { ingestEnterpriseAssetSource } from "../_core/enterprise-asset-ingestion";
import { scanFilesystemSource } from "../_core/filesystem-source-connector";
import { getEnterpriseAssetSource, listEnterpriseAssetCandidates, listEnterpriseAssetSourceItems, upsertEnterpriseAssetSource } from "./enterprise-assets";
import { getDb } from "./connection";

const run = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const suffix = `${Date.now()}_${process.pid}`;
const sourceId = `filesystem_it_${suffix}`;
let sourceRoot = "";
let stagingRoot = "";
const originalAllowedRoots = process.env.ENTERPRISE_FILESYSTEM_CONNECTOR_ROOTS;
const originalStagingRoot = process.env.ENTERPRISE_ASSET_STAGING_ROOT;

run("filesystem source connector persistence", () => {
  beforeAll(async () => {
    sourceRoot = await mkdtemp(path.join(os.tmpdir(), "ea-filesystem-source-"));
    stagingRoot = await mkdtemp(path.join(os.tmpdir(), "ea-filesystem-staging-"));
    process.env.ENTERPRISE_FILESYSTEM_CONNECTOR_ROOTS = sourceRoot;
    process.env.ENTERPRISE_ASSET_STAGING_ROOT = stagingRoot;
    await Promise.all([
      writeFile(path.join(sourceRoot, "policy-V1.0.md"), "# Policy V1.0\nactive\n"),
      writeFile(path.join(sourceRoot, "guide-V1.0.md"), "# Guide V1.0\nactive\n"),
      writeFile(path.join(sourceRoot, "retire-V1.0.md"), "# Retire V1.0\nactive\n"),
    ]);
    await upsertEnterpriseAssetSource({
      sourceId,
      displayName: "Filesystem integration source",
      sourceType: "document_repository",
      sourceUri: pathToFileURL(sourceRoot).href,
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
    process.env.ENTERPRISE_FILESYSTEM_CONNECTOR_ROOTS = originalAllowedRoots;
    process.env.ENTERPRISE_ASSET_STAGING_ROOT = originalStagingRoot;
    await Promise.all([rm(sourceRoot, { recursive: true, force: true }), rm(stagingRoot, { recursive: true, force: true })]);
  });

  async function synchronize(resumeOfRunId?: string) {
    const source = await getEnterpriseAssetSource(sourceId);
    if (!source) throw new Error("test source missing");
    return ingestEnterpriseAssetSource({
      source,
      actor: "integration-test",
      mode: "filesystem_connector",
      scanMode: "full",
      resumeOfRunId,
      useModelSuggestion: false,
      allowContentProcessing: false,
      discover: async () => {
        const scan = await scanFilesystemSource({ sourceUri: source.sourceUri! });
        return { artifacts: scan.artifacts, scanComplete: true, cursorAfter: scan.cursorAfter };
      },
    });
  }

  it("creates, skips, revises, preserves rename identity, and stages a tombstone candidate", async () => {
    const first = await synchronize();
    expect(first).toMatchObject({ discovered: 3, unchanged: 0, missing: 0 });
    expect(first.candidates).toHaveLength(3);
    expect(first.candidates.every(candidate => candidate.status === "draft" && candidate.sourceUri?.startsWith("candidate://"))).toBe(true);
    const initialItems = await listEnterpriseAssetSourceItems(sourceId);
    const policyInitial = initialItems.find(item => item.relativePath === "policy-V1.0.md")!;
    const guideInitial = initialItems.find(item => item.relativePath === "guide-V1.0.md")!;

    const unchanged = await synchronize();
    expect(unchanged).toMatchObject({ discovered: 3, unchanged: 3, missing: 0 });
    expect(unchanged.candidates).toHaveLength(0);

    await writeFile(path.join(sourceRoot, "policy-V1.0.md"), "# Policy V1.0\nchanged without version bump\n");
    await rename(path.join(sourceRoot, "guide-V1.0.md"), path.join(sourceRoot, "renamed-guide-V1.0.md"));
    await rm(path.join(sourceRoot, "retire-V1.0.md"));
    await writeFile(path.join(sourceRoot, "new-V1.0.md"), "# New V1.0\nactive\n");

    const changed = await synchronize();
    expect(changed).toMatchObject({ discovered: 3, unchanged: 0, missing: 1, deletionDetectionApplied: true });
    expect(changed.candidates).toHaveLength(3);
    const currentItems = await listEnterpriseAssetSourceItems(sourceId);
    const policyCurrent = currentItems.find(item => item.sourceItemId === policyInitial.sourceItemId)!;
    const guideCurrent = currentItems.find(item => item.sourceItemId === guideInitial.sourceItemId)!;
    expect(policyCurrent.enterpriseAssetId).toBe(policyInitial.enterpriseAssetId);
    expect(policyCurrent.latestSourceVersion).toMatch(/^1\.0\+revision\.[a-f0-9]{8}$/);
    expect(guideCurrent).toMatchObject({ enterpriseAssetId: guideInitial.enterpriseAssetId, relativePath: "renamed-guide-V1.0.md", state: "active" });

    const candidates = await listEnterpriseAssetCandidates({ sourceId });
    const tombstone = candidates.find(candidate => (
      Array.isArray(candidate.diagnosticsJson)
      && candidate.diagnosticsJson.some(item => item.code === "SOURCE_ITEM_DELETED")
    ));
    expect(tombstone).toMatchObject({ status: "draft", sourceItemId: expect.any(String) });
    expect(tombstone?.sourceVersion).toMatch(/\+tombstone\.[a-f0-9]{8}$/);
  });
});
