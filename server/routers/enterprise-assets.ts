import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { nanoid } from "nanoid";
import { z } from "zod";
import { auditActor, auditRequest, recordAuditRequired } from "../_core/audit-events";
import {
  analyzeEnterpriseAssetImpact,
  enterpriseAssetManifestSchema,
  enterpriseAssetMetadataSchema,
  newEnterpriseAssetCandidateId,
  targetTypeForEnterpriseAsset,
} from "../_core/enterprise-asset-onboarding";
import {
  discoverObjectInventoryArtifact,
  discoverUploadedArtifact,
  discoverZipArtifacts,
  readCandidateArtifact,
  type DiscoveredEnterpriseArtifact,
} from "../_core/enterprise-asset-discovery";
import { ingestEnterpriseAssetSource } from "../_core/enterprise-asset-ingestion";
import { scanFilesystemSource } from "../_core/filesystem-source-connector";
import { parseObjectStorageSourceUri, scanObjectStorageSource } from "../_core/object-storage-source-connector";
import { decodeBase64Strict, scanUploadForMalware } from "../_core/upload-security";
import { listAgentRoleTemplates } from "../_core/role-templates";
import { adminProcedure, router } from "../_core/trpc";
import {
  getEnterpriseAssetCandidate,
  getEnterpriseAssetSource,
  getEnterpriseMcpConnection,
  getKnowledgeBaseById,
  getKnowledgeBaseByPublicId,
  getKnowledgeDocumentByPublicId,
  createKnowledgeDocumentRecord,
  deleteKnowledgeDocumentRecord,
  findKnowledgeDocumentByHash,
  importEnterpriseAssetCandidates,
  listApprovedSkillMarketItems,
  listEnterpriseAssetCandidates,
  listEnterpriseAssetSources,
  listEnterpriseAssetSourceItems,
  listEnterpriseAssetSourceRuns,
  listGovernedKnowledgeBases,
  listKnowledgeDocuments,
  listKnowledgeDocumentsByPublicIds,
  latestVerifiedRolePackReleases,
  publishEnterpriseAssetCandidate,
  activateEnterpriseKnowledgeCandidate,
  classifyEnterpriseKnowledgeCandidate,
  stageEnterpriseKnowledgeCandidate,
  updateEnterpriseAssetCandidate,
  upsertEnterpriseAssetSource,
} from "../db";
import {
  knowledgeDocumentStoragePath,
  knowledgeExtension,
  knowledgeMimeType,
  removeKnowledgeDocumentFiles,
} from "../_core/knowledge-storage";
import { queueKnowledgeIndex } from "../_core/knowledge-service";
import { enterpriseKnowledgeGateReadiness, rolePackReleaseCoversCandidate, validationProvidesCandidate, verifyWealthPolicyCandidate } from "../_core/enterprise-knowledge-release";
import { persistReferenceRolePackScenarioReport } from "../_core/reference-role-pack-release";

const sourceSchema = z.object({
  sourceId: z.string().min(3).max(128).regex(/^[a-zA-Z0-9._-]+$/),
  displayName: z.string().min(1).max(200),
  sourceType: z.enum(["document_repository", "business_system", "rule_catalog", "workflow_catalog", "capability_service", "identity_directory"]),
  sourceUri: z.string().max(1000).nullable().optional(),
  ownerDepartment: z.string().min(1).max(200),
  ownerContact: z.string().max(200).nullable().optional(),
  syncMode: z.enum(["manual", "scheduled", "webhook"]).default("manual"),
  status: z.enum(["active", "paused", "disabled"]).default("active"),
});

const targetTypeSchema = z.enum(["knowledge_document", "enterprise_mcp", "skill", "policy", "role"]);
const projectionDecisionSchema = z.enum(["searchable_only", "runtime_candidate", "archived"]);

const discoveryObservationsSchema = z.object({
  parseStatus: z.enum(["ok", "failed"]).optional(),
  ocrStatus: z.enum(["not_required", "ok", "failed"]).optional(),
  tableStatus: z.enum(["not_present", "ok", "anomaly"]).optional(),
}).optional();

