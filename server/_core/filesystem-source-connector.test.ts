import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { scanFilesystemSource } from "./filesystem-source-connector";
import { planEnterpriseAssetSync, sourceVersionForContentChange, type AssetSyncExistingItem } from "./enterprise-asset-sync";

const roots: string[] = [];
const originalAllowedRoots = process.env.ENTERPRISE_FILESYSTEM_CONNECTOR_ROOTS;

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ea-filesystem-connector-"));
  roots.push(root);
  process.env.ENTERPRISE_FILESYSTEM_CONNECTOR_ROOTS = root;
  return root;
}

function existingFromScan(scan: Awaited<ReturnType<typeof scanFilesystemSource>>): AssetSyncExistingItem[] {
  return scan.artifacts.map((artifact, index) => ({
    sourceItemId: `item-${index}`,
    externalItemId: artifact.externalItemId,
    enterpriseAssetId: `asset-${index}`,
    relativePath: artifact.relativePath,
    sourceUri: artifact.sourceUri,
    etag: artifact.etag,
    sourceModifiedAt: artifact.sourceModifiedAt,
    contentHash: artifact.checksum,
    latestSourceVersion: "1.0",
    sizeBytes: artifact.sizeBytes,
    state: "active",
  }));
}

afterEach(async () => {
  process.env.ENTERPRISE_FILESYSTEM_CONNECTOR_ROOTS = originalAllowedRoots;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Filesystem/NAS Connector V1", () => {
  it("uses stable filesystem identity and does not materialize unchanged content", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, "wealth"));
    await writeFile(path.join(root, "wealth", "policy-v1.md"), "# Policy V1\ncurrent\n");

    const first = await scanFilesystemSource({ sourceUri: pathToFileURL(root).href });
    expect(first.artifacts).toHaveLength(1);
    expect(first.artifacts[0].content).toBeUndefined();
    expect(await first.artifacts[0].loadContent?.()).toEqual(Buffer.from("# Policy V1\ncurrent\n"));

    await rename(path.join(root, "wealth", "policy-v1.md"), path.join(root, "wealth", "current-policy-v1.md"));
    const second = await scanFilesystemSource({ sourceUri: pathToFileURL(root).href });
    expect(second.artifacts[0].externalItemId).toBe(first.artifacts[0].externalItemId);
    const plan = planEnterpriseAssetSync({
      sourceId: "filesystem-test",
      scanMode: "full",
      scanComplete: true,
      observed: second.artifacts.map(item => ({
        externalItemId: item.externalItemId,
        relativePath: item.relativePath,
        sourceUri: item.sourceUri,
        etag: item.etag,
        sourceModifiedAt: item.sourceModifiedAt,
        contentHash: item.checksum,
        sizeBytes: item.sizeBytes,
      })),
      existing: existingFromScan(first),
      enterpriseAssetIdForNewItem: () => "must-not-create",
    });
    expect(plan.actions).toMatchObject([{ kind: "metadata_changed", enterpriseAssetId: "asset-0", candidateRequired: false }]);
  });

  it("classifies additions, content changes, unchanged items and full-scan tombstones", async () => {
    const root = await temporaryRoot();
    for (let index = 0; index < 100; index += 1) {
      await writeFile(path.join(root, `asset-${index}.md`), `asset ${index}\n`);
    }
    const first = await scanFilesystemSource({ sourceUri: pathToFileURL(root).href });
    const existing = existingFromScan(first);

    for (let index = 0; index < 5; index += 1) await writeFile(path.join(root, `new-${index}.md`), `new ${index}\n`);
    for (let index = 0; index < 3; index += 1) await writeFile(path.join(root, `asset-${index}.md`), `changed ${index}\n`);
    await rm(path.join(root, "asset-98.md"));
    await rm(path.join(root, "asset-99.md"));

    const second = await scanFilesystemSource({ sourceUri: pathToFileURL(root).href });
    const plan = planEnterpriseAssetSync({
      sourceId: "filesystem-test",
      scanMode: "full",
      scanComplete: true,
      observed: second.artifacts.map(item => ({
        externalItemId: item.externalItemId,
        relativePath: item.relativePath,
        sourceUri: item.sourceUri,
        etag: item.etag,
        sourceModifiedAt: item.sourceModifiedAt,
        contentHash: item.checksum,
        sizeBytes: item.sizeBytes,
      })),
      existing,
      enterpriseAssetIdForNewItem: item => `new:${item.externalItemId}`,
    });

    expect(plan.counts).toEqual({ discovered: 103, created: 5, changed: 3, unchanged: 95, missing: 2 });
    expect(plan.actions.filter(item => item.candidateRequired)).toHaveLength(8);
    expect(plan.actions.filter(item => item.kind === "content_changed").every(item => item.enterpriseAssetId.startsWith("asset-"))).toBe(true);
    const changed = plan.actions.find(item => item.kind === "content_changed")!;
    expect(sourceVersionForContentChange({
      suggestedVersion: "1.0",
      previousVersion: changed.previous?.latestSourceVersion,
      contentHash: changed.observed!.contentHash,
    }).sourceVersion).toMatch(/^1\.0\+revision\.[a-f0-9]{8}$/);
  });

  it("never infers deletion from an incomplete or incremental scan", async () => {
    const existing: AssetSyncExistingItem[] = [{
      sourceItemId: "item-1",
      externalItemId: "fs:1:1",
      enterpriseAssetId: "asset-1",
      relativePath: "asset.md",
      contentHash: "a".repeat(64),
      sizeBytes: 1,
      state: "active",
    }];
    for (const input of [
      { scanMode: "full" as const, scanComplete: false },
      { scanMode: "incremental" as const, scanComplete: true },
    ]) {
      const plan = planEnterpriseAssetSync({
        sourceId: "filesystem-test",
        ...input,
        observed: [],
        existing,
        enterpriseAssetIdForNewItem: () => "unused",
      });
      expect(plan.deletionDetectionApplied).toBe(false);
      expect(plan.counts.missing).toBe(0);
    }
  });

  it("rejects sources outside the allowlist and skips symlinks", async () => {
    const root = await temporaryRoot();
    const outside = await mkdtemp(path.join(os.tmpdir(), "ea-filesystem-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "outside.md"), "outside\n");
    await symlink(path.join(outside, "outside.md"), path.join(root, "linked.md"));

    const scan = await scanFilesystemSource({ sourceUri: pathToFileURL(root).href });
    expect(scan.artifacts).toHaveLength(0);
    expect(scan.skippedSymlinks).toBe(1);
    await expect(scanFilesystemSource({ sourceUri: pathToFileURL(outside).href })).rejects.toThrow(/白名单/);
  });

  it("emits a deterministic continuation cursor and enforces scan limits", async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, "a.md"), "a\n");
    const first = await scanFilesystemSource({ sourceUri: pathToFileURL(root).href });
    const second = await scanFilesystemSource({ sourceUri: pathToFileURL(root).href });
    expect(first.cursorAfter).toBe(second.cursorAfter);
    expect(first.cursorAfter).toMatch(/^fs-v1:[a-f0-9]{64}$/);
    await writeFile(path.join(root, "b.md"), "b\n");
    await expect(scanFilesystemSource({ sourceUri: pathToFileURL(root).href, limits: { maxFiles: 1 } })).rejects.toThrow(/文件数超过/);
  });
});
