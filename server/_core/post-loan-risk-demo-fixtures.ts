export const POST_LOAN_RISK_DEMO_DATASET_VERSION = "risk-demo-fixture-v1";
export const POST_LOAN_RISK_DEMO_DATA_AS_OF = "2026-08-25T08:00:00+08:00";

export type PostLoanRiskDemoEnterprise = {
  unifiedSocialCode: string;
  enterpriseName: string;
  profile: Record<string, unknown>;
  loanAccounts: Array<Record<string, unknown>>;
  financial: Record<string, unknown>;
  repayment: Record<string, unknown>;
  collaterals: Array<Record<string, unknown>>;
  guarantors: Array<Record<string, unknown>>;
  creditRating: Record<string, unknown>;
  judicial: Record<string, unknown>;
  publicOpinion: Record<string, unknown>;
  businessAbnormal: Record<string, unknown>;
  tax: Record<string, unknown>;
  dishonest: Record<string, unknown>;
};

export const POST_LOAN_RISK_DEMO_ENTERPRISES: readonly PostLoanRiskDemoEnterprise[] = [
  {
    unifiedSocialCode: "91370000726200000X",
    enterpriseName: "鸿远建设集团有限公司",
    profile: {
      enterprise_name: "鸿远建设集团有限公司",
      industry_code: "E",
      industry_name: "建筑业",
      ownership_type: "民营",
      registered_capital: 50000,
      establishment_date: "2003-06-15",
      legal_person: "张鸿远",
      enterprise_scale: "中型",
      operating_status: "在营",
    },
    loanAccounts: [
      {
        loan_id: "LN20230001",
        loan_balance: 15000,
        credit_limit: 25000,
        five_level_class: "关注",
        overdue_days: 0,
        product_type: "流动资金贷款",
        interest_rate: 4.35,
        maturity_date: "2027-12-31",
      },
    ],
    financial: {
      years: ["2025", "2024", "2023"],
      total_assets: [120000, 115000, 108000],
      total_liabilities: [84000, 80000, 74000],
      current_ratio: [1.15, 1.20, 1.28],
      dscr: [1.08, 1.15, 1.22],
      operating_cashflow: [3500, 4200, 5100],
      net_profit: [2800, 3200, 3800],
      revenue: [65000, 72000, 80000],
    },
    repayment: {
      total_overdue_count: 3,
      max_overdue_days: 15,
      recent_6m_overdue_count: 1,
      consecutive_normal_months: 4,
      records: [{ month: "2026-07", due: 500, actual: 495, overdue_days: 5 }],
    },
    collaterals: [
      { type: "房产抵押", original_value: 20000, current_value: 18000, coverage_ratio: 0.72, loan_id: "LN20230001", valuation_date: "2026-07-31" },
    ],
    guarantors: [
      { name: "张鸿远", type: "个人保证", amount: 20000, is_dishonest: false, relation: "实控人" },
    ],
    creditRating: {
      internal_rating: "BBB",
      rating_date: "2026-08-15",
      external_rating: "AA-",
      rating_score: 65,
      previous_rating: "A",
      score_model: "demo-v3.0",
    },
    judicial: {
      total_cases: 2,
      total_amount: 800,
      has_frozen_assets: false,
      frozen_amount: 0,
      cases: [{ case_no: "(2026)鲁01民初123号", role: "被告", amount: 500, status: "审理中", type: "合同纠纷" }],
    },
    publicOpinion: {
      negative_count: 3,
      has_major_negative: true,
      opinions: [{ date: "2026-08-10", source: "演示舆情源", title: "项目停工传闻", severity: "中" }],
    },
    businessAbnormal: { has_abnormal: false, abnormal_records: [], has_serious_violation: false },
    tax: { tax_credit_rating: "B", has_arrears: false, annual_tax: [{ year: "2025", amount: 1200 }] },
    dishonest: { is_dishonest: false, dishonest_records: [], related_dishonest: [] },
  },
  {
    unifiedSocialCode: "91440100MA5C00000B",
    enterpriseName: "德信商业地产开发有限公司",
    profile: {
      enterprise_name: "德信商业地产开发有限公司",
      industry_code: "K",
      industry_name: "房地产业",
      ownership_type: "民营",
      registered_capital: 100000,
      establishment_date: "2008-09-10",
      legal_person: "王德信",
      enterprise_scale: "大型",
      operating_status: "在营",
    },
    loanAccounts: [
      {
        loan_id: "LN20210001",
        loan_balance: 80000,
        credit_limit: 120000,
        five_level_class: "关注",
        overdue_days: 0,
        product_type: "开发贷款",
        interest_rate: 5.20,
        maturity_date: "2027-12-31",
      },
      {
        loan_id: "LN20220002",
        loan_balance: 20000,
        credit_limit: 30000,
        five_level_class: "次级",
        overdue_days: 35,
        product_type: "经营性物业贷款",
        interest_rate: 4.90,
        maturity_date: "2026-11-30",
      },
    ],
    financial: {
      years: ["2025", "2024", "2023"],
      total_assets: [350000, 380000, 400000],
      total_liabilities: [280000, 290000, 300000],
      current_ratio: [0.85, 0.92, 1.05],
      dscr: [0.75, 0.88, 1.10],
      operating_cashflow: [-5000, -2000, 3000],
      net_profit: [-8000, -3000, 2000],
      revenue: [45000, 55000, 70000],
    },
    repayment: {
      total_overdue_count: 5,
      max_overdue_days: 35,
      recent_6m_overdue_count: 2,
      consecutive_normal_months: 2,
      records: [{ month: "2026-07", due: 2000, actual: 0, overdue_days: 35 }],
    },
    collaterals: [
      { type: "土地使用权抵押", original_value: 150000, current_value: 110000, coverage_ratio: 1.10, loan_id: "LN20210001", valuation_date: "2026-07-31" },
    ],
    guarantors: [
      { name: "德信控股集团", type: "企业保证", amount: 80000, is_dishonest: true, relation: "母公司" },
    ],
    creditRating: {
      internal_rating: "BB",
      rating_date: "2026-08-20",
      external_rating: "BBB",
      rating_score: 45,
      previous_rating: "BBB",
      score_model: "demo-v3.0",
    },
    judicial: {
      total_cases: 5,
      total_amount: 3500,
      has_frozen_assets: true,
      frozen_amount: 2000,
      cases: [{ case_no: "(2026)粤01民初789号", role: "被告", amount: 1500, status: "审理中", type: "工程款纠纷" }],
    },
    publicOpinion: {
      negative_count: 8,
      has_major_negative: true,
      opinions: [{ date: "2026-08-21", source: "演示舆情源", title: "项目交付延期引发集中投诉", severity: "高" }],
    },
    businessAbnormal: {
      has_abnormal: true,
      abnormal_records: [{ type: "列入经营异常名录", reason: "未按规定公示年度报告", date: "2026-03-15" }],
      has_serious_violation: false,
    },
    tax: { tax_credit_rating: "C", has_arrears: true, annual_tax: [{ year: "2025", amount: 500 }] },
    dishonest: {
      is_dishonest: false,
      dishonest_records: [],
      related_dishonest: [{ name: "德信控股集团", case_no: "(2026)粤01执012号", amount: 800 }],
    },
  },
] as const;

