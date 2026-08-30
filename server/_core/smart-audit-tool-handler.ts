import type { Request } from "express";
import { auditRequest, recordAuditBestEffort } from "./audit-events";
import { attachContextReceipt, buildContextReceipt } from "./governance/context-receipt";
import { governanceFingerprint, principalFingerprint, type RuntimePrincipal } from "./governance/contracts";
import {
  evaluateAuditHumanReviewGate,
  evaluateAuditRequiredMaterials,
  evaluateAuditRuleVersionEligibility,
  type AuditRuleCandidate,
} from "./smart-audit-policy";

export const SMART_AUDIT_REQUIRED_MATERIALS_TOOL = {
  name: "evaluate_audit_required_materials",
  description: "仅在当前有效规则或用户已明确给出必需材料清单时，执行确定性的材料完整性检查。required_material_types 必须逐项来自该清单；没有清单时不得调用，也不得使用模型自建的通用清单。不得据此自动形成最终审批结论。",
  inputSchema: {
    type: "object",
    properties: {
      required_material_types: { type: "array", description: "当前有效规则或用户明确给出的必需材料原文；禁止模型补充通用材料", items: { type: "string" } },
      provided_material_types: { type: "array", description: "当前案件已实际提供的材料", items: { type: "string" } },
      unreadable_material_types: { type: "array", items: { type: "string" } },
    },
    required: ["required_material_types", "provided_material_types"],
  },
} as const;

export const SMART_AUDIT_RULE_ELIGIBILITY_TOOL = {
  name: "evaluate_audit_rule_eligibility",
  description: "核验审核规则版本是否对当前岗位和时间有效，只允许采用当前生效规则并排除历史或未生效版本。",
  inputSchema: {
    type: "object",
    properties: {
      as_of: { type: "string", description: "ISO 8601 核验时间" },
      candidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            asset_id: { type: "string" },
            version_label: { type: "string" },
            lifecycle: { type: "string", enum: ["draft", "active", "expired", "retired"] },
            effective_at: { type: "string" },
            expires_at: { type: ["string", "null"] },
            applicable_roles: { type: "array", items: { type: "string" } },
          },
          required: ["asset_id", "version_label", "lifecycle", "effective_at", "applicable_roles"],
        },
      },
    },
    required: ["as_of", "candidates"],
  },
} as const;

export const SMART_AUDIT_HUMAN_REVIEW_TOOL = {
  name: "evaluate_audit_human_review",
  description: "根据已核验的关键缺件、可比字段冲突、当前规则状态和影像不确定性执行人工复核分级。口径或期间不可比不得填关键冲突；没有明确高风险规则不得填高风险命中；缺少某项阈值不等于规则版本不可用。该工具只分级和给出义务，不执行最终审批。",
  inputSchema: {
    type: "object",
    properties: {
      critical_missing: { type: "boolean", description: "仅当当前有效材料清单已明确要求且关键材料确实缺失时为 true；没有清单时为 false" },
      critical_conflicts: { type: "boolean", description: "仅当主体、期间和口径可比且冲突已成立时为 true；不可比或待解释时为 false" },
      rule_version_ready: { type: "boolean", description: "当前人工复核规则是否可用。只有上游明确返回当前规则不可用时才为 false；用户请求未展示材料清单或某项差异阈值时仍为 true" },
      image_verification_uncertain: { type: "boolean", description: "仅当本轮真实影像核验存在不确定性时为 true" },
      high_risk_rule_hit: { type: "boolean", description: "仅当当前有效规则明确命中高风险条件时为 true；没有阈值或仅有数值差异时为 false" },
      final_decision_requested: { type: "boolean", description: "仅当用户明确要求通过、拒绝或授信调整等最终审批决定时为 true；分析和工作意见为 false" },
    },
    required: ["critical_missing", "critical_conflicts", "rule_version_ready", "image_verification_uncertain", "high_risk_rule_hit", "final_decision_requested"],
  },
} as const;

export const SMART_AUDIT_TOOLS = [
  SMART_AUDIT_REQUIRED_MATERIALS_TOOL,
  SMART_AUDIT_RULE_ELIGIBILITY_TOOL,
  SMART_AUDIT_HUMAN_REVIEW_TOOL,
] as const;

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function bool(args: Record<string, unknown>, snake: string, camel: string): boolean {
  return args[snake] === true || args[camel] === true;
}

function requestId(req: Request): string {
  return String(req.headers["x-request-id"] || req.headers["x-correlation-id"] || "").trim();
}

function ruleCandidates(value: unknown): AuditRuleCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const candidate = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    return {
      assetId: String(candidate.asset_id || candidate.assetId || ""),
      versionLabel: String(candidate.version_label || candidate.versionLabel || ""),
      lifecycle: String(candidate.lifecycle || "draft") as AuditRuleCandidate["lifecycle"],
      effectiveAt: String(candidate.effective_at || candidate.effectiveAt || ""),
      expiresAt: candidate.expires_at === null || candidate.expiresAt === null
        ? null
        : String(candidate.expires_at || candidate.expiresAt || "") || null,
      applicableRoles: list(candidate.applicable_roles || candidate.applicableRoles),
    };
  }).filter((candidate) => candidate.assetId && candidate.versionLabel && candidate.effectiveAt);
}

