import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { auditActor, auditRequest, recordAuditRequired } from "../_core/audit-events";
import {
  analyzeEnterpriseAssetImpact,
  enterpriseAssetManifestSchema,
  enterpriseAssetMetadataSchema,
  newEnterpriseAssetCandidateId,
  targetTypeForEnterpriseAsset,
} from "../_core/enterprise-asset-onboarding";
import { listAgentRoleTemplates } from "../_core/role-templates";
import { adminProcedure, router } from "../_core/trpc";
import {
  getEnterpriseAssetCandidate,
  getEnterpriseAssetSource,
  getEnterpriseMcpConnection,
  getKnowledgeDocumentByPublicId,
  importEnterpriseAssetCandidates,
  listApprovedSkillMarketItems,
  listEnterpriseAssetCandidates,
  listEnterpriseAssetSources,
  publishEnterpriseAssetCandidate,
  updateEnterpriseAssetCandidate,
  upsertEnterpriseAssetSource,
} from "../db";

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
    const [sources, candidates] = await Promise.all([
      listEnterpriseAssetSources(),
      listEnterpriseAssetCandidates(input || {}),
    ]);
    return {
      sources,
      candidates,
      summary: {
        sources: sources.length,
        pendingReview: candidates.filter(row => row.status === "review_pending").length,
        approved: candidates.filter(row => row.status === "approved").length,
        published: candidates.filter(row => row.status === "published").length,
        stale: candidates.filter(row => row.status === "stale").length,
      },
    };
  }),

  saveSource: adminProcedure.input(sourceSchema).mutation(async ({ input, ctx }) => {
    const actor = actorName(ctx.user);
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
      sourceVersion: candidate.sourceVersion,
      checksum: candidate.checksum,
      metadata: input.confirmedMetadata,
    });
    await audit(ctx, "enterprise_asset.review.requested", candidate.candidateId, { impact });
    const row = await updateEnterpriseAssetCandidate(candidate.candidateId, {
      confirmedMetadataJson: input.confirmedMetadata,
      impactAnalysisJson: impact,
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

  publish: adminProcedure.input(z.object({
    candidateId: z.string().min(3).max(64),
    targetAssetType: targetTypeSchema,
    targetAssetId: z.string().min(1).max(128),
  })).mutation(async ({ input, ctx }) => {
    const candidate = await getEnterpriseAssetCandidate(input.candidateId);
    if (!candidate || candidate.status !== "approved" || !candidate.confirmedMetadataJson) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "仅审核通过且元数据完整的资产可发布" });
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
