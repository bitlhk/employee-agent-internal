import type { ContextReceiptV1 } from "../../shared/context-receipt";
import { attachContextReceipt, buildContextReceipt } from "./governance/context-receipt";
import { evaluateTaskReadiness, readinessCheck, type TaskReadinessProfile } from "./governance/task-readiness";

type RoleTaskEvidenceProfile = TaskReadinessProfile & {
  roleTemplate: string;
  serverId: string;
  toolName: string;
  taskLabel: string;
  capabilityLabel: string;
  sourceLabel?: string;
  outcomeLabels: Record<string, string>;
};

const profiles: RoleTaskEvidenceProfile[] = [
  {
    roleTemplate: "insurance-advisor",
    serverId: "insurance_customer_profile",
    toolName: "list_customer_profiles",
    taskId: "IA-GT-01",
    taskLabel: "客户续保访前准备",
    requestedOutcome: "verified_insurance_customer_context",
    requiredChecks: ["identity", "policy", "capability", "receipt", "evidence"],
    fallbackOutcomes: ["insurance_previsit_minimum_input_checklist"],
    capabilityLabel: "查询负责客户列表",
    sourceLabel: "当前保险客户画像",
    outcomeLabels: {
      verified_insurance_customer_context: "已核实保险客户现场",
      insurance_previsit_minimum_input_checklist: "保险访前最小输入清单",
    },
  },
  {
    roleTemplate: "insurance-advisor",
    serverId: "insurance_customer_profile",
    toolName: "get_customer_profile_by_name",
    taskId: "IA-GT-01",
    taskLabel: "客户续保访前准备",
    requestedOutcome: "verified_insurance_customer_context",
    requiredChecks: ["identity", "policy", "capability", "receipt", "evidence"],
    fallbackOutcomes: ["insurance_previsit_minimum_input_checklist"],
    capabilityLabel: "查询保险客户画像",
    sourceLabel: "当前保险客户画像",
    outcomeLabels: {
      verified_insurance_customer_context: "已核实保险客户现场",
      insurance_previsit_minimum_input_checklist: "保险访前最小输入清单",
    },
  },
  {
    roleTemplate: "insurance-advisor",
    serverId: "insurance_product_exam_points",
    toolName: "list_products",
    taskId: "IA-GT-02",
    taskLabel: "保障缺口分析与产品匹配",
    requestedOutcome: "verified_insurance_product_candidates",
    requiredChecks: ["identity", "policy", "capability", "receipt", "evidence"],
    fallbackOutcomes: ["insurance_product_screening_criteria"],
    capabilityLabel: "查询保险产品池",
    sourceLabel: "当前保险产品池",
    outcomeLabels: {
      verified_insurance_product_candidates: "已核实保险产品候选",
      insurance_product_screening_criteria: "保险产品筛选条件",
    },
  },
  {
    roleTemplate: "insurance-advisor",
    serverId: "insurance_product_exam_points",
    toolName: "search_products",
    taskId: "IA-GT-02",
    taskLabel: "保障缺口分析与产品匹配",
    requestedOutcome: "verified_insurance_product_candidates",
    requiredChecks: ["identity", "policy", "capability", "receipt", "evidence"],
    fallbackOutcomes: ["insurance_product_screening_criteria"],
    capabilityLabel: "筛选保险产品",
    sourceLabel: "当前保险产品池",
    outcomeLabels: {
      verified_insurance_product_candidates: "已核实保险产品候选",
      insurance_product_screening_criteria: "保险产品筛选条件",
    },
  },
  {
    roleTemplate: "insurance-advisor",
    serverId: "insurance_product_exam_points",
    toolName: "get_product_detail",
    taskId: "IA-GT-03",
    taskLabel: "产品详情解释与对比",
    requestedOutcome: "verified_insurance_product_explanation",
    requiredChecks: ["identity", "policy", "capability", "receipt", "evidence"],
    fallbackOutcomes: ["insurance_product_detail_unavailable_guidance"],
    capabilityLabel: "核验保险产品详情",
    sourceLabel: "当前保险产品详情",
    outcomeLabels: {
      verified_insurance_product_explanation: "已核实保险产品说明",
      insurance_product_detail_unavailable_guidance: "产品详情补充指引",
    },
  },
  {
    roleTemplate: "insurance-advisor",
    serverId: "insurance_product_exam_points",
    toolName: "get_exam_points",
    taskId: "IA-GT-05",
    taskLabel: "销售对话陪练与阶段评分",
    requestedOutcome: "verified_insurance_training_points",
    requiredChecks: ["identity", "policy", "capability", "receipt", "evidence"],
    fallbackOutcomes: ["insurance_training_generic_checklist"],
    capabilityLabel: "查询保险培训考点",
    sourceLabel: "当前保险培训考点",
    outcomeLabels: {
      verified_insurance_training_points: "已核实保险培训考点",
      insurance_training_generic_checklist: "保险陪练通用检查表",
    },
  },
  {
    roleTemplate: "wealth-manager",
    serverId: "wealth_governance_demo",
    toolName: "demo_create_followup_task",
    taskId: "WM-GT-05",
    taskLabel: "客户跟进创建",
    requestedOutcome: "confirmed_business_followup_write",
    requiredChecks: ["identity", "policy", "capability", "approval", "idempotency", "receipt", "evidence"],
    fallbackOutcomes: ["followup_draft", "confirmation_request"],
    capabilityLabel: "创建客户跟进任务（Demo）",
    outcomeLabels: {
      confirmed_business_followup_write: "创建客户跟进任务",
      followup_draft: "客户跟进草稿",
      confirmation_request: "操作确认请求",
    },
  },
  {
    roleTemplate: "insurance-advisor",
    serverId: "wealth_governance_demo",
    toolName: "demo_create_followup_task",
    taskId: "IA-GT-01",
    taskLabel: "客户续保访前准备",
    requestedOutcome: "confirmed_insurance_followup_write",
    requiredChecks: ["identity", "policy", "capability", "approval", "idempotency", "receipt", "evidence"],
    fallbackOutcomes: ["insurance_followup_draft", "confirmation_request"],
    capabilityLabel: "创建保险客户跟进任务（Demo）",
    outcomeLabels: {
      confirmed_insurance_followup_write: "创建保险客户跟进任务",
      insurance_followup_draft: "保险客户跟进草稿",
      confirmation_request: "操作确认请求",
    },
  },
];

