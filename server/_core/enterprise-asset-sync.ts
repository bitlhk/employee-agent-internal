import { createHash, randomUUID } from "node:crypto";

export type AssetSyncScanMode = "full" | "incremental";

export type AssetSyncObservedItem = {
  externalItemId: string;
  relativePath: string;
  sourceUri?: string | null;
  etag?: string | null;
  sourceModifiedAt?: string | null;
  contentHash: string;
  sizeBytes: number;
};

export type AssetSyncExistingItem = AssetSyncObservedItem & {
  sourceItemId: string;
  enterpriseAssetId: string;
  latestSourceVersion?: string | null;
  latestCandidateId?: string | null;
  lastSeenRunId?: string | null;
  state: "active" | "missing" | "retired";
};

export type AssetSyncAction = {
  kind: "created" | "content_changed" | "metadata_changed" | "restored" | "unchanged" | "missing";
  sourceItemId: string;
  enterpriseAssetId: string;
  observed?: AssetSyncObservedItem;
  previous?: AssetSyncExistingItem;
  candidateRequired: boolean;
};

export type AssetSyncPlan = {
  actions: AssetSyncAction[];
  counts: {
    discovered: number;
    created: number;
    changed: number;
    unchanged: number;
    missing: number;
  };
  deletionDetectionApplied: boolean;
};

export function newEnterpriseAssetSourceRunId(): string {
  return `easr_${randomUUID().replace(/-/g, "")}`;
}

export function enterpriseAssetSourceItemId(sourceId: string, externalItemId: string): string {
  const digest = createHash("sha256").update(`${sourceId}\0${externalItemId}`).digest("hex").slice(0, 32);
  return `easi_${digest}`;
}

export function sourceVersionForContentChange(input: {
  suggestedVersion: string;
  previousVersion?: string | null;
  contentHash: string;
}): { sourceVersion: string; conflict: boolean } {
  if (!input.previousVersion || input.previousVersion !== input.suggestedVersion) {
    return { sourceVersion: input.suggestedVersion, conflict: false };
  }
  return {
    sourceVersion: `${input.suggestedVersion.slice(0, 46)}+revision.${input.contentHash.slice(0, 8)}`,
    conflict: true,
  };
}

function metadataChanged(existing: AssetSyncExistingItem, observed: AssetSyncObservedItem): boolean {
  return existing.relativePath !== observed.relativePath
    || (existing.sourceUri || null) !== (observed.sourceUri || null)
    || (existing.etag || null) !== (observed.etag || null)
    || (existing.sourceModifiedAt || null) !== (observed.sourceModifiedAt || null)
    || existing.sizeBytes !== observed.sizeBytes;
}

export function planEnterpriseAssetSync(input: {
  sourceId: string;
  scanMode: AssetSyncScanMode;
  scanComplete: boolean;
  observed: AssetSyncObservedItem[];
  existing: AssetSyncExistingItem[];
  enterpriseAssetIdForNewItem(item: AssetSyncObservedItem): string;
}): AssetSyncPlan {
  const observedIds = new Set<string>();
  const existingByExternalId = new Map(input.existing.map(item => [item.externalItemId, item]));
  const actions: AssetSyncAction[] = [];

  for (const item of input.observed) {
    if (!item.externalItemId.trim()) throw new Error("Source item external identity is required");
    if (observedIds.has(item.externalItemId)) throw new Error(`Duplicate source item identity: ${item.externalItemId}`);
    observedIds.add(item.externalItemId);
    const existing = existingByExternalId.get(item.externalItemId);
    if (!existing) {
      actions.push({
        kind: "created",
        sourceItemId: enterpriseAssetSourceItemId(input.sourceId, item.externalItemId),
        enterpriseAssetId: input.enterpriseAssetIdForNewItem(item),
        observed: item,
        candidateRequired: true,
      });
      continue;
    }
    if (existing.contentHash !== item.contentHash) {
      actions.push({
        kind: "content_changed",
        sourceItemId: existing.sourceItemId,
        enterpriseAssetId: existing.enterpriseAssetId,
        observed: item,
        previous: existing,
        candidateRequired: true,
      });
      continue;
    }
    if (existing.state === "missing") {
      actions.push({
        kind: "restored",
        sourceItemId: existing.sourceItemId,
        enterpriseAssetId: existing.enterpriseAssetId,
        observed: item,
        previous: existing,
        candidateRequired: false,
      });
      continue;
    }
    const kind = metadataChanged(existing, item) ? "metadata_changed" : "unchanged";
    actions.push({
      kind,
      sourceItemId: existing.sourceItemId,
      enterpriseAssetId: existing.enterpriseAssetId,
      observed: item,
      previous: existing,
      candidateRequired: false,
    });
  }

  const deletionDetectionApplied = input.scanMode === "full" && input.scanComplete;
  if (deletionDetectionApplied) {
    for (const existing of input.existing) {
      if (existing.state !== "active" || observedIds.has(existing.externalItemId)) continue;
      actions.push({
        kind: "missing",
        sourceItemId: existing.sourceItemId,
        enterpriseAssetId: existing.enterpriseAssetId,
        previous: existing,
        candidateRequired: false,
      });
    }
  }

  return {
    actions,
    counts: {
      discovered: input.observed.length,
      created: actions.filter(item => item.kind === "created").length,
      changed: actions.filter(item => ["content_changed", "metadata_changed", "restored"].includes(item.kind)).length,
      unchanged: actions.filter(item => item.kind === "unchanged").length,
      missing: actions.filter(item => item.kind === "missing").length,
    },
    deletionDetectionApplied,
  };
}
