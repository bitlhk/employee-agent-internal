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
  description: "对智能审核任务执行确定性的材料完整性检查，输出已提供、缺失和需补正材料。不得据此自动形成最终审批结论。",
  inputSchema: {
    type: "object",
    properties: {
      required_material_types: { type: "array", items: { type: "string" } },
      provided_material_types: { type: "array", items: { type: "string" } },
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
  description: "根据关键缺件、字段冲突、规则状态和影像不确定性执行人工复核门禁。该工具只分级和给出义务，不执行最终审批。",
  inputSchema: {
    type: "object",
    properties: {
      critical_missing: { type: "boolean" },
      critical_conflicts: { type: "boolean" },
      rule_version_ready: { type: "boolean" },
      image_verification_uncertain: { type: "boolean" },
      high_risk_rule_hit: { type: "boolean" },
      final_decision_requested: { type: "boolean" },
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
    ...(ready ? {} : { isError: true }),
  }, receipt);
}