export function resolveRoleTaskEvidenceProfile(
  roleTemplate: string,
  serverId: string,
  toolName: string,
): RoleTaskEvidenceProfile | null {
  return profiles.find((profile) => (
    profile.roleTemplate === roleTemplate
    && profile.serverId === serverId
    && profile.toolName === toolName
  )) || null;
}

export function attachReferenceRoleTaskReceipt<T extends Record<string, unknown>>(input: {
  result: T;
  roleTemplate: string;
  serverId: string;
  toolName: string;
  principalFingerprint: string;
  sideEffect: string;
  capabilityVersion: string;
  policyDecision: { decisionId: string; policyCode: string; ruleVersion: string; effect: "ALLOW" | "DENY" | "REQUIRE_APPROVAL" };
  requestId: string;
  resultFingerprint: string;
  argumentsFingerprint: string;
  failed: boolean;
  externalRequestId?: string | null;
  approvalId?: string | null;
  idempotencyProtected?: boolean;
  now?: Date;
}): T {
  const profile = resolveRoleTaskEvidenceProfile(input.roleTemplate, input.serverId, input.toolName);
  if (!profile) return input.result;
  const now = input.now || new Date();
  const success = !input.failed;
  const checks = {
    identity: readinessCheck("READY", "PRINCIPAL_READY", "岗位身份和授权范围已核验。"),
    policy: readinessCheck("READY", "CAPABILITY_POLICY_APPLIED", "岗位能力策略已执行。"),
    capability: success
      ? readinessCheck("READY", "CAPABILITY_COMPLETED", "岗位能力已完成。")
      : readinessCheck("BLOCKED", "CAPABILITY_FAILED", "岗位能力执行失败。", { retryable: true }),
    approval: input.sideEffect === "read" || input.approvalId
      ? readinessCheck("READY", input.approvalId ? "HUMAN_CONFIRMATION_CONSUMED" : "APPROVAL_NOT_REQUIRED", input.approvalId ? "操作确认已绑定并消费。" : "本次读取不需要操作确认。")
      : readinessCheck("BLOCKED", "HUMAN_CONFIRMATION_MISSING", "本次写入缺少有效操作确认。"),
    idempotency: input.sideEffect === "read" || input.idempotencyProtected
      ? readinessCheck("READY", input.idempotencyProtected ? "IDEMPOTENCY_RESERVED" : "IDEMPOTENCY_NOT_REQUIRED", input.idempotencyProtected ? "幂等键已绑定业务调用回执。" : "本次读取不需要幂等键。")
      : readinessCheck("BLOCKED", "IDEMPOTENCY_KEY_MISSING", "本次写入缺少幂等保护。"),
    receipt: success
      ? readinessCheck("READY", "BUSINESS_RECEIPT_COMPLETED", "业务数据或执行回执已生成。", { asOf: now.toISOString() })
      : readinessCheck("BLOCKED", "BUSINESS_RECEIPT_FAILED", "下游执行失败，可根据回执安全重试。", { retryable: true }),
    evidence: readinessCheck("READY", "EXECUTION_EVIDENCE_READY", "治理判断和执行证据已留痕。"),
  };
  const readiness = evaluateTaskReadiness({ profile, checks });
  const labels = (values: string[]) => values.map((value) => profile.outcomeLabels[value] || value);
  const receipt: Readonly<ContextReceiptV1> = buildContextReceipt({
    taskId: profile.taskId,
    taskLabel: profile.taskLabel,
    principalFingerprint: input.principalFingerprint,
    provided: {
      knowledge: [],
      businessData: profile.sourceLabel ? [{
        sourceSystem: input.serverId,
        label: profile.sourceLabel,
        entityRef: input.argumentsFingerprint,
        asOf: now.toISOString(),
        resultFingerprint: input.resultFingerprint,
      }] : [],
      memory: [],
      capabilities: [{
        capabilityId: input.toolName,
        label: profile.capabilityLabel,
        version: input.capabilityVersion,
        sideEffect: input.sideEffect,
      }],
    },
    policyDecisions: [input.policyDecision],
    capabilityExecutions: [{
      capabilityId: input.toolName,
      label: profile.capabilityLabel,
      operation: input.toolName,
      status: success ? "completed" : "failed",
      requestId: input.requestId,
      ...(input.externalRequestId ? { externalRequestId: input.externalRequestId } : {}),
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      idempotencyProtected: Boolean(input.idempotencyProtected),
    }],
    readiness: {
      status: readiness.status,
      requestedOutcome: readiness.requestedOutcome,
      allowedOutcomes: readiness.allowedOutcomes,
      deniedOutcomes: readiness.deniedOutcomes,
      reasons: readiness.reasons,
      remediation: readiness.remediation,
      presentation: {
        completed: labels(readiness.allowedOutcomes),
        unavailable: labels(readiness.deniedOutcomes),
        nextSteps: readiness.remediation,
      },
      decisionFingerprint: readiness.decisionFingerprint,
    },
    now,
  });
  return attachContextReceipt(input.result, receipt);
}
