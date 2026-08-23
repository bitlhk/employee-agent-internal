import "dotenv/config";
import { recordAuditRequired } from "../server/_core/audit-events";
import {
  analyzeEnterpriseAssetImpact,
  enterpriseAssetMetadataSchema,
} from "../server/_core/enterprise-asset-onboarding";
import {
  classifyEnterpriseKnowledgeCandidate,
  listEnterpriseAssetCandidates,
} from "../server/db/enterprise-assets";
import { closeDbConnection } from "../server/db/connection";

const apply = process.argv.includes("--apply");
const actor = "enterprise-asset-runtime-classification-v1";

function classificationReason(roles: string[]): string {
  if (roles.includes("wealth-manager")) {
    return "演示参考资料、培训材料或静态清单尚无专家确认的任务级 Evidence 契约；保留治理目录检索，暂不进入财富经理 Agent Runtime。";
  }
  if (roles.includes("insurance-advisor")) {
    return "保险顾问跨岗位 Context 复用仍处于设计验证，尚无 Production Binding 与候选级 Golden Set；暂不进入 Agent Runtime。";
  }
  if (roles.includes("post-loan-risk-control")) {
    return "贷后风控尚未建立生产 Context Binding 与候选级 Golden Set；暂不进入 Agent Runtime。";
  }
  if (roles.includes("credential-compliance")) {
    return "智能审核尚未建立生产 Context Binding 与候选级 Golden Set；暂不进入 Agent Runtime。";
  }
  return "该资产尚无专家确认的 Logical Context、任务映射与候选级 Golden Set；保留治理目录检索，暂不进入 Agent Runtime。";
}

async function main() {
  const candidates = await listEnterpriseAssetCandidates({ status: "approved" });
  const pending = candidates.filter(candidate => (
    candidate.assetType === "knowledge_document"
    && !candidate.targetAssetId
    && candidate.projectionDecision === "pending"
  ));
  const plan = pending.map(candidate => {
    const metadata = enterpriseAssetMetadataSchema.parse(candidate.confirmedMetadataJson);
    if (metadata.lifecycle !== "active") {
      throw new Error(`${candidate.candidateId} is ${metadata.lifecycle}; migration should classify it as archived before this operation`);
    }
    const confirmedMetadata = enterpriseAssetMetadataSchema.parse({
      ...metadata,
      logicalAssetIds: [],
      relatedTasks: [],
    });
    const decisionReason = classificationReason(confirmedMetadata.applicableRoles);
    const impact = analyzeEnterpriseAssetImpact({
      assetType: candidate.assetType,
      enterpriseAssetId: candidate.enterpriseAssetId,
      sourceVersion: candidate.sourceVersion,
      checksum: candidate.checksum,
      metadata: confirmedMetadata,
    });
    return { candidate, confirmedMetadata, decisionReason, impact };
  });

  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    pendingApprovedAssets: plan.length,
    decision: "searchable_only",
    candidates: plan.map(item => ({
      candidateId: item.candidate.candidateId,
      assetId: item.candidate.enterpriseAssetId,
      name: item.candidate.displayName,
      roles: item.confirmedMetadata.applicableRoles,
      reason: item.decisionReason,
    })),
  }, null, 2));
  if (!apply) return;

  for (const item of plan) {
    const decidedAt = new Date().toISOString();
    await classifyEnterpriseKnowledgeCandidate({
      candidateId: item.candidate.candidateId,
      decision: "searchable_only",
      reason: item.decisionReason,
      confirmedMetadataJson: item.confirmedMetadata,
      impactAnalysisJson: {
        ...item.impact,
        runtimeClassification: {
          schema: "ea.runtime-classification.v1",
          decision: "searchable_only",
          decisionReason: item.decisionReason,
          logicalAssetIds: [],
          relatedTasks: [],
          decidedBy: actor,
          decidedAt,
        },
      },
      actor,
    });
    await recordAuditRequired({
      action: "enterprise_asset.runtime_classified",
      result: "success",
      severity: "high",
      actorType: "system",
      actorName: actor,
      targetType: "enterprise_asset_candidate",
      targetId: item.candidate.candidateId,
      resourceType: "enterprise_asset",
      resourceId: item.candidate.enterpriseAssetId,
      source: "controlled_operation",
      metadata: {
        decision: "searchable_only",
        decisionReason: item.decisionReason,
        logicalAssetIds: [],
        relatedTasks: [],
      },
    });
  }

  const after = await listEnterpriseAssetCandidates({ status: "approved" });
  const unresolved = after.filter(candidate => (
    candidate.assetType === "knowledge_document"
    && !candidate.targetAssetId
    && candidate.projectionDecision === "pending"
  ));
  if (unresolved.length) throw new Error(`${unresolved.length} approved knowledge assets remain unclassified`);
  console.log(JSON.stringify({ status: "PASS", classified: plan.length, unclassifiedApprovedAssets: 0 }, null, 2));
}

main()
  .then(async () => closeDbConnection())
  .catch(async error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    await closeDbConnection().catch(() => undefined);
  });