export async function handleSmartAuditTool(input: {
  req: Request;
  name: string;
  args: Record<string, unknown>;
  adoptId: string;
  principal: RuntimePrincipal;
}) {
  const { req, name, args, adoptId, principal } = input;
  let taskId = "AU-GT-03";
  let taskLabel = "材料完整性与相关性审核";
  let decision: ReturnType<typeof evaluateAuditRequiredMaterials> | ReturnType<typeof evaluateAuditRuleVersionEligibility> | ReturnType<typeof evaluateAuditHumanReviewGate>;
  let modelResult: Record<string, unknown>;
  if (name === SMART_AUDIT_REQUIRED_MATERIALS_TOOL.name) {
    decision = evaluateAuditRequiredMaterials({
      roleTemplate: principal.roleTemplate,
      requiredMaterialTypes: list(args.required_material_types ?? args.requiredMaterialTypes),
      providedMaterialTypes: list(args.provided_material_types ?? args.providedMaterialTypes),
      unreadableMaterialTypes: list(args.unreadable_material_types ?? args.unreadableMaterialTypes),
    });
    modelResult = {
      status: decision.status,
      provided: decision.provided,
      missing: decision.missing,
      needsCorrection: decision.needsCorrection,
      formalReviewAllowed: decision.formalReviewAllowed,
    };
  } else if (name === SMART_AUDIT_RULE_ELIGIBILITY_TOOL.name) {
    taskId = "AU-GT-04";
    taskLabel = "现行审核规则核验";
    decision = evaluateAuditRuleVersionEligibility({
      roleTemplate: principal.roleTemplate,
      candidates: ruleCandidates(args.candidates),
      asOf: String(args.as_of || args.asOf || ""),
    });
    modelResult = {
      status: decision.status,
      selectedAssetIds: decision.selectedAssetIds,
      excluded: decision.excluded,
      formalRuleUseAllowed: decision.formalRuleUseAllowed,
    };
  } else {
    taskId = "AU-GT-06";
    taskLabel = "审核意见与人工复核闭环";
    decision = evaluateAuditHumanReviewGate({
      roleTemplate: principal.roleTemplate,
      criticalMissing: bool(args, "critical_missing", "criticalMissing"),
      criticalConflicts: bool(args, "critical_conflicts", "criticalConflicts"),
      ruleVersionReady: bool(args, "rule_version_ready", "ruleVersionReady"),
      imageVerificationUncertain: bool(args, "image_verification_uncertain", "imageVerificationUncertain"),
      highRiskRuleHit: bool(args, "high_risk_rule_hit", "highRiskRuleHit"),
      finalDecisionRequested: bool(args, "final_decision_requested", "finalDecisionRequested"),
    });
    modelResult = {
      status: decision.status,
      level: decision.level,
      triggers: decision.triggers,
      formalOpinionAllowed: decision.formalOpinionAllowed,
      humanReviewRequired: decision.humanReviewRequired,
      requiredActions: decision.requiredActions,
    };
  }
  const ready = decision.status === "ready";
  const receipt = buildContextReceipt({
    taskId,
    taskLabel,
    principalFingerprint: principalFingerprint(principal),
    provided: {
      knowledge: [],
      businessData: [],
      memory: [],
      capabilities: [{ capabilityId: name, label: taskLabel, version: "1", sideEffect: "compute" }],
    },
    policyDecisions: [{
      decisionId: decision.decisionId,
      policyCode: decision.policyCode,
      ruleVersion: decision.ruleVersion,
      effect: ready ? "ALLOW" : "DENY",
    }],
    capabilityExecutions: [{
      capabilityId: name,
      label: taskLabel,
      operation: name,
      status: ready ? "completed" : "blocked",
      requestId: requestId(req) || decision.decisionId,
    }],
    readiness: {
      status: ready ? "READY" : "BLOCKED",
      requestedOutcome: taskId === "AU-GT-06" ? "controlled_audit_opinion" : "controlled_audit_assessment",
      allowedOutcomes: "allowedOutcomes" in decision ? decision.allowedOutcomes : ready ? ["audit_working_draft"] : ["verified_fact_summary"],
      deniedOutcomes: "deniedOutcomes" in decision ? decision.deniedOutcomes : ready ? ["automatic_final_approval"] : ["formal_audit_opinion", "automatic_final_approval"],
      reasons: "triggers" in decision ? decision.triggers : ready ? ["DETERMINISTIC_POLICY_READY"] : ["DETERMINISTIC_POLICY_BLOCKED"],
      remediation: "requiredActions" in decision ? decision.requiredActions : ready ? [] : ["补齐条件后重新核验"],
      presentation: {
        completed: ready ? [`已完成${taskLabel}`] : ["已保留可核验事实"],
        unavailable: ready ? ["不执行最终审批"] : ["暂不能形成正式审核意见"],
        nextSteps: "requiredActions" in decision ? decision.requiredActions : ready ? [] : ["补齐条件后重新核验"],
      },
      decisionFingerprint: governanceFingerprint(decision),
    },
  });
  await recordAuditBestEffort({
    action: ready ? "governance.smart_audit.evaluated" : "governance.smart_audit.blocked",
    result: ready ? "success" : "denied",
    severity: ready ? "medium" : "high",
    actorType: "agent",
    actorUserId: principal.userId || null,
    actorRole: principal.roleTemplate,
    targetType: "smart_audit_policy",
    targetId: decision.decisionId,
    agentInstanceId: adoptId,
    runtimeAgentId: principal.agentId,
    sessionId: principal.sessionId,
    toolName: name,
    policyCode: decision.policyCode,
    source: "platform_tools_mcp",
    ...auditRequest(req),
    metadata: { taskId, ruleVersion: decision.ruleVersion },
  });
  return attachContextReceipt({
    content: [{ type: "text", text: `EA_SMART_AUDIT_DECISION:${JSON.stringify(modelResult)}` }],
  }, receipt);
}