export const POST_LOAN_RISK_DEMO_INDUSTRY: Readonly<Record<string, Record<string, unknown>>> = {
  E: {
    industry_name: "建筑业",
    benchmark: { dscr_mean: 1.30, current_ratio_mean: 1.25, debt_ratio_mean: 0.68, roe_mean: 0.08 },
    rating: { risk_level: "关注", cycle_position: "收缩期", prosperity_index: 45, policy_risk: "中性" },
  },
  K: {
    industry_name: "房地产业",
    benchmark: { dscr_mean: 0.90, current_ratio_mean: 1.00, debt_ratio_mean: 0.78, roe_mean: 0.03 },
    rating: { risk_level: "高风险", cycle_position: "深度收缩", prosperity_index: 30, policy_risk: "限制" },
  },
};

export const POST_LOAN_RISK_DEMO_MACRO: Readonly<Record<string, Record<string, unknown>>> = {
  GDP: { latest: 5.2, trend: "平稳", unit: "%" },
  PMI: { latest: 50.4, trend: "微升", unit: "" },
  CPI: { latest: 0.7, trend: "低位", unit: "%" },
  PPI: { latest: -2.5, trend: "通缩", unit: "%" },
  LPR: { latest: 3.45, trend: "下行", unit: "%" },
  M2: { latest: 7.2, trend: "放缓", unit: "%" },
};