const discoveryInputSchema = z.object({
  sourceId: z.string().min(3).max(128),
  mode: z.enum(["files", "zip", "object_inventory"]),
  scanMode: z.enum(["full", "incremental"]).default("incremental"),
  scanComplete: z.boolean().default(true),
  cursorBefore: z.string().max(1000).nullable().optional(),
  cursorAfter: z.string().max(1000).nullable().optional(),
  resumeOfRunId: z.string().max(64).nullable().optional(),
  files: z.array(z.object({
    name: z.string().min(1).max(240),
    relativePath: z.string().min(1).max(512).optional(),
    contentBase64: z.string().min(1).max(72 * 1024 * 1024),
    lastModified: z.string().datetime().optional(),
  })).max(100).optional(),
  zip: z.object({
    name: z.string().min(1).max(240),
    contentBase64: z.string().min(1).max(72 * 1024 * 1024),
  }).optional(),
  objects: z.array(z.object({
    externalItemId: z.string().min(1).max(512).optional(),
    key: z.string().min(1).max(512),
    checksum: z.string().regex(/^[a-fA-F0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative().max(1024 * 1024 * 1024),
    sourceUri: z.string().min(1).max(1000),
    etag: z.string().max(256).optional(),
    lastModified: z.string().datetime().optional(),
    observations: discoveryObservationsSchema,
  })).max(100).optional(),
  useModelSuggestion: z.boolean().default(false),
  allowContentProcessing: z.boolean().default(false),
}).superRefine((input, ctx) => {
  if (input.mode === "files" && !input.files?.length) ctx.addIssue({ code: "custom", path: ["files"], message: "请选择至少一个文件" });
  if (input.mode === "zip" && !input.zip) ctx.addIssue({ code: "custom", path: ["zip"], message: "请选择 ZIP 文件" });
  if (input.mode === "object_inventory" && !input.objects?.length) ctx.addIssue({ code: "custom", path: ["objects"], message: "对象存储清单不能为空" });
});

const MAX_DISCOVERY_BYTES = 50 * 1024 * 1024;

function actorName(user: { id?: number | string | null; name?: string | null; email?: string | null }) {
  return String(user.name || user.email || user.id || "admin").slice(0, 128);
}

async function audit(ctx: any, action: string, candidateId: string, metadata: Record<string, unknown>) {
  return recordAuditRequired({
    action,
    result: "success",
    severity: "high",
    ...auditActor(ctx.user),
    ...auditRequest(ctx.req),
    targetType: "enterprise_asset_candidate",
    targetId: candidateId,
    resourceType: "enterprise_asset",
    resourceId: candidateId,
    metadata,
  });
}

function assertRoles(metadata: z.infer<typeof enterpriseAssetMetadataSchema>) {
  const roles = new Set(listAgentRoleTemplates().map(role => role.id));
  for (const role of metadata.applicableRoles) {
    if (!roles.has(role)) throw new TRPCError({ code: "BAD_REQUEST", message: `未知岗位: ${role}` });
  }
}

function unresolvedDiagnostics(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(item => item && typeof item === "object" && !(item as Record<string, unknown>).resolvedAt) as Array<Record<string, unknown>>;
}

function knowledgeReleaseStatus(candidate: {
  status: string;
  targetAssetId?: string | null;
  confirmedMetadataJson?: unknown;
  projectionDecision?: "pending" | "searchable_only" | "runtime_candidate" | "archived";
}, document: Awaited<ReturnType<typeof getKnowledgeDocumentByPublicId>>): string {
  if (candidate.status === "approved" && !candidate.targetAssetId) {
    if (candidate.projectionDecision === "pending") return "runtime_classification_required";
    if (candidate.projectionDecision === "searchable_only") return "searchable_only";
    if (candidate.projectionDecision === "archived") return "not_for_runtime";
    const parsed = enterpriseAssetMetadataSchema.safeParse(candidate.confirmedMetadataJson);
    return parsed.success ? enterpriseKnowledgeGateReadiness(parsed.data) : "metadata_confirmation_required";
  }
  if (candidate.status === "approved" && document?.lifecycle === "draft") return "awaiting_validation";
  if (candidate.status !== "published" || !document) return candidate.status;
  if (document.lifecycle !== "active") return "inactive";
  const effectiveAt = document.effectiveAt ? new Date(document.effectiveAt) : null;
  if (effectiveAt && effectiveAt.getTime() > Date.now()) return "validated_pending_effective";
  const expiresAt = document.expiresAt ? new Date(document.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) return "expired";
  return "active";
}

async function uploadedArtifacts(input: z.infer<typeof discoveryInputSchema>): Promise<DiscoveredEnterpriseArtifact[]> {
  if (input.mode === "object_inventory") {
    return (input.objects || []).map(discoverObjectInventoryArtifact);
  }
  if (input.mode === "zip") {
    const buffer = decodeBase64Strict(input.zip?.contentBase64 || "");
    if (!buffer) throw new TRPCError({ code: "BAD_REQUEST", message: "ZIP 内容不是有效 Base64" });
    const malware = await scanUploadForMalware(buffer);
    if (!malware.ok) throw new TRPCError({ code: "BAD_REQUEST", message: malware.error });
    try {
      return discoverZipArtifacts(buffer);
    } catch (error) {
      throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message.replace(/技能包/g, "压缩包") : "ZIP 解析失败" });
    }
  }
  const artifacts: DiscoveredEnterpriseArtifact[] = [];
  let totalBytes = 0;
  for (const file of input.files || []) {
    const content = decodeBase64Strict(file.contentBase64);
    if (!content) throw new TRPCError({ code: "BAD_REQUEST", message: `${file.name} 不是有效 Base64` });
    totalBytes += content.length;
    if (totalBytes > MAX_DISCOVERY_BYTES) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "单次发现文件总大小不能超过 50MB" });
    const malware = await scanUploadForMalware(content);
    if (!malware.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `${file.name}: ${malware.error}` });
    try {
      artifacts.push(discoverUploadedArtifact({
        name: file.name,
        relativePath: file.relativePath,
        content,
        lastModified: file.lastModified,
      }));
    } catch (error) {
      throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : `${file.name} 解析失败` });
    }
  }
  return artifacts;
}

