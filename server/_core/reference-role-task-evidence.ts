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

function postLoanReadProfiles(input: {
  taskId: string;
  taskLabel: string;
  requestedOutcome: string;
  fallbackOutcome: string;
  tools: Array<{ name: string; label: string }>;
}): RoleTaskEvidenceProfile[] {
  return input.tools.map((tool) => ({
    roleTemplate: "post-loan-risk-control",
    serverId: "post_loan_risk_data",
    toolName: tool.name,
    taskId: input.taskId,
    taskLabel: input.taskLabel,
    requestedOutcome: input.requestedOutcome,
    requiredChecks: ["identity", "policy", "capability", "receipt", "evidence"],
    fallbackOutcomes: [input.fallbackOutcome],
    capabilityLabel: tool.label,
    sourceLabel: "当前授权企业贷后数据",
    outcomeLabels: {
      [input.requestedOutcome]: input.taskLabel,
      [input.fallbackOutcome]: "已核验事实和数据补充清单",
    },
  }));
}

const profiles: RoleTaskEvidenceProfile[] = [
  ...postLoanReadProfiles({
    taskId: "RC-GT-01",
    taskLabel: "企业贷后全景核查",
    requestedOutcome: "verified_post_loan_panorama",
    fallbackOutcome: "post_loan_minimum_input_checklist",
    tools: [
      { name: "get_enterprise_profile", label: "查询企业画像" },
      { name: "get_loan_account", label: "查询贷款账户" },
      { name: "get_credit_rating", label: "查询信用评级" },
    ],
  }),
  ...postLoanReadProfiles({
    taskId: "RC-GT-02",
    taskLabel: "财务与还款异常诊断",
    requestedOutcome: "verified_financial_repayment_diagnosis",
    fallbackOutcome: "financial_repayment_gap_checklist",
    tools: [
      { name: "get_financial_statements", label: "查询企业财务报表" },
      { name: "get_repayment_history", label: "查询企业还款历史" },
    ],
  }),
  ...postLoanReadProfiles({
    taskId: "RC-GT-03",
    taskLabel: "押品与担保风险检查",
    requestedOutcome: "verified_collateral_guarantee_check",
    fallbackOutcome: "collateral_guarantee_gap_checklist",
    tools: [
      { name: "get_collateral_info", label: "查询抵质押物信息" },
      { name: "get_guarantor_info", label: "查询担保人信息" },
    ],
  }),
  ...postLoanReadProfiles({
    taskId: "RC-GT-04",
    taskLabel: "外部风险事件核验",
    requestedOutcome: "verified_external_risk_events",
    fallbackOutcome: "external_risk_verification_checklist",
    tools: [
      { name: "get_judicial_info", label: "查询司法信息" },
      { name: "get_public_opinion", label: "查询公开舆情" },
      { name: "get_business_abnormal", label: "查询经营异常" },
      { name: "get_tax_info", label: "查询税务信息" },
      { name: "get_dishonest_record", label: "查询失信记录" },
    ],
  }),
  ...postLoanReadProfiles({
    taskId: "RC-GT-05",
    taskLabel: "综合预警分级与评估报告",
    requestedOutcome: "verified_industry_risk_context",
    fallbackOutcome: "industry_context_gap_checklist",
    tools: [
      { name: "get_industry_benchmark", label: "查询行业基准" },
      { name: "get_industry_rating", label: "查询行业风险评级" },
      { name: "get_macro_indicator", label: "查询宏观指标" },
    ],
  }),
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
  {
    roleTemplate: "post-loan-risk-control",
    serverId: "wealth_governance_demo",
    toolName: "demo_create_followup_task",
    taskId: "RC-GT-06",
    taskLabel: "风险复评与跟踪任务",
    requestedOutcome: "confirmed_risk_followup_write",
    requiredChecks: ["identity", "policy", "capability", "approval", "idempotency", "receipt", "evidence"],
    fallbackOutcomes: ["risk_followup_draft", "confirmation_request"],
    capabilityLabel: "创建风险复评跟踪任务（Demo）",
    outcomeLabels: {
      confirmed_risk_followup_write: "创建风险复评跟踪任务",
      risk_followup_draft: "风险复评任务草稿",
      confirmation_request: "操作确认请求",
    },
  },
  {
    roleTemplate: "credential-compliance",
    serverId: "credential_image_workspace",
    toolName: "credential_image_extract_from_workspace",
    taskId: "AU-GT-02",
    taskLabel: "凭证要素提取与原文定位",
    requestedOutcome: "verified_credential_fields",
    requiredChecks: ["identity", "policy", "capability", "receipt", "evidence"],
    fallbackOutcomes: ["credential_manual_extraction_checklist"],
    capabilityLabel: "提取凭证要素和原文定位",
    sourceLabel: "当前岗位工作区凭证材料",
    outcomeLabels: {
      verified_credential_fields: "已提取凭证要素和原文位置",
      credential_manual_extraction_checklist: "凭证人工提取检查表",
    },
  },
  {
    roleTemplate: "credential-compliance",
    serverId: "wealth_governance_demo",
    toolName: "demo_create_audit_review_task",
    taskId: "AU-GT-06",
    taskLabel: "审核意见与人工复核闭环",
    requestedOutcome: "confirmed_audit_review_write",
    requiredChecks: ["identity", "policy", "capability", "approval", "idempotency", "receipt", "evidence"],
    fallbackOutcomes: ["audit_review_draft", "confirmation_request"],
    capabilityLabel: "创建审核人工复核任务（Demo）",
    outcomeLabels: {
      confirmed_audit_review_write: "创建审核人工复核任务",
      audit_review_draft: "人工复核任务草稿",
      confirmation_request: "操作确认请求",
    },
  },
  {
    roleTemplate: "investment-researcher",
    serverId: "wind_stock_data",
    toolName: "get_stock_basicinfo",
    taskId: "IR-GT-01",
    taskLabel: "公司快速研究",
    requestedOutcome: "verified_company_first_look",
    requiredChecks: ["identity", "policy", "capability", "receipt", "evidence"],
    fallbackOutcomes: ["company_research_minimum_input_checklist"],
    capabilityLabel: "查询公司基本档案",
    sourceLabel: "当前授权 Wind 公司数据",
    outcomeLabels: { verified_company_first_look: "已核实公司基础事实", company_research_minimum_input_checklist: "公司研究最小输入清单" },
  },
  {
    roleTemplate: "investment-researcher",
    serverId: "wind_stock_data",
    toolName: "get_stock_fundamentals",
    taskId: "IR-GT-02",
    taskLabel: "最新财报复盘",
    requestedOutcome: "verified_earnings_review",
    requiredChecks: ["identity", "policy", "capability", "receipt", "evidence"],
    fallbackOutcomes: ["earnings_data_gap_checklist"],
    capabilityLabel: "查询公司财务数据",
    sourceLabel: "当前授权 Wind 财务数据",
    outcomeLabels: { verified_earnings_review: "已核实财报和盈利质量", earnings_data_gap_checklist: "财报数据缺口清单" },
  },
  {
    roleTemplate: "investment-researcher",
    serverId: "wind_analytics_data",
    toolName: "get_financial_data",
    taskId: "IR-GT-03",
    taskLabel: "公司与同业比较",
    requestedOutcome: "verified_peer_comparison",
    requiredChecks: ["identity", "policy", "capability", "receipt", "evidence"],
    fallbackOutcomes: ["peer_comparison_gap_checklist"],
    capabilityLabel: "查询可比公司结构化数据",
    sourceLabel: "当前授权 Wind 综合金融数据",
    outcomeLabels: { verified_peer_comparison: "已完成同口径同业比较", peer_comparison_gap_checklist: "同业比较数据缺口清单" },
  },
  {
    roleTemplate: "investment-researcher",
    serverId: "wind_stock_data",
    toolName: "get_risk_metrics",
    taskId: "IR-GT-04",
    taskLabel: "估值与风险核验",
    requestedOutcome: "verified_valuation_risk_assessment",
    requiredChecks: ["identity", "policy", "capability", "receipt", "evidence"],
    fallbackOutcomes: ["valuation_risk_gap_checklist"],
    capabilityLabel: "查询证券风险指标",
    sourceLabel: "当前授权 Wind 风险数据",
    outcomeLabels: { verified_valuation_risk_assessment: "已核实估值和风险指标", valuation_risk_gap_checklist: "估值风险数据缺口清单" },
  },
  {
    roleTemplate: "investment-researcher",
    serverId: "wind_financial_docs",
    toolName: "get_company_announcements",
    taskId: "IR-GT-05",
    taskLabel: "公告与事件影响",
    requestedOutcome: "verified_event_impact_analysis",
    requiredChecks: ["identity", "policy", "capability", "receipt", "evidence"],
    fallbackOutcomes: ["event_source_gap_checklist"],
    capabilityLabel: "查询公司正式公告",
    sourceLabel: "当前授权 Wind 公告数据",
    outcomeLabels: { verified_event_impact_analysis: "已核实公告和事件影响", event_source_gap_checklist: "事件原始来源缺口清单" },
  },
  {
    roleTemplate: "investment-researcher",
    serverId: "wealth_governance_demo",
    toolName: "demo_create_research_watch_task",
    taskId: "IR-GT-06",
    taskLabel: "研究备忘与跟踪",
    requestedOutcome: "confirmed_research_watch_write",
    requiredChecks: ["identity", "policy", "capability", "approval", "idempotency", "receipt", "evidence"],
    fallbackOutcomes: ["research_watch_draft", "confirmation_request"],
    capabilityLabel: "创建研究跟踪任务（Demo）",
    outcomeLabels: { confirmed_research_watch_write: "创建研究跟踪任务", research_watch_draft: "研究跟踪任务草稿", confirmation_request: "操作确认请求" },
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
