import { createHash } from "node:crypto";
import path from "node:path";
import { type EnterpriseAssetSource } from "../../drizzle/schema";
import {
  applyEnterpriseAssetModelSuggestion,
  enterpriseAssetIdForPath,
  persistCandidateArtifact,
  readCandidateArtifact,
  removeCandidateArtifactFiles,
  suggestEnterpriseAssetMetadata,
  suggestEnterpriseAssetMetadataWithModel,
  type DiscoveredEnterpriseArtifact,
  type EnterpriseAssetDiagnostic,
  type EnterpriseAssetModelSuggestion,
} from "./enterprise-asset-discovery";
import { newEnterpriseAssetCandidateId } from "./enterprise-asset-onboarding";
import { newEnterpriseAssetSourceRunId, planEnterpriseAssetSync, sourceVersionForContentChange, type AssetSyncScanMode } from "./enterprise-asset-sync";
import { listAgentRoleTemplates } from "./role-templates";
import {
  beginEnterpriseAssetSourceRun,
  completeEnterpriseAssetSourceRun,
  failEnterpriseAssetSourceRun,
  getEnterpriseAssetCandidate,
  getEnterpriseAssetSourceRun,
  importEnterpriseAssetCandidates,
  listEnterpriseAssetCandidatesByChecksums,
  listEnterpriseAssetSourceItems,
} from "../db";

const TEXT_EXCERPT_EXTENSIONS = new Set(["md", "txt", "csv", "json", "yaml", "yml"]);

export type EnterpriseAssetDiscoveryBatch = {
  artifacts: DiscoveredEnterpriseArtifact[];
  scanComplete: boolean;
  cursorAfter?: string | null;
  metadata?: Record<string, unknown>;
};

export type EnterpriseAssetIngestionResult = {
  runId: string;
  discovered: number;
  candidates: Awaited<ReturnType<typeof importEnterpriseAssetCandidates>>;
  created: number;
  changed: number;
  tombstones: number;
  unchanged: number;
  missing: number;
  deletionDetectionApplied: boolean;
  remediationCount: number;
  modelSuggestionApplied: boolean;
  cursorAfter: string | null;
};

type AuditEvent = (phase: "requested" | "completed", metadata: Record<string, unknown>) => Promise<void>;

function candidateUri(candidateId: string, filename: string): string {
  return `candidate://${candidateId}/${encodeURIComponent(filename)}`;
}

async function modelSuggestions(input: {
  enabled: boolean;
  allowContentProcessing: boolean;
  artifacts: DiscoveredEnterpriseArtifact[];
  roles: Array<{ id: string; name: string }>;
}): Promise<{ suggestions: Map<string, EnterpriseAssetModelSuggestion>; failed: boolean }> {
  const suggestions = new Map<string, EnterpriseAssetModelSuggestion>();
  if (!input.enabled) return { suggestions, failed: false };
  try {
    for (let offset = 0; offset < input.artifacts.length; offset += 20) {
      const chunk = await Promise.all(input.artifacts.slice(offset, offset + 20).map(async artifact => {
        const excerpt = input.allowContentProcessing && TEXT_EXCERPT_EXTENSIONS.has(artifact.extension)
          ? artifact.content?.toString("utf8").slice(0, 2400) || await artifact.loadTextExcerpt?.(2400)
          : undefined;
        return { relativePath: artifact.relativePath, ...(excerpt ? { excerpt } : {}) };
      }));
      const result = await suggestEnterpriseAssetMetadataWithModel({ artifacts: chunk, roles: input.roles });
      for (const [key, value] of result) suggestions.set(key, value);
    }
    return { suggestions, failed: false };
  } catch {
    return { suggestions, failed: true };
  }
}

