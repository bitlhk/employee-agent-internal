export type ToolVisualKind =
  | "agent"
  | "browser"
  | "code"
  | "database"
  | "file"
  | "image"
  | "mcp"
  | "skill"
  | "terminal"
  | "web"
  | "generic";

export function classifyToolName(name: string): ToolVisualKind {
  const normalized = String(name || "").toLowerCase().replace(/[-\s]+/g, "_");

  if (/skill|capabilit/.test(normalized)) return "skill";
  if (/mcp|connector|integration/.test(normalized)) return "mcp";
  if (/browser|navigate|screenshot|page_|computer_use/.test(normalized)) return "browser";
  if (/bash|shell|terminal|command|exec/.test(normalized)) return "terminal";
  if (/read_file|write_file|list_file|workspace|attachment|document|file/.test(normalized)) return "file";
  if (/sql|mysql|postgres|database|db_query|query_db/.test(normalized)) return "database";
  if (/image|vision|ocr|video|media/.test(normalized)) return "image";
  if (/agent|delegate|handoff|task_submit/.test(normalized)) return "agent";
  if (/python|javascript|typescript|code|script/.test(normalized)) return "code";
  if (/search|weather|news|web|fetch|http/.test(normalized)) return "web";
  return "generic";
}

const BUSINESS_TOOL_LABELS: Array<[RegExp, string]> = [
  [/prepare_wealth_previsit_context|wealth_assistant_context_probe|wealth_assistant_customer_(?:list|detail)/, "准备客户访前材料"],
  [/prepare_wealth_allocation_context/, "分析资产配置与产品适配"],
  [/get_wealth_policy_basis/, "核验现行销售政策"],
  [/prepare_wealth_maturity_context/, "分析到期客户经营机会"],
  [/list_customer_profiles|get_customer_profile_by_name/, "获取客户画像"],
  [/list_products|search_products/, "查询可用产品"],
  [/get_product_detail/, "核验产品详情"],
  [/get_exam_points/, "读取产品讲解考点"],
  [/get_enterprise_profile/, "获取企业经营画像"],
  [/get_loan_account/, "核验贷款账户"],
  [/get_financial_statements/, "分析企业财务报表"],
  [/get_repayment_history/, "核验历史还款表现"],
  [/get_collateral_info/, "核验抵质押信息"],
  [/get_guarantor_info/, "核验担保信息"],
  [/get_credit_rating/, "核验信用评级"],
  [/get_judicial_info/, "核验司法风险"],
  [/get_public_opinion/, "核验舆情风险"],
  [/get_business_abnormal/, "核验经营异常"],
  [/get_tax_info/, "核验涉税信息"],
  [/get_dishonest_record/, "核验失信记录"],
  [/get_industry_benchmark|get_industry_rating|get_macro_indicator/, "获取行业与宏观基准"],
  [/evaluate_post_loan_risk_escalation/, "评估贷后预警等级"],
  [/demo_create_followup_task|create_followup/, "创建业务跟进任务"],
  [/demo_create_portfolio_draft|create_portfolio/, "创建资产配置草稿"],
  [/group_insurance_audit/, "审核团险业务材料"],
  [/credential|voucher/, "审核凭证材料"],
  [/skill_complete/, "完成技能任务"],
  [/skill_tool|load_skill|read_skill/, "加载岗位技能"],
  [/memory_search/, "查找岗位记忆"],
  [/web_search/, "检索公开信息"],
  [/web_fetch/, "读取网页来源"],
];

export function businessToolLabel(name: string, rawArguments = ""): string {
  const normalized = String(name || "tool").toLowerCase().replace(/[-\s]+/g, "_");
  for (const [pattern, label] of BUSINESS_TOOL_LABELS) {
    if (pattern.test(normalized)) return label;
  }
  const argumentsText = String(rawArguments || "").toLowerCase();
  if (/^(?:read|read_file|list_files|glob)$/.test(normalized) && /skills?\//.test(argumentsText)) return "读取技能资料";
  if (/^(?:bash|shell|exec_command)$/.test(normalized) && /skills?\//.test(argumentsText)) return "运行技能步骤";
  return "";
}