async function assertRuntimeTarget(targetType: z.infer<typeof targetTypeSchema>, targetId: string) {
  if (targetType === "knowledge_document") {
    if (!(await getKnowledgeDocumentByPublicId(targetId))) throw new TRPCError({ code: "BAD_REQUEST", message: "目标知识文档不存在" });
    return;
  }
  if (targetType === "enterprise_mcp") {
    if (!(await getEnterpriseMcpConnection(targetId))) throw new TRPCError({ code: "BAD_REQUEST", message: "目标企业 MCP 不存在" });
    return;
  }
  if (targetType === "skill") {
    if (!(await listApprovedSkillMarketItems()).some(skill => skill.skillId === targetId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "目标 Skill 不存在或尚未审核通过" });
    }
    return;
  }
  if (targetType === "role") {
    if (!listAgentRoleTemplates().some(role => role.id === targetId && role.status !== "disabled")) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "目标岗位不存在或已停用" });
    }
    return;
  }
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: "Policy 候选不能直接发布。请先实现并测试 Policy Adapter，再登记可验证的策略绑定。",
  });
}

export const enterpriseAssetsRouter = router({
  overview: adminProcedure.input(z.object({
    sourceId: z.string().max(128).optional(),
    status: z.enum(["draft", "review_pending", "approved", "rejected", "published", "stale"]).optional(),
  }).optional()).query(async ({ input }) => {
    const roles = listAgentRoleTemplates();
    const [sources, candidates, knowledgeBases] = await Promise.all([
      listEnterpriseAssetSources(),
      listEnterpriseAssetCandidates(input || {}),
      listGovernedKnowledgeBases(),
    ]);
    const runtimeDocumentsById = new Map((await listKnowledgeDocumentsByPublicIds(candidates.flatMap(candidate => (
      candidate.targetAssetType === "knowledge_document" && candidate.targetAssetId ? [candidate.targetAssetId] : []
    )))).map(document => [document.publicId, document]));
    return {
      sources,
      roles: roles.map(role => ({ id: role.id, name: role.name })),
      knowledgeBases: knowledgeBases.map(base => ({
        publicId: base.publicId,
        name: base.name,
        scope: base.scope,
        roleTemplate: base.roleTemplate,
        status: base.status,
      })),
      candidates: candidates.map((candidate) => {
        const runtimeDocument = candidate.targetAssetId ? runtimeDocumentsById.get(candidate.targetAssetId) || null : null;
        const impact = candidate.impactAnalysisJson && typeof candidate.impactAnalysisJson === "object"
          ? candidate.impactAnalysisJson as Record<string, unknown>
          : {};
        const validation = impact.knowledgeValidation && typeof impact.knowledgeValidation === "object"
          ? impact.knowledgeValidation as Record<string, unknown>
          : null;
        return {
          ...candidate,
          releaseStatus: candidate.assetType === "knowledge_document"
            ? knowledgeReleaseStatus(candidate, runtimeDocument)
            : candidate.status,
          runtimeDocument: runtimeDocument ? {
            publicId: runtimeDocument.publicId,
            versionLabel: runtimeDocument.versionLabel,
            lifecycle: runtimeDocument.lifecycle,
            effectiveAt: runtimeDocument.effectiveAt,
            expiresAt: runtimeDocument.expiresAt,
            status: runtimeDocument.status,
          } : null,
          validationStatus: validation?.status === "PASS" || validation?.status === "FAIL" ? validation.status : null,
        };
      }),
      summary: {
        sources: sources.length,
        pendingRemediation: candidates.filter(row => unresolvedDiagnostics(row.diagnosticsJson).length > 0 && ["draft", "rejected"].includes(row.status)).length,
        pendingReview: candidates.filter(row => row.status === "review_pending").length,
        approved: candidates.filter(row => row.status === "approved").length,
        pendingRuntimeClassification: candidates.filter(row => row.assetType === "knowledge_document" && row.status === "approved" && row.projectionDecision === "pending").length,
        searchableOnly: candidates.filter(row => row.assetType === "knowledge_document" && row.projectionDecision === "searchable_only").length,
        runtimeCandidates: candidates.filter(row => row.assetType === "knowledge_document" && row.projectionDecision === "runtime_candidate").length,
        published: candidates.filter(row => row.status === "published").length,
        stale: candidates.filter(row => row.status === "stale").length,
      },
    };
  }),

  saveSource: adminProcedure.input(sourceSchema).mutation(async ({ input, ctx }) => {
    const actor = actorName(ctx.user);
    if (/^(?:s3|obs):\/\//.test(input.sourceUri || "")) {
      if (input.sourceType !== "document_repository") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "OBS/S3 来源必须登记为制度/文档库" });
      }
      try {
        parseObjectStorageSourceUri(input.sourceUri!);
      } catch (error) {
        throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "对象存储来源配置无效" });
      }
    }
    await audit(ctx, "enterprise_asset.source.save_requested", input.sourceId, { sourceType: input.sourceType, syncMode: input.syncMode });
    const row = await upsertEnterpriseAssetSource({
      ...input,
      sourceUri: input.sourceUri || null,
      ownerContact: input.ownerContact || null,
      createdBy: actor,
      updatedBy: actor,
    });
    await audit(ctx, "enterprise_asset.source.save_completed", input.sourceId, { sourceType: input.sourceType, syncMode: input.syncMode });
    return row;
  }),

  discoverArtifacts: adminProcedure.input(discoveryInputSchema).mutation(async ({ input, ctx }) => {
    const source = await getEnterpriseAssetSource(input.sourceId);
    if (!source || source.status !== "active") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "接入来源不存在或未启用" });
    }
    if (!new Set(["document_repository", "rule_catalog"]).has(source.sourceType)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "当前发现入口仅支持文档库和规则目录" });
    }
    const artifacts = await uploadedArtifacts(input);
    if (!artifacts.length || artifacts.length > 100) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "单次必须发现 1 到 100 个知识文件" });
    }
    const totalBytes = artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
    if (input.mode !== "object_inventory" && totalBytes > MAX_DISCOVERY_BYTES) {
      throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "单次发现文件总大小不能超过 50MB" });
    }
    try {
      return await ingestEnterpriseAssetSource({
        source,
        actor: actorName(ctx.user),
        mode: input.mode,
        scanMode: input.scanMode,
        cursorBefore: input.cursorBefore,
        resumeOfRunId: input.resumeOfRunId,
        useModelSuggestion: input.useModelSuggestion,
        allowContentProcessing: input.allowContentProcessing,
        discover: async () => ({
          artifacts,
          scanComplete: input.scanComplete,
          cursorAfter: input.cursorAfter,
        }),
        audit: async (phase, metadata) => {
          await audit(ctx, `enterprise_asset.discovery.${phase}`, source.sourceId, metadata);
        },
      });
    } catch (error) {
      throw new TRPCError({ code: "CONFLICT", message: error instanceof Error ? error.message : "资产发现结果存在版本冲突" });
    }
  }),

  syncFilesystemSource: adminProcedure.input(z.object({
    sourceId: z.string().min(3).max(128),
    resumeOfRunId: z.string().max(64).nullable().optional(),
    useModelSuggestion: z.boolean().default(false),
    allowContentProcessing: z.boolean().default(false),
  })).mutation(async ({ input, ctx }) => {
    const source = await getEnterpriseAssetSource(input.sourceId);
    if (!source || source.status !== "active") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "接入来源不存在或未启用" });
    }
    if (source.sourceType !== "document_repository" || !source.sourceUri) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Filesystem Connector 需要已启用的文档库来源和 file:// 地址" });
    }
    try {
      return await ingestEnterpriseAssetSource({
        source,
        actor: actorName(ctx.user),
        mode: "filesystem_connector",
        scanMode: "full",
        resumeOfRunId: input.resumeOfRunId,
        useModelSuggestion: input.useModelSuggestion,
        allowContentProcessing: input.allowContentProcessing,
        discover: async () => {
          const scan = await scanFilesystemSource({ sourceUri: source.sourceUri! });
          return {
            artifacts: scan.artifacts,
            scanComplete: scan.scanComplete,
            cursorAfter: scan.cursorAfter,
            metadata: {
              rootPath: scan.rootPath,
              skippedSymlinks: scan.skippedSymlinks,
              skippedUnsupported: scan.skippedUnsupported,
            },
          };
        },
        audit: async (phase, metadata) => {
          await audit(ctx, `enterprise_asset.filesystem_sync.${phase}`, source.sourceId, metadata);
        },
      });
    } catch (error) {
      throw new TRPCError({ code: "CONFLICT", message: error instanceof Error ? error.message : "Filesystem Connector 同步失败" });
    }
  }),

  syncObjectStorageSource: adminProcedure.input(z.object({
    sourceId: z.string().min(3).max(128),
    resumeOfRunId: z.string().max(64).nullable().optional(),
    useModelSuggestion: z.boolean().default(false),
    allowContentProcessing: z.boolean().default(false),
  })).mutation(async ({ input, ctx }) => {
    const source = await getEnterpriseAssetSource(input.sourceId);
    if (!source || source.status !== "active") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "接入来源不存在或未启用" });
    }
    if (source.sourceType !== "document_repository" || !source.sourceUri || !/^(?:s3|obs):\/\//.test(source.sourceUri)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "OBS/S3 Connector 需要已启用的文档库来源和 s3:// 或 obs:// 地址" });
    }
    try {
      const config = parseObjectStorageSourceUri(source.sourceUri);
      const existingItems = await listEnterpriseAssetSourceItems(source.sourceId);
      return await ingestEnterpriseAssetSource({
        source,
        actor: actorName(ctx.user),
        mode: "object_storage_connector",
        scanMode: "full",
        resumeOfRunId: input.resumeOfRunId,
        useModelSuggestion: input.useModelSuggestion,
        allowContentProcessing: input.allowContentProcessing,
        discover: async () => {
          const scan = await scanObjectStorageSource({
            sourceUri: source.sourceUri!,
            existingItems,
          });
          return {
            artifacts: scan.artifacts,
            scanComplete: scan.scanComplete,
            cursorAfter: scan.cursorAfter,
            metadata: {
              provider: config.scheme,
              endpoint: config.endpoint || "aws-default",
              bucket: config.bucket,
              prefix: config.prefix,
              pages: scan.pages,
              downloaded: scan.downloaded,
              reusedContentHashes: scan.reusedContentHashes,
              skippedUnsupported: scan.skippedUnsupported,
            },
          };
        },
        audit: async (phase, metadata) => {
          await audit(ctx, `enterprise_asset.object_storage_sync.${phase}`, source.sourceId, metadata);
        },
      });
    } catch (error) {
      throw new TRPCError({ code: "CONFLICT", message: error instanceof Error ? error.message : "OBS/S3 Connector 同步失败" });
    }
  }),

  sourceSyncStatus: adminProcedure.input(z.object({
    sourceId: z.string().min(3).max(128),
  })).query(async ({ input }) => {
    const [runs, items] = await Promise.all([
      listEnterpriseAssetSourceRuns(input.sourceId),
      listEnterpriseAssetSourceItems(input.sourceId),
    ]);
    return {
      runs,
      summary: {
        active: items.filter(item => item.state === "active").length,
        missing: items.filter(item => item.state === "missing").length,
        retired: items.filter(item => item.state === "retired").length,
      },
    };
  }),

  importManifest: adminProcedure.input(z.object({
    sourceId: z.string().min(3).max(128),
    manifest: enterpriseAssetManifestSchema,
  })).mutation(async ({ input, ctx }) => {
    const source = await getEnterpriseAssetSource(input.sourceId);
    if (!source || source.status !== "active") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "接入来源不存在或未启用" });
    const actor = actorName(ctx.user);
    for (const asset of input.manifest.assets) assertRoles(asset.metadata);
    const candidates = input.manifest.assets.map(asset => ({
      candidateId: newEnterpriseAssetCandidateId(),
      sourceId: source.sourceId,
      enterpriseAssetId: asset.assetId,
      assetType: asset.assetType,
      displayName: asset.name,
      sourceUri: asset.sourceUri || asset.file || null,
      sourceVersion: asset.versionLabel,
      checksum: asset.checksum.toLowerCase(),
      suggestedMetadataJson: { ...asset.metadata, enterpriseId: input.manifest.enterpriseId },
      status: "draft" as const,
      createdBy: actor,
      updatedBy: actor,
    }));
    await audit(ctx, "enterprise_asset.manifest.import_requested", source.sourceId, {
      enterpriseId: input.manifest.enterpriseId,
      assetCount: candidates.length,
      assetIds: candidates.map(row => row.enterpriseAssetId),
    });
    let rows;
    try {
      rows = await importEnterpriseAssetCandidates(candidates);
    } catch (error) {
      throw new TRPCError({ code: "CONFLICT", message: error instanceof Error ? error.message : "资产版本导入冲突" });
    }
    await audit(ctx, "enterprise_asset.manifest.import_completed", source.sourceId, {
      enterpriseId: input.manifest.enterpriseId,
      assetCount: rows.length,
      assetIds: rows.map(row => row?.enterpriseAssetId),
    });
    return { imported: rows.length, candidates: rows };
  }),

  submitReview: adminProcedure.input(z.object({
    candidateId: z.string().min(3).max(64),
    displayName: z.string().min(1).max(240).optional(),
    sourceVersion: z.string().min(1).max(64).optional(),
    confirmedMetadata: enterpriseAssetMetadataSchema,
  })).mutation(async ({ input, ctx }) => {
    const candidate = await getEnterpriseAssetCandidate(input.candidateId);
    if (!candidate || !["draft", "rejected"].includes(candidate.status)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "仅草稿或已退回资产可提交审核" });
    }
    assertRoles(input.confirmedMetadata);
    const impact = analyzeEnterpriseAssetImpact({
      assetType: candidate.assetType,
      enterpriseAssetId: candidate.enterpriseAssetId,
      sourceVersion: input.sourceVersion || candidate.sourceVersion,
      checksum: candidate.checksum,
      metadata: input.confirmedMetadata,
    });
    await audit(ctx, "enterprise_asset.review.requested", candidate.candidateId, { impact });
    const row = await updateEnterpriseAssetCandidate(candidate.candidateId, {
      displayName: input.displayName || candidate.displayName,
      sourceVersion: input.sourceVersion || candidate.sourceVersion,
      confirmedMetadataJson: input.confirmedMetadata,
      impactAnalysisJson: impact,
      diagnosticsJson: unresolvedDiagnostics(candidate.diagnosticsJson).map(diagnostic => ({
        ...diagnostic,
        resolution: "confirmed_by_reviewer",
        resolvedAt: new Date().toISOString(),
        resolvedBy: actorName(ctx.user),
      })),
      status: "review_pending",
      reviewNote: null,
      updatedBy: actorName(ctx.user),
    }, ["draft", "rejected"]);
    if (!row || row.status !== "review_pending") throw new TRPCError({ code: "CONFLICT", message: "资产状态已变化，请刷新后重试" });
    await audit(ctx, "enterprise_asset.review.submitted", candidate.candidateId, { impact });
    return row;
  }),

  review: adminProcedure.input(z.object({
    candidateId: z.string().min(3).max(64),
    decision: z.enum(["approve", "reject"]),
    note: z.string().max(2000).optional(),
  })).mutation(async ({ input, ctx }) => {
    const candidate = await getEnterpriseAssetCandidate(input.candidateId);
    if (!candidate || candidate.status !== "review_pending") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "仅待审核资产可执行评审" });
    }
    if (input.decision === "reject" && !input.note?.trim()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "退回时必须填写原因" });
    }
    await audit(ctx, "enterprise_asset.review.decision_requested", candidate.candidateId, { decision: input.decision, note: input.note || null });
    const row = await updateEnterpriseAssetCandidate(candidate.candidateId, {
      status: input.decision === "approve" ? "approved" : "rejected",
      reviewNote: input.note?.trim() || null,
      reviewedBy: actorName(ctx.user),
      reviewedAt: new Date(),
      updatedBy: actorName(ctx.user),
    }, ["review_pending"]);
    const expectedStatus = input.decision === "approve" ? "approved" : "rejected";
    if (!row || row.status !== expectedStatus) throw new TRPCError({ code: "CONFLICT", message: "资产状态已变化，请刷新后重试" });
    await audit(ctx, input.decision === "approve" ? "enterprise_asset.review.approved" : "enterprise_asset.review.rejected", candidate.candidateId, { note: input.note || null });
    return row;
  }),

  classifyKnowledgeRuntime: adminProcedure.input(z.object({
    candidateId: z.string().min(3).max(64),
    decision: projectionDecisionSchema,
    decisionReason: z.string().trim().min(8).max(1000),
    logicalAssetIds: z.array(z.string().min(1).max(128)).max(16).default([]),
    relatedTasks: z.array(z.string().min(1).max(64)).max(64).default([]),
  })).mutation(async ({ input, ctx }) => {
    const candidate = await getEnterpriseAssetCandidate(input.candidateId);
    if (!candidate || candidate.assetType !== "knowledge_document" || candidate.status !== "approved"
      || candidate.targetAssetId || !candidate.confirmedMetadataJson) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "仅审核通过且尚未投影的知识资产可执行 Runtime 分类" });
    }
    const metadata = enterpriseAssetMetadataSchema.parse(candidate.confirmedMetadataJson);
    if (input.decision === "archived" && metadata.lifecycle !== "archived") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "只有已归档资产可以选择不投影归档" });
    }
    if (input.decision !== "archived" && metadata.lifecycle !== "active") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "只有计划有效的资产可以建立检索或 Runtime 投影" });
    }
    if (input.decision === "runtime_candidate" && (!input.logicalAssetIds.length || !input.relatedTasks.length)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Runtime Candidate 必须确认 Logical Context 和受影响 Golden Task" });
    }
    const confirmedMetadata = enterpriseAssetMetadataSchema.parse({
      ...metadata,
      logicalAssetIds: input.decision === "runtime_candidate" ? input.logicalAssetIds : [],
      relatedTasks: input.decision === "runtime_candidate" ? input.relatedTasks : [],
    });
    const impact = analyzeEnterpriseAssetImpact({
      assetType: candidate.assetType,
      enterpriseAssetId: candidate.enterpriseAssetId,
      sourceVersion: candidate.sourceVersion,
      checksum: candidate.checksum,
      metadata: confirmedMetadata,
    });
    const actor = actorName(ctx.user);
    const classified = await classifyEnterpriseKnowledgeCandidate({
      candidateId: candidate.candidateId,
      decision: input.decision,
      reason: input.decisionReason,
      confirmedMetadataJson: confirmedMetadata,
      impactAnalysisJson: {
        ...impact,
        runtimeClassification: {
          schema: "ea.runtime-classification.v1",
          decision: input.decision,
          decisionReason: input.decisionReason,
          logicalAssetIds: confirmedMetadata.logicalAssetIds,
          relatedTasks: confirmedMetadata.relatedTasks,
          decidedBy: actor,
          decidedAt: new Date().toISOString(),
        },
      },
      actor,
    });
    await audit(ctx, "enterprise_asset.runtime_classified", candidate.candidateId, {
      decision: input.decision,
      decisionReason: input.decisionReason,
      logicalAssetIds: confirmedMetadata.logicalAssetIds,
      relatedTasks: confirmedMetadata.relatedTasks,
    });
    return classified;
  }),

  stageKnowledgeVersion: adminProcedure.input(z.object({
    candidateId: z.string().min(3).max(64),
    knowledgeBaseId: z.string().min(1).max(64),
  })).mutation(async ({ input, ctx }) => {
    const candidate = await getEnterpriseAssetCandidate(input.candidateId);
    if (!candidate || candidate.assetType !== "knowledge_document" || candidate.status !== "approved" || !candidate.confirmedMetadataJson) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "仅审核通过的知识候选可进入岗位验证" });
    }
    if (candidate.targetAssetId) {
      throw new TRPCError({ code: "CONFLICT", message: "该知识版本已进入验证流程" });
    }
    if (candidate.projectionDecision !== "runtime_candidate") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "该知识资产尚未分类为 Runtime Candidate" });
    }
    const metadata = enterpriseAssetMetadataSchema.parse(candidate.confirmedMetadataJson);
    const gateReadiness = enterpriseKnowledgeGateReadiness(metadata);
    if (gateReadiness !== "ready_to_stage") {
      const message = ({
        not_for_runtime: "该资产不计划进入有效生命周期，无需运行岗位门禁",
        logical_context_mapping_required: "请先确认该知识服务的 Logical Context 映射",
        golden_task_mapping_required: "请先确认该知识影响的 Golden Task",
      } as const)[gateReadiness];
      throw new TRPCError({ code: "PRECONDITION_FAILED", message });
    }
    if (metadata.authority === "official" && !metadata.effectiveAt) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "正式制度必须确认生效时间" });
    }
    const base = await getKnowledgeBaseByPublicId(input.knowledgeBaseId);
    if (!base || !["role", "enterprise"].includes(base.scope)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "目标必须是岗位或企业知识库" });
    }
    if (base.scope === "role" && (!base.roleTemplate || !metadata.applicableRoles.includes(base.roleTemplate))) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "目标知识库岗位与资产适用岗位不一致" });
    }
    let content: Buffer;
    try {
      content = readCandidateArtifact(candidate.candidateId, candidate.sourceUri || "");
    } catch (error) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: error instanceof Error ? error.message : "候选正文不可用" });
    }
    if (candidate.checksum !== createHash("sha256").update(content).digest("hex")) {
      throw new TRPCError({ code: "CONFLICT", message: "候选正文校验失败，请重新发现资产" });
    }
    if (await findKnowledgeDocumentByHash(base.id, candidate.checksum)) {
      throw new TRPCError({ code: "CONFLICT", message: "目标知识库已存在相同内容" });
    }
    const supersedes = metadata.supersedes
      ? await getKnowledgeDocumentByPublicId(metadata.supersedes)
      : null;
    if (metadata.supersedes && (!supersedes || supersedes.knowledgeBaseId !== base.id)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "被替代版本不存在或不属于目标知识库" });
    }
    const extension = knowledgeExtension(candidate.displayName);
    const documentId = `doc_${nanoid(18)}`;
    const storage = knowledgeDocumentStoragePath(base.publicId, documentId, candidate.displayName);
    writeFileSync(storage.absolute, content, { mode: 0o600 });
    let document: Awaited<ReturnType<typeof createKnowledgeDocumentRecord>> | undefined;
    try {
      document = await createKnowledgeDocumentRecord({
        publicId: documentId,
        knowledgeBaseId: base.id,
        name: candidate.displayName,
        extension,
        mimeType: knowledgeMimeType(extension),
        storagePath: storage.relative,
        sizeBytes: content.length,
        sha256: candidate.checksum,
        sourceAssetId: `${candidate.enterpriseAssetId.slice(0, 108)}@${candidate.checksum.slice(0, 16)}`,
        documentSeriesId: metadata.documentSeriesId || candidate.enterpriseAssetId,
        supersedesDocumentId: supersedes?.publicId || null,
        versionLabel: candidate.sourceVersion,
        lifecycle: "draft",
        sourceDepartment: metadata.ownerDepartment,
        classification: metadata.classification,
        authority: metadata.authority,
        externalProcessingAllowed: metadata.externalProcessingAllowed,
        effectiveAt: metadata.effectiveAt ? new Date(metadata.effectiveAt) : null,
        expiresAt: metadata.expiresAt ? new Date(metadata.expiresAt) : null,
      });
      const impact = analyzeEnterpriseAssetImpact({
        assetType: candidate.assetType,
        enterpriseAssetId: candidate.enterpriseAssetId,
        sourceVersion: candidate.sourceVersion,
        checksum: candidate.checksum,
        metadata,
      });
      await stageEnterpriseKnowledgeCandidate({
        candidate,
        documentId,
        impactAnalysisJson: impact,
        affectedRolePackIds: impact.affectedRolePackIds,
        actor: actorName(ctx.user),
      });
      await audit(ctx, "enterprise_asset.knowledge_staged", candidate.candidateId, {
        documentId,
        knowledgeBaseId: base.publicId,
        effectiveAt: metadata.effectiveAt || null,
        affectedTaskIds: impact.affectedTaskIds,
      });
    } catch (error) {
      if (document) await deleteKnowledgeDocumentRecord(document.id, base.id).catch(() => false);
      removeKnowledgeDocumentFiles(base.publicId, documentId);
      throw error;
    }
    void queueKnowledgeIndex({ ...base, status: "indexing", documentCount: base.documentCount + 1 }, "enterprise_asset_staged").catch(() => {});
    return { documentId, releaseStatus: "awaiting_validation" as const };
  }),

  verifyKnowledgeVersion: adminProcedure.input(z.object({
    candidateId: z.string().min(3).max(64),
  })).mutation(async ({ input, ctx }) => {
    const candidate = await getEnterpriseAssetCandidate(input.candidateId);
    if (!candidate || candidate.assetType !== "knowledge_document" || candidate.status !== "approved"
      || candidate.targetAssetType !== "knowledge_document" || !candidate.targetAssetId || !candidate.confirmedMetadataJson) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "该知识版本尚未进入验证流程" });
    }
    const metadata = enterpriseAssetMetadataSchema.parse(candidate.confirmedMetadataJson);
    if (!metadata.applicableRoles.includes("wealth-manager")) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "V1 候选级验证当前仅支持财富经理制度" });
    }
    const document = await getKnowledgeDocumentByPublicId(candidate.targetAssetId);
    if (!document || document.lifecycle !== "draft" || document.status !== "ready") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "知识版本尚未完成索引，暂不能运行标杆任务" });
    }
    const base = await getKnowledgeBaseById(document.knowledgeBaseId);
    if (!base) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "目标知识库不存在" });
    const result = await verifyWealthPolicyCandidate({
      candidate,
      metadata,
      base,
      document,
      documents: await listKnowledgeDocuments(base.id),
    });
    const impact = candidate.impactAnalysisJson && typeof candidate.impactAnalysisJson === "object"
      ? candidate.impactAnalysisJson as Record<string, unknown>
      : {};
    const updated = await updateEnterpriseAssetCandidate(candidate.candidateId, {
      impactAnalysisJson: { ...impact, knowledgeValidation: result.validation },
      updatedBy: actorName(ctx.user),
    }, ["approved"]);
    if (!updated || updated.status !== "approved") {
      throw new TRPCError({ code: "CONFLICT", message: "候选状态已变化，请刷新后重试" });
    }
    await persistReferenceRolePackScenarioReport(result.controlled, result.contract);
    await audit(ctx, "enterprise_asset.knowledge_validated", candidate.candidateId, {
      documentId: document.publicId,
      validationStatus: result.validation.status,
      validationFingerprint: result.validation.validationFingerprint,
      taskIds: result.validation.taskIds,
      checks: result.validation.checks.map(check => ({ code: check.code, passed: check.passed })),
    });
    return result.validation;
  }),

  activateKnowledgeVersion: adminProcedure.input(z.object({
    candidateId: z.string().min(3).max(64),
  })).mutation(async ({ input, ctx }) => {
    const candidate = await getEnterpriseAssetCandidate(input.candidateId);
    if (!candidate || candidate.assetType !== "knowledge_document" || candidate.status !== "approved"
      || candidate.targetAssetType !== "knowledge_document" || !candidate.targetAssetId || !candidate.confirmedMetadataJson) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "该知识版本尚未进入验证流程" });
    }
    const document = await getKnowledgeDocumentByPublicId(candidate.targetAssetId);
    if (!document || document.lifecycle !== "draft" || document.status !== "ready") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "知识版本尚未完成索引，暂不能启用" });
    }
    const metadata = enterpriseAssetMetadataSchema.parse(candidate.confirmedMetadataJson);
    const impactJson = candidate.impactAnalysisJson && typeof candidate.impactAnalysisJson === "object"
      ? candidate.impactAnalysisJson as Record<string, unknown>
      : {};
    const validation = impactJson.knowledgeValidation && typeof impactJson.knowledgeValidation === "object"
      ? impactJson.knowledgeValidation as Record<string, unknown>
      : null;
    if (!validation || validation.status !== "PASS"
      || validation.candidateId !== candidate.candidateId
      || validation.documentId !== document.publicId
      || validation.checksum !== candidate.checksum
      || !validationProvidesCandidate({ validation, candidate, metadata, documentId: document.publicId })) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "该知识版本尚未通过候选级标杆任务验收" });
    }
    const impact = analyzeEnterpriseAssetImpact({
      assetType: candidate.assetType,
      enterpriseAssetId: candidate.enterpriseAssetId,
      sourceVersion: candidate.sourceVersion,
      checksum: candidate.checksum,
      metadata,
    });
    const releases = await latestVerifiedRolePackReleases(impact.affectedRolePackIds);
    const stagedAt = candidate.updatedAt instanceof Date ? candidate.updatedAt : new Date(candidate.updatedAt);
    const releaseByRole = new Map(releases.map(release => [release.rolePackId, release]));
    const missing = impact.affectedRolePackIds.filter(rolePackId => {
      const release = releaseByRole.get(rolePackId);
      return !rolePackReleaseCoversCandidate(release?.verifiedAt, stagedAt);
    });
    if (missing.length) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `受影响岗位尚未在本次知识暂存后完成标杆任务验收: ${missing.join("、")}`,
      });
    }
    const row = await activateEnterpriseKnowledgeCandidate({
      candidate,
      documentId: document.publicId,
      actor: actorName(ctx.user),
    });
    const effectiveAt = document.effectiveAt ? new Date(document.effectiveAt) : null;
    const releaseStatus = effectiveAt && effectiveAt.getTime() > Date.now()
      ? "validated_pending_effective" as const
      : "active" as const;
    await audit(ctx, "enterprise_asset.knowledge_activated", candidate.candidateId, {
      documentId: document.publicId,
      versionLabel: document.versionLabel,
      effectiveAt: document.effectiveAt,
      releaseStatus,
      verifiedReleaseIds: releases.map(release => release.releaseId),
    });
    return { candidate: row, releaseStatus };
  }),

  publish: adminProcedure.input(z.object({
    candidateId: z.string().min(3).max(64),
    targetAssetType: targetTypeSchema,
    targetAssetId: z.string().min(1).max(128),
  })).mutation(async ({ input, ctx }) => {
    const candidate = await getEnterpriseAssetCandidate(input.candidateId);
    if (!candidate || candidate.status !== "approved" || !candidate.confirmedMetadataJson) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "仅审核通过且元数据完整的资产可发布" });
    }
    if (candidate.assetType === "knowledge_document") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "知识文档请先进入岗位验证，再按生效时间启用" });
    }
    const expected = targetTypeForEnterpriseAsset(candidate.assetType);
    if (input.targetAssetType !== expected) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `该候选必须绑定到 ${expected}，不能绑定到 ${input.targetAssetType}` });
    }
    await assertRuntimeTarget(input.targetAssetType, input.targetAssetId);
    const metadata = enterpriseAssetMetadataSchema.parse(candidate.confirmedMetadataJson);
    const impact = analyzeEnterpriseAssetImpact({
      assetType: candidate.assetType,
      enterpriseAssetId: candidate.enterpriseAssetId,
      sourceVersion: candidate.sourceVersion,
      checksum: candidate.checksum,
      metadata,
    });
    await audit(ctx, "enterprise_asset.publish_requested", candidate.candidateId, {
      targetAssetType: input.targetAssetType,
      targetAssetId: input.targetAssetId,
      impact,
    });
    const row = await publishEnterpriseAssetCandidate({
      candidate,
      targetAssetType: input.targetAssetType,
      targetAssetId: input.targetAssetId,
      impactAnalysisJson: impact,
      affectedRolePackIds: impact.affectedRolePackIds,
      actor: actorName(ctx.user),
    });
    await audit(ctx, "enterprise_asset.published", candidate.candidateId, {
      targetAssetType: input.targetAssetType,
      targetAssetId: input.targetAssetId,
      impact,
    });
    return row;
  }),
});