export async function ingestEnterpriseAssetSource(input: {
  source: EnterpriseAssetSource;
  actor: string;
  mode: string;
  scanMode: AssetSyncScanMode;
  cursorBefore?: string | null;
  resumeOfRunId?: string | null;
  useModelSuggestion: boolean;
  allowContentProcessing: boolean;
  discover(): Promise<EnterpriseAssetDiscoveryBatch>;
  audit?: AuditEvent;
}): Promise<EnterpriseAssetIngestionResult> {
  const runId = newEnterpriseAssetSourceRunId();
  const resumeRun = input.resumeOfRunId ? await getEnterpriseAssetSourceRun(input.resumeOfRunId) : null;
  if (input.resumeOfRunId && (!resumeRun || resumeRun.sourceId !== input.source.sourceId || !["failed", "partial"].includes(resumeRun.status))) {
    throw new Error("仅可恢复当前来源失败或部分完成的同步批次");
  }
  await beginEnterpriseAssetSourceRun({
    runId,
    sourceId: input.source.sourceId,
    activeRunKey: input.source.sourceId,
    scanMode: input.scanMode,
    status: "running",
    scanComplete: false,
    cursorBefore: input.cursorBefore || resumeRun?.cursorAfter || null,
    resumeOfRunId: input.resumeOfRunId || null,
    attempt: resumeRun ? resumeRun.attempt + 1 : 1,
    createdBy: input.actor,
  });

  let stagedCandidateIds: string[] = [];
  let candidatesImported = false;
  try {
    const batch = await input.discover();
    const artifacts = batch.artifacts;
    const totalBytes = artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
    await input.audit?.("requested", {
      runId,
      mode: input.mode,
      scanMode: input.scanMode,
      scanComplete: batch.scanComplete,
      artifactCount: artifacts.length,
      totalBytes,
      modelSuggestion: input.useModelSuggestion,
      contentProcessingAllowed: input.allowContentProcessing,
      ...batch.metadata,
    });

    const existingItems = await listEnterpriseAssetSourceItems(input.source.sourceId);
    const syncPlan = planEnterpriseAssetSync({
      sourceId: input.source.sourceId,
      scanMode: input.scanMode,
      scanComplete: batch.scanComplete,
      observed: artifacts.map(artifact => ({
        externalItemId: artifact.externalItemId,
        relativePath: artifact.relativePath,
        sourceUri: artifact.sourceUri || null,
        etag: artifact.etag || null,
        sourceModifiedAt: artifact.sourceModifiedAt || null,
        contentHash: artifact.checksum,
        sizeBytes: artifact.sizeBytes,
      })),
      existing: existingItems.map(item => ({
        sourceItemId: item.sourceItemId,
        externalItemId: item.externalItemId,
        enterpriseAssetId: item.enterpriseAssetId,
        relativePath: item.relativePath,
        sourceUri: item.sourceUri,
        etag: item.etag,
        sourceModifiedAt: item.sourceModifiedAt?.toISOString() || null,
        contentHash: item.contentHash,
        latestSourceVersion: item.latestSourceVersion,
        latestCandidateId: item.latestCandidateId,
        lastSeenRunId: item.lastSeenRunId,
        sizeBytes: item.sizeBytes,
        state: item.state,
      })),
      enterpriseAssetIdForNewItem: item => enterpriseAssetIdForPath(input.source.sourceId, item.relativePath),
    });
    const artifactByExternalId = new Map(artifacts.map(artifact => [artifact.externalItemId, artifact]));
    const candidateActions = syncPlan.actions.filter(action => action.candidateRequired && action.observed);
    const candidateInputArtifacts = candidateActions.flatMap(action => {
      const artifact = action.observed ? artifactByExternalId.get(action.observed.externalItemId) : null;
      return artifact ? [artifact] : [];
    });
    const candidateArtifactByExternalId = new Map(candidateInputArtifacts.map(artifact => [artifact.externalItemId, artifact]));
    const roles = listAgentRoleTemplates()
      .filter(role => role.status !== "disabled")
      .map(role => ({ id: role.id, name: role.name }));
    const model = await modelSuggestions({
      enabled: input.useModelSuggestion,
      allowContentProcessing: input.allowContentProcessing,
      artifacts: candidateInputArtifacts,
      roles,
    });
    const existingByChecksum = new Map(
      (await listEnterpriseAssetCandidatesByChecksums(candidateInputArtifacts.map(artifact => artifact.checksum)))
        .map(candidate => [candidate.checksum, candidate] as const),
    );
    const firstPathByChecksum = new Map<string, string>();
    const candidateArtifacts = new Map<string, DiscoveredEnterpriseArtifact>();
    const candidates = candidateActions.map(action => {
      const artifact = candidateArtifactByExternalId.get(action.observed!.externalItemId)!;
      const deterministic = suggestEnterpriseAssetMetadata({
        artifact,
        sourceId: input.source.sourceId,
        ownerDepartment: input.source.ownerDepartment,
        roles,
        externalProcessingAllowed: input.allowContentProcessing,
      });
      const suggested = applyEnterpriseAssetModelSuggestion({
        ...deterministic,
        suggestion: model.suggestions.get(artifact.relativePath),
      });
      const diagnostics: EnterpriseAssetDiagnostic[] = [...suggested.diagnostics];
      const versionResolution = sourceVersionForContentChange({
        suggestedVersion: suggested.sourceVersion,
        previousVersion: action.kind === "content_changed" ? action.previous?.latestSourceVersion : null,
        contentHash: artifact.checksum,
      });
      if (versionResolution.conflict) diagnostics.push({
        code: "VERSION_CONTENT_CONFLICT",
        severity: "warning",
        field: "sourceVersion",
        message: "来源内容已变化但版本号未更新，已生成不可覆盖的修订候选，请确认正式版本",
      });
      const existing = existingByChecksum.get(artifact.checksum);
      const firstPath = firstPathByChecksum.get(artifact.checksum);
      if (existing || firstPath) diagnostics.push({
        code: "DUPLICATE_CONTENT",
        severity: "warning",
        message: existing
          ? `内容与已有候选 ${existing.enterpriseAssetId} v${existing.sourceVersion} 相同`
          : `内容与本批次 ${firstPath} 相同`,
      });
      else firstPathByChecksum.set(artifact.checksum, artifact.relativePath);
      if (model.failed) diagnostics.push({
        code: "MODEL_SUGGESTION_FAILED",
        severity: "warning",
        message: "模型元数据建议暂不可用，已保留确定性建议",
      });
      const candidateId = newEnterpriseAssetCandidateId();
      candidateArtifacts.set(candidateId, artifact);
      return {
        candidateId,
        sourceId: input.source.sourceId,
        syncRunId: runId,
        sourceItemId: action.sourceItemId,
        enterpriseAssetId: action.enterpriseAssetId,
        assetType: "knowledge_document" as const,
        displayName: artifact.displayName,
        sourceUri: artifact.content || artifact.loadContent ? candidateUri(candidateId, artifact.displayName) : artifact.sourceUri || candidateUri(candidateId, artifact.displayName),
        sourceVersion: versionResolution.sourceVersion,
        checksum: artifact.checksum,
        suggestedMetadataJson: suggested.metadata,
        discoveryJson: {
          runId,
          mode: input.mode,
          scanMode: input.scanMode,
          relativePath: artifact.relativePath,
          extension: artifact.extension,
          sizeBytes: artifact.sizeBytes,
          sourceOriginUri: artifact.sourceUri || null,
          sourceModifiedAt: artifact.sourceModifiedAt || null,
          etag: artifact.etag || null,
          discoveredAt: new Date().toISOString(),
          contentStaged: Boolean(artifact.content || artifact.loadContent),
        },
        diagnosticsJson: diagnostics,
        status: "draft" as const,
        createdBy: input.actor,
        updatedBy: input.actor,
      };
    });
    const missingActions = syncPlan.actions.filter(action => action.kind === "missing" && action.previous);
    const previousCandidates = new Map((await Promise.all(missingActions.map(async action => {
      const candidateId = action.previous?.latestCandidateId;
      return [action.sourceItemId, candidateId ? await getEnterpriseAssetCandidate(candidateId) : null] as const;
    }))));
    const tombstoneCandidates = missingActions.map(action => {
      const previous = action.previous!;
      const previousCandidate = previousCandidates.get(action.sourceItemId);
      const tombstoneToken = createHash("sha256")
        .update(`${input.source.sourceId}\0${action.sourceItemId}\0${previous.lastSeenRunId || previous.contentHash}`)
        .digest("hex").slice(0, 8);
      const sourceVersion = `${String(previous.latestSourceVersion || "unknown").slice(0, 42)}+tombstone.${tombstoneToken}`;
      return {
        candidateId: newEnterpriseAssetCandidateId(),
        sourceId: input.source.sourceId,
        syncRunId: runId,
        sourceItemId: action.sourceItemId,
        enterpriseAssetId: action.enterpriseAssetId,
        assetType: "knowledge_document" as const,
        displayName: path.basename(previous.relativePath),
        sourceUri: previous.sourceUri || null,
        sourceVersion,
        checksum: createHash("sha256").update(`tombstone\0${input.source.sourceId}\0${action.sourceItemId}\0${tombstoneToken}`).digest("hex"),
        suggestedMetadataJson: previousCandidate?.confirmedMetadataJson || previousCandidate?.suggestedMetadataJson || {
          ownerDepartment: input.source.ownerDepartment,
          classification: "internal",
          applicableRoles: [],
          applicableOrganizations: [],
          lifecycle: "draft",
          authority: "reference",
          effectiveAt: null,
          expiresAt: null,
          documentSeriesId: action.enterpriseAssetId,
          supersedes: null,
          externalProcessingAllowed: false,
          relatedTasks: [],
          policyCandidates: [],
          suggestedDomain: "general",
          logicalAssetCandidates: [],
          suggestionMethod: "deterministic",
        },
        discoveryJson: {
          runId,
          mode: input.mode,
          scanMode: input.scanMode,
          relativePath: previous.relativePath,
          sourceOriginUri: previous.sourceUri || null,
          discoveredAt: new Date().toISOString(),
          tombstone: true,
        },
        diagnosticsJson: [{
          code: "SOURCE_ITEM_DELETED",
          severity: "error",
          field: "lifecycle",
          message: "完整来源扫描确认文件已删除；需完成影响分析后人工决定退役或恢复",
        }],
        status: "draft" as const,
        createdBy: input.actor,
        updatedBy: input.actor,
      };
    });
    const allCandidates = [...candidates, ...tombstoneCandidates];
    for (const candidate of candidates) {
      const artifact = candidateArtifacts.get(candidate.candidateId);
      if (!artifact?.content && !artifact?.loadContent) continue;
      const content = artifact.content || await artifact.loadContent!();
      persistCandidateArtifact(candidate.candidateId, artifact.displayName, content);
      stagedCandidateIds.push(candidate.candidateId);
    }
    const rows = await importEnterpriseAssetCandidates(allCandidates);
    candidatesImported = true;
    for (const row of rows) {
      const planned = candidates.find(candidate => candidate.enterpriseAssetId === row.enterpriseAssetId && candidate.sourceVersion === row.sourceVersion);
      if (!planned || planned.candidateId === row.candidateId || !planned.sourceUri?.startsWith("candidate://")) continue;
      const artifact = candidateArtifacts.get(planned.candidateId);
      if (!artifact) continue;
      persistCandidateArtifact(row.candidateId, artifact.displayName, readCandidateArtifact(planned.candidateId, planned.sourceUri));
      removeCandidateArtifactFiles(planned.candidateId);
      stagedCandidateIds = stagedCandidateIds.filter(candidateId => candidateId !== planned.candidateId);
    }
    const candidateBySourceItem = new Map(rows.flatMap(row => row.sourceItemId ? [[row.sourceItemId, row.candidateId] as const] : []));
    await completeEnterpriseAssetSourceRun({
      runId,
      sourceId: input.source.sourceId,
      status: "succeeded",
      scanComplete: batch.scanComplete,
      cursorAfter: batch.cursorAfter || null,
      counts: { ...syncPlan.counts, failed: 0 },
      items: syncPlan.actions.map(action => {
        const item = action.observed || action.previous!;
        return {
          action: action.kind === "missing" ? "missing" as const : "seen" as const,
          sourceItemId: action.sourceItemId,
          externalItemId: item.externalItemId,
          enterpriseAssetId: action.enterpriseAssetId,
          relativePath: item.relativePath,
          sourceUri: item.sourceUri || null,
          etag: item.etag || null,
          sourceModifiedAt: item.sourceModifiedAt ? new Date(item.sourceModifiedAt) : null,
          contentHash: item.contentHash,
          latestSourceVersion: candidateBySourceItem.has(action.sourceItemId)
            ? rows.find(row => row.sourceItemId === action.sourceItemId)?.sourceVersion || action.previous?.latestSourceVersion || null
            : action.previous?.latestSourceVersion || null,
          sizeBytes: item.sizeBytes,
          latestCandidateId: candidateBySourceItem.get(action.sourceItemId) || null,
        };
      }),
      actor: input.actor,
    });
    const remediationCount = allCandidates.filter(candidate => candidate.diagnosticsJson.length > 0).length;
    await input.audit?.("completed", {
      runId,
      mode: input.mode,
      artifactCount: rows.length,
      unchangedCount: syncPlan.counts.unchanged,
      missingCount: syncPlan.counts.missing,
      deletionDetectionApplied: syncPlan.deletionDetectionApplied,
      remediationCount,
      candidateIds: rows.map(row => row.candidateId),
    });
    return {
      runId,
      discovered: artifacts.length,
      candidates: rows,
      created: syncPlan.counts.created,
      changed: syncPlan.counts.changed,
      tombstones: tombstoneCandidates.length,
      unchanged: syncPlan.counts.unchanged,
      missing: syncPlan.counts.missing,
      deletionDetectionApplied: syncPlan.deletionDetectionApplied,
      remediationCount,
      modelSuggestionApplied: input.useModelSuggestion && !model.failed,
      cursorAfter: batch.cursorAfter || null,
    };
  } catch (error) {
    if (!candidatesImported) {
      for (const candidateId of stagedCandidateIds) removeCandidateArtifactFiles(candidateId);
    }
    await failEnterpriseAssetSourceRun({
      runId,
      error: { message: error instanceof Error ? error.message : "资产发现失败" },
    }).catch(() => undefined);
    throw error;
  }
}
