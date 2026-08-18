export type CapabilityProof = {
  owner: "employee-agent" | "enterprise-mcp";
  implementation: string;
  test: string;
  additionalEvidence?: string[];
};

export type ReferenceRolePackDefinition = {
  key: string;
  rolePackId: string;
  roleTemplate: string;
  packDirectory: string;
  taskPrefix: string;
  taskCount: number;
  evalSuiteVersion: string;
  knowledgeSourceDirectory: string;
  legacyKnowledgeBaseNames: string[];
  fallbackKnowledgeBase: {
    name: string;
    description: string;
    classification: "public" | "internal" | "sensitive" | "restricted";
    externalProcessingAllowed: boolean;
  };
  skillManifests: string[];
  capabilityProofs: Record<string, CapabilityProof>;
};

const definitions = [
  {
    key: "wealth-manager",
    rolePackId: "linggan-bank.wealth-manager",
    roleTemplate: "wealth-manager",
    packDirectory: "wealth-manager-reference-role-pack",
    taskPrefix: "WM",
    taskCount: 6,
    evalSuiteVersion: "wm-golden-task-v3",
    knowledgeSourceDirectory: "examples/financial-enterprise-knowledge-demo",
    legacyKnowledgeBaseNames: ["财富经理岗位知识（演示）"],
    fallbackKnowledgeBase: {
      name: "财富经理岗位操作规范（演示）",
      description: "财富经理岗位内部操作口径、访前准备、销售规范与官方监管法规。",
      classification: "internal",
      externalProcessingAllowed: true,
    },
    skillManifests: [
      "skills/privbank-previsit/manifest.json",
      "skills/wealth-manager-assistant/manifest.json",
    ],
    capabilityProofs: {
      prepare_wealth_previsit_context: { owner: "employee-agent", implementation: "server/_core/wealth-previsit-tool-handler.ts", test: "server/_core/wealth-previsit-context.test.ts" },
      wealth_assistant_context_probe: { owner: "enterprise-mcp", implementation: "scripts/install-wealth-manager-reference-pack.ts", test: "server/_core/wealth-manager-reference-assets.test.ts" },
      wealth_assistant_customer_detail: { owner: "enterprise-mcp", implementation: "scripts/install-wealth-manager-reference-pack.ts", test: "server/_core/wealth-manager-reference-assets.test.ts" },
      prepare_wealth_allocation_context: { owner: "employee-agent", implementation: "server/_core/wealth-allocation-context.ts", test: "server/_core/wealth-allocation-context.test.ts" },
      get_wealth_policy_basis: { owner: "employee-agent", implementation: "server/_core/wealth-policy-source.ts", test: "server/_core/wealth-policy-source.test.ts" },
      demo_create_portfolio_draft: { owner: "employee-agent", implementation: "server/_core/governance-demo-mcp.ts", test: "server/_core/governance-demo-mcp.test.ts" },
      demo_create_followup_task: { owner: "employee-agent", implementation: "server/_core/governance-demo-mcp.ts", test: "server/_core/governance-demo-mcp.test.ts" },
      prepare_wealth_maturity_context: { owner: "employee-agent", implementation: "server/_core/wealth-maturity-context.ts", test: "server/_core/wealth-maturity-context.test.ts" },
    },
  },
  {
    key: "insurance-advisor",
    rolePackId: "linggan-insurance.insurance-advisor",
    roleTemplate: "insurance-advisor",
    packDirectory: "insurance-advisor-reference-role-pack",
    taskPrefix: "IA",
    taskCount: 6,
    evalSuiteVersion: "ia-golden-task-v1",
    knowledgeSourceDirectory: "examples/insurance-advisor-reference-role-pack/knowledge/documents",
    legacyKnowledgeBaseNames: ["保险顾问岗位知识（演示）"],
    fallbackKnowledgeBase: {
      name: "保险顾问岗位操作规范（演示）",
      description: "保险顾问岗位内部操作口径、车险客户经营、产品讲解、销售陪练与合规升级规范。",
      classification: "internal",
      externalProcessingAllowed: true,
    },
    skillManifests: ["skills/auto-insurance-advisor/manifest.json"],
    capabilityProofs: {
      list_customer_profiles: { owner: "enterprise-mcp", implementation: "scripts/configure-insurance-marker-mcps.ts", test: "server/_core/insurance-advisor-reference-assets.test.ts" },
      get_customer_profile_by_name: { owner: "enterprise-mcp", implementation: "scripts/configure-insurance-marker-mcps.ts", test: "server/_core/insurance-advisor-reference-assets.test.ts" },
      list_products: { owner: "enterprise-mcp", implementation: "scripts/configure-insurance-marker-mcps.ts", test: "server/_core/insurance-advisor-reference-assets.test.ts" },
      search_products: { owner: "enterprise-mcp", implementation: "scripts/configure-insurance-marker-mcps.ts", test: "server/_core/insurance-advisor-reference-assets.test.ts" },
      get_product_detail: { owner: "enterprise-mcp", implementation: "scripts/configure-insurance-marker-mcps.ts", test: "server/_core/insurance-advisor-reference-assets.test.ts" },
      get_exam_points: { owner: "enterprise-mcp", implementation: "scripts/configure-insurance-marker-mcps.ts", test: "server/_core/insurance-advisor-reference-assets.test.ts" },
      demo_create_followup_task: { owner: "employee-agent", implementation: "server/_core/governance-demo-mcp.ts", test: "server/_core/governance-demo-mcp.test.ts" },
    },
  },
  {
    key: "post-loan-risk-control",
    rolePackId: "linggan-bank.post-loan-risk-control",
    roleTemplate: "post-loan-risk-control",
    packDirectory: "post-loan-risk-control-reference-role-pack",
    taskPrefix: "RC",
    taskCount: 6,
    evalSuiteVersion: "rc-golden-task-v1",
    knowledgeSourceDirectory: "examples/post-loan-risk-control-reference-role-pack/knowledge/documents",
    legacyKnowledgeBaseNames: ["风控经理岗位知识（演示）"],
    fallbackKnowledgeBase: {
      name: "风控经理岗位操作规范（演示）",
      description: "风控经理岗位的企业贷后核查、风险诊断、预警升级、报告和跟踪操作规范。",
      classification: "internal",
      externalProcessingAllowed: true,
    },
    skillManifests: ["skills/post-loan-risk-control-assistant/manifest.json"],
    capabilityProofs: {
      get_enterprise_profile: { owner: "enterprise-mcp", implementation: "scripts/install-post-loan-risk-control-reference-pack.ts", test: "server/_core/post-loan-risk-control-reference-assets.test.ts" },
      get_loan_account: { owner: "enterprise-mcp", implementation: "scripts/install-post-loan-risk-control-reference-pack.ts", test: "server/_core/post-loan-risk-control-reference-assets.test.ts" },
      get_financial_statements: { owner: "enterprise-mcp", implementation: "scripts/install-post-loan-risk-control-reference-pack.ts", test: "server/_core/post-loan-risk-control-reference-assets.test.ts" },
      get_repayment_history: { owner: "enterprise-mcp", implementation: "scripts/install-post-loan-risk-control-reference-pack.ts", test: "server/_core/post-loan-risk-control-reference-assets.test.ts" },
      get_collateral_info: { owner: "enterprise-mcp", implementation: "scripts/install-post-loan-risk-control-reference-pack.ts", test: "server/_core/post-loan-risk-control-reference-assets.test.ts" },
      get_guarantor_info: { owner: "enterprise-mcp", implementation: "scripts/install-post-loan-risk-control-reference-pack.ts", test: "server/_core/post-loan-risk-control-reference-assets.test.ts" },
      get_credit_rating: { owner: "enterprise-mcp", implementation: "scripts/install-post-loan-risk-control-reference-pack.ts", test: "server/_core/post-loan-risk-control-reference-assets.test.ts" },
      get_judicial_info: { owner: "enterprise-mcp", implementation: "scripts/install-post-loan-risk-control-reference-pack.ts", test: "server/_core/post-loan-risk-control-reference-assets.test.ts" },
      get_public_opinion: { owner: "enterprise-mcp", implementation: "scripts/install-post-loan-risk-control-reference-pack.ts", test: "server/_core/post-loan-risk-control-reference-assets.test.ts" },
      get_business_abnormal: { owner: "enterprise-mcp", implementation: "scripts/install-post-loan-risk-control-reference-pack.ts", test: "server/_core/post-loan-risk-control-reference-assets.test.ts" },
      get_tax_info: { owner: "enterprise-mcp", implementation: "scripts/install-post-loan-risk-control-reference-pack.ts", test: "server/_core/post-loan-risk-control-reference-assets.test.ts" },
      get_dishonest_record: { owner: "enterprise-mcp", implementation: "scripts/install-post-loan-risk-control-reference-pack.ts", test: "server/_core/post-loan-risk-control-reference-assets.test.ts" },
      get_industry_benchmark: { owner: "enterprise-mcp", implementation: "scripts/install-post-loan-risk-control-reference-pack.ts", test: "server/_core/post-loan-risk-control-reference-assets.test.ts" },
      get_industry_rating: { owner: "enterprise-mcp", implementation: "scripts/install-post-loan-risk-control-reference-pack.ts", test: "server/_core/post-loan-risk-control-reference-assets.test.ts" },
      get_macro_indicator: { owner: "enterprise-mcp", implementation: "scripts/install-post-loan-risk-control-reference-pack.ts", test: "server/_core/post-loan-risk-control-reference-assets.test.ts" },
      evaluate_post_loan_risk_escalation: {
        owner: "employee-agent",
        implementation: "server/_core/post-loan-risk-policy.ts",
        test: "server/_core/post-loan-risk-policy.test.ts",
        additionalEvidence: [
          "server/_core/post-loan-risk-tool-handler.ts",
          "server/_core/post-loan-risk-tool-handler.test.ts",
        ],
      },
      demo_create_followup_task: { owner: "employee-agent", implementation: "server/_core/governance-demo-mcp.ts", test: "server/_core/governance-demo-mcp.test.ts" },
    },
  },
  {
    key: "smart-audit",
    rolePackId: "linggan-bank.smart-audit",
    roleTemplate: "credential-compliance",
    packDirectory: "smart-audit-reference-role-pack",
    taskPrefix: "AU",
    taskCount: 6,
    evalSuiteVersion: "au-golden-task-v1",
    knowledgeSourceDirectory: "examples/smart-audit-reference-role-pack/knowledge/documents",
    legacyKnowledgeBaseNames: ["审核专员岗位知识（演示）"],
    fallbackKnowledgeBase: {
      name: "智能审核岗位操作规范（演示）",
      description: "智能审核岗位的材料受理、要素提取、规则核验、疑点分级和人工复核操作规范。",
      classification: "internal",
      externalProcessingAllowed: true,
    },
    skillManifests: ["skills/smart-audit-assistant/manifest.json"],
    capabilityProofs: {
      credential_image_extract_from_workspace: {
        owner: "enterprise-mcp",
        implementation: "scripts/install-smart-audit-reference-pack.ts",
        test: "server/_core/smart-audit-reference-assets.test.ts",
      },
      evaluate_audit_required_materials: {
        owner: "employee-agent",
        implementation: "server/_core/smart-audit-policy.ts",
        test: "server/_core/smart-audit-policy.test.ts",
        additionalEvidence: ["server/_core/smart-audit-tool-handler.ts"],
      },
      evaluate_audit_rule_eligibility: {
        owner: "employee-agent",
        implementation: "server/_core/smart-audit-policy.ts",
        test: "server/_core/smart-audit-policy.test.ts",
        additionalEvidence: ["server/_core/smart-audit-tool-handler.ts"],
      },
      evaluate_audit_human_review: {
        owner: "employee-agent",
        implementation: "server/_core/smart-audit-policy.ts",
        test: "server/_core/smart-audit-policy.test.ts",
        additionalEvidence: ["server/_core/smart-audit-tool-handler.ts"],
      },
      demo_create_audit_review_task: {
        owner: "employee-agent",
        implementation: "server/_core/governance-demo-mcp.ts",
        test: "server/_core/governance-demo-mcp.test.ts",
      },
    },
  },
  {
    key: "investment-research",
    rolePackId: "linggan-finance.investment-research",
    roleTemplate: "investment-researcher",
    packDirectory: "investment-research-reference-role-pack",
    taskPrefix: "IR",
    taskCount: 6,
    evalSuiteVersion: "ir-golden-task-v1",
    knowledgeSourceDirectory: "examples/investment-research-reference-role-pack/knowledge/documents",
    legacyKnowledgeBaseNames: ["投顾分析岗位知识（演示）"],
    fallbackKnowledgeBase: {
      name: "投顾分析岗位操作规范（演示）",
      description: "投顾分析岗位的公司研究、财报、同业、估值风险、事件跟踪和研究留痕规范。",
      classification: "internal",
      externalProcessingAllowed: true,
    },
    skillManifests: ["skills/investment-research-assistant/manifest.json"],
    capabilityProofs: {
      get_stock_basicinfo: { owner: "enterprise-mcp", implementation: "scripts/install-investment-research-reference-pack.ts", test: "server/_core/investment-research-reference-assets.test.ts" },
      get_stock_fundamentals: { owner: "enterprise-mcp", implementation: "scripts/install-investment-research-reference-pack.ts", test: "server/_core/investment-research-reference-assets.test.ts" },
      get_financial_data: { owner: "enterprise-mcp", implementation: "scripts/install-investment-research-reference-pack.ts", test: "server/_core/investment-research-reference-assets.test.ts" },
      get_risk_metrics: { owner: "enterprise-mcp", implementation: "scripts/install-investment-research-reference-pack.ts", test: "server/_core/investment-research-reference-assets.test.ts" },
      get_company_announcements: { owner: "enterprise-mcp", implementation: "scripts/install-investment-research-reference-pack.ts", test: "server/_core/investment-research-reference-assets.test.ts" },
      get_financial_news: { owner: "enterprise-mcp", implementation: "scripts/install-investment-research-reference-pack.ts", test: "server/_core/investment-research-reference-assets.test.ts" },
      evaluate_investment_research_data_assurance: {
        owner: "employee-agent",
        implementation: "server/_core/investment-research-policy.ts",
        test: "server/_core/investment-research-policy.test.ts",
        additionalEvidence: ["server/_core/investment-research-tool-handler.ts"],
      },
      evaluate_investment_research_output_boundary: {
        owner: "employee-agent",
        implementation: "server/_core/investment-research-policy.ts",
        test: "server/_core/investment-research-policy.test.ts",
        additionalEvidence: ["server/_core/investment-research-tool-handler.ts"],
      },
      demo_create_research_watch_task: { owner: "employee-agent", implementation: "server/_core/governance-demo-mcp.ts", test: "server/_core/governance-demo-mcp.test.ts" },
    },
  },
] as const satisfies readonly ReferenceRolePackDefinition[];

export const REFERENCE_ROLE_PACKS: readonly ReferenceRolePackDefinition[] = definitions;

export function referenceRolePack(key: string): ReferenceRolePackDefinition | null {
  return REFERENCE_ROLE_PACKS.find((definition) => definition.key === key) || null;
}

export function referenceRolePackForRole(roleTemplate: string): ReferenceRolePackDefinition | null {
  return REFERENCE_ROLE_PACKS.find((definition) => definition.roleTemplate === roleTemplate) || null;
}

export function referenceRoleTaskIdPattern(definition: ReferenceRolePackDefinition): RegExp {
  return new RegExp(`^(?:${expectedReferenceRoleTaskIds(definition).join("|")})$`, "u");
}

export function expectedReferenceRoleTaskIds(definition: ReferenceRolePackDefinition): string[] {
  return Array.from(
    { length: definition.taskCount },
    (_, index) => `${definition.taskPrefix}-GT-${String(index + 1).padStart(2, "0")}`,
  );
}
