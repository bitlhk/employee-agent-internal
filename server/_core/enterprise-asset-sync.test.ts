import { describe, expect, it } from "vitest";
import { enterpriseAssetSourceItemId, planEnterpriseAssetSync, sourceVersionForContentChange, type AssetSyncExistingItem } from "./enterprise-asset-sync";

const existing: AssetSyncExistingItem = {
  sourceItemId: "easi_existing",
  externalItemId: "oa-123",
  enterpriseAssetId: "bank-policy.series-1",
  relativePath: "制度/销售办法V1.0.pdf",
  sourceUri: "oa://oa-123",
  etag: "v1",
  sourceModifiedAt: "2026-08-20T00:00:00.000Z",
  contentHash: "a".repeat(64),
  sizeBytes: 100,
  state: "active",
};

function plan(overrides: Partial<Parameters<typeof planEnterpriseAssetSync>[0]> = {}) {
  return planEnterpriseAssetSync({
    sourceId: "bank-oa",
    scanMode: "incremental",
    scanComplete: true,
    observed: [],
    existing: [existing],
    enterpriseAssetIdForNewItem: item => `asset.${item.externalItemId}`,
    ...overrides,
  });
}

describe("enterprise asset sync foundation", () => {
  it("keeps stable source identity across path changes", () => {
    expect(enterpriseAssetSourceItemId("bank-oa", "oa-123"))
      .toBe(enterpriseAssetSourceItemId("bank-oa", "oa-123"));
    const result = plan({
      observed: [{ ...existing, relativePath: "制度/已归档/销售办法V1.0.pdf" }],
    });
    expect(result.actions[0]).toMatchObject({ kind: "metadata_changed", enterpriseAssetId: existing.enterpriseAssetId, candidateRequired: false });
  });

  it("creates a version candidate only when content changes", () => {
    const result = plan({ observed: [{ ...existing, contentHash: "b".repeat(64), etag: "v2" }] });
    expect(result.actions[0]).toMatchObject({ kind: "content_changed", candidateRequired: true });
  });

  it("does not overwrite evidence when content changes without a source version bump", () => {
    expect(sourceVersionForContentChange({
      suggestedVersion: "1.0",
      previousVersion: "1.0",
      contentHash: "b".repeat(64),
    })).toEqual({ sourceVersion: "1.0+revision.bbbbbbbb", conflict: true });
  });

  it("never infers deletion from an incremental or incomplete scan", () => {
    expect(plan({ scanMode: "incremental", scanComplete: true }).counts.missing).toBe(0);
    expect(plan({ scanMode: "full", scanComplete: false }).counts.missing).toBe(0);
  });

  it("creates a missing tombstone only after a complete full scan", () => {
    const result = plan({ scanMode: "full", scanComplete: true });
    expect(result.deletionDetectionApplied).toBe(true);
    expect(result.actions[0]).toMatchObject({ kind: "missing", candidateRequired: false });
  });

  it("restores a missing item without creating a duplicate asset candidate", () => {
    const result = plan({
      existing: [{ ...existing, state: "missing" }],
      observed: [{ ...existing }],
    });
    expect(result.actions[0]).toMatchObject({ kind: "restored", candidateRequired: false });
  });
});
