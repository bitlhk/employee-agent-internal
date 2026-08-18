import type { Request } from "express";
import { auditRequest, recordAuditBestEffort } from "./audit-events";
import { attachContextReceipt, buildContextReceipt } from "./governance/context-receipt";
import {
  governanceFingerprint,
  principalFingerprint,
  type RuntimePrincipal,
} from "./governance/contracts";
import { evaluatePostLoanRiskEscalation } from "./post-loan-risk-policy";

export const POST_LOAN_RISK_ESCALATION_TOOL = {
  name: "evaluate_post_loan_risk_escalation",
  description: [
    "Apply the deterministic POST_LOAN_RISK_ESCALATION policy to risk signals already verified from post_loan_risk_data.",
    "Use only for the post-loan-risk-control role after loading current enterprise, loan, repayment, collateral and external-risk facts.",
    "The result is an internal warning level and human-escalation obligation; it never changes regulatory classification, credit limits or account state.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      overdue_days: { type: "number", minimum: 0, maximum: 10000 },
      five_level_class: { type: "string", enum: ["正常", "关注", "次级", "可疑", "损失"] },
      rating_downgrade_steps: { type: "number", minimum: 0, maximum: 20 },
      major_judicial_event: { type: "boolean" },
      dishonest_enforcement: { type: "boolean" },
      core_collateral_impaired: { type: "boolean" },
      collateral_coverage_ratio: { type: "number", minimum: 0, maximum: 100 },
      operation_stopped: { type: "boolean" },
      critical_data_complete: {
        type: "boolean",
        description: "True only when enterprise identity, loan account and repayment facts are current and verified.",
      },
    },
    required: ["critical_data_complete"],
  },
} as const;

function optionalNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function requestId(req: Request): string {
  for (const name of ["x-request-id", "x-correlation-id"]) {
    const value = req.headers[name];
    const normalized = Array.isArray(value) ? String(value[0] || "").trim() : String(value || "").trim();
    if (normalized) return normalized;
  }
  return "";
}

export async function handlePostLoanRiskEscalationTool(input: {
  req: Request;
  args: Record<string, unknown>;
  adoptId: string;
  principal: RuntimePrincipal;
}) {
  const { req, args, adoptId, principal } = input;
  const decision = evaluatePostLoanRiskEscalation({
    roleTemplate: principal.roleTemplate,
    overdueDays: optionalNumber(args.overdue_days ?? args.overdueDays),
    fiveLevelClass: (["正常", "关注", "次级", "可疑", "损失"].includes(String(args.five_level_class || args.fiveLevelClass || ""))
      ? String(args.five_level_class || args.fiveLevelClass)
      : null) as "正常" | "关注" | "次级" | "可疑" | "损失" | null,
    ratingDowngradeSteps: optionalNumber(args.rating_downgrade_steps ?? args.ratingDowngradeSteps),
    majorJudicialEvent: Boolean(args.major_judicial_event ?? args.majorJudicialEvent),
    dishonestEnforcement: Boolean(args.dishonest_enforcement ?? args.dishonestEnforcement),
    coreCollateralImpaired: Boolean(args.core_collateral_impaired ?? args.coreCollateralImpaired),
    collateralCoverageRatio: optionalNumber(args.collateral_coverage_ratio ?? args.collateralCoverageRatio),
    operationStopped: Boolean(args.operation_stopped ?? args.operationStopped),
    criticalDataComplete: args.critical_data_complete === true || args.criticalDataComplete === true,
  });
  const ready = decision.status === "ready";
  const receipt = buildContextReceipt({
    taskId: "RC-GT-05",
    taskLabel: "综合预警分级与评估报告",
    principalFingerprint: principalFingerprint(principal),
    provided: {
      knowledge: [],
      businessData: [],
      memory: [],
      capabilities: [{
        capabilityId: POST_LOAN_RISK_ESCALATION_TOOL.name,
        label: "确定性贷后风险预警分级",
        version: "1",
        sideEffect: "compute",
      }],
    },
    policyDecisions: [{
      decisionId: decision.decisionId,
      policyCode: decision.policyCode,
      ruleVersion: decision.ruleVersion,
      effect: ready ? "ALLOW" : "DENY",
    }],
    capabilityExecutions: [{
      capabilityId: POST_LOAN_RISK_ESCALATION_TOOL.name,
      label: "确定性贷后风险预警分级",
      operation: POST_LOAN_RISK_ESCALATION_TOOL.name,
      status: ready ? "completed" : "blocked",
      requestId: requestId(req) || decision.decisionId,
    }],
    readiness: {
      status: ready ? "READY" : "BLOCKED",
      requestedOutcome: "formal_post_loan_warning_level",
      allowedOutcomes: ready ? ["internal_warning_level", "human_review_guidance"] : ["verified_fact_summary"],
      deniedOutcomes: ready
        ? ["automatic_credit_or_classification_change"]
        : ["formal_post_loan_warning_level", "automatic_credit_or_classification_change"],
      reasons: ready ? decision.triggers : ["关键数据或岗位身份未满足确定性分级条件。"],
      remediation: decision.requiredActions,
      presentation: {
        completed: ready ? ["已完成确定性预警分级", "已生成触发规则和人工复核要求"] : ["已保留可核验事实"],
        unavailable: ready ? ["不执行授信、分类或账户变更"] : ["暂不能形成正式预警等级"],
        nextSteps: decision.requiredActions,
      },
      decisionFingerprint: governanceFingerprint(decision),
    },
  });
  await recordAuditBestEffort({
    action: ready ? "governance.post_loan_risk.evaluated" : "governance.post_loan_risk.blocked",
    result: ready ? "success" : "denied",
    severity: decision.level === "RED" ? "high" : ready ? "medium" : "high",
    actorType: "agent",
    actorUserId: principal.userId || null,
    actorRole: principal.roleTemplate,
    targetType: "post_loan_risk_policy",
    targetId: decision.decisionId,
    agentInstanceId: adoptId,
    runtimeAgentId: principal.agentId,
    sessionId: principal.sessionId,
    toolName: POST_LOAN_RISK_ESCALATION_TOOL.name,
    policyCode: decision.policyCode,
    source: "platform_tools_mcp",
    ...auditRequest(req),
    metadata: {
      ruleVersion: decision.ruleVersion,
      level: decision.level,
      triggers: decision.triggers,
      requiresHumanEscalation: decision.requiresHumanEscalation,
    },
  });
  return attachContextReceipt({
    content: [{
      type: "text",
      text: `EA_POST_LOAN_RISK_DECISION:${JSON.stringify({
        status: decision.status,
        level: decision.level,
        triggers: decision.triggers,
        requiredActions: decision.requiredActions,
        requiresHumanEscalation: decision.requiresHumanEscalation,
        formalConclusionAllowed: decision.formalConclusionAllowed,
      })}`,
    }],
    ...(ready ? {} : { isError: true }),
  }, receipt);
}
