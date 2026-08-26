import { createHash } from "node:crypto";

import {
  POST_LOAN_RISK_DEMO_DATASET_VERSION,
  POST_LOAN_RISK_DEMO_DATA_AS_OF,
  POST_LOAN_RISK_DEMO_ENTERPRISES,
  POST_LOAN_RISK_DEMO_INDUSTRY,
  POST_LOAN_RISK_DEMO_MACRO,
  type PostLoanRiskDemoEnterprise,
} from "./post-loan-risk-demo-fixtures";

export const POST_LOAN_RISK_DATA_SERVICE_NAME = "post_loan_risk_data";
export const POST_LOAN_RISK_DATA_SERVICE_VERSION = "1.0.0";

type JsonObject = Record<string, unknown>;

export type PostLoanRiskToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent: JsonObject;
};

const TOOL_NAMES = [
  "list_risk_enterprises",
  "search_risk_enterprises",
  "get_post_loan_risk_snapshot",
  "get_enterprise_profile",
  "get_loan_account",
  "get_financial_statements",
  "get_repayment_history",
  "get_collateral_info",
  "get_guarantor_info",
  "get_credit_rating",
  "get_judicial_info",
  "get_public_opinion",
  "get_business_abnormal",
  "get_tax_info",
  "get_dishonest_record",
  "get_industry_benchmark",
  "get_industry_rating",
  "get_macro_indicator",
] as const;

export type PostLoanRiskToolName = typeof TOOL_NAMES[number];

const ENTERPRISE_ID_PROPERTIES = {
  unified_social_code: {
    type: "string",
    minLength: 18,
    maxLength: 18,
    description: "统一社会信用代码；应优先由企业搜索工具返回。",
  },
} as const;

function readTool(name: PostLoanRiskToolName, description: string, properties: JsonObject, required: string[] = []) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  };
}

export const POST_LOAN_RISK_DATA_TOOLS = [
  readTool("list_risk_enterprises", "列出当前岗位获授权的贷后风控演示企业。", {
    limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  }),
  readTool("search_risk_enterprises", "按企业名称或统一社会信用代码搜索当前岗位获授权的企业。", {
    query: { type: "string", minLength: 1, maxLength: 200 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  }, ["query"]),
  readTool(
    "get_post_loan_risk_snapshot",
    "获取用于完整贷后评估或异步 A2A 委派的不可变、带指纹风险事实快照。缺少关键域时必须阻断正式综合结论。",
    ENTERPRISE_ID_PROPERTIES,
    ["unified_social_code"],
  ),
  readTool("get_enterprise_profile", "获取企业基本画像。", ENTERPRISE_ID_PROPERTIES, ["unified_social_code"]),
  readTool("get_loan_account", "获取企业贷款账户信息。", {
    ...ENTERPRISE_ID_PROPERTIES,
    include_closed: { type: "boolean", default: false },
  }, ["unified_social_code"]),
  readTool("get_financial_statements", "获取企业财务报表。", {
    ...ENTERPRISE_ID_PROPERTIES,
    years: { type: "integer", minimum: 1, maximum: 5, default: 3 },
  }, ["unified_social_code"]),
  readTool("get_repayment_history", "获取企业还款历史。", {
    ...ENTERPRISE_ID_PROPERTIES,
    months: { type: "integer", minimum: 1, maximum: 60, default: 24 },
  }, ["unified_social_code"]),
  readTool("get_collateral_info", "获取抵质押物信息。", ENTERPRISE_ID_PROPERTIES, ["unified_social_code"]),
  readTool("get_guarantor_info", "获取担保人信息。", ENTERPRISE_ID_PROPERTIES, ["unified_social_code"]),
  readTool("get_credit_rating", "获取企业信用评级。", ENTERPRISE_ID_PROPERTIES, ["unified_social_code"]),
  readTool("get_judicial_info", "获取司法诉讼与执行信息。", ENTERPRISE_ID_PROPERTIES, ["unified_social_code"]),
  readTool("get_public_opinion", "获取企业舆情线索；舆情不能单独作为正式风险事实。", ENTERPRISE_ID_PROPERTIES, ["unified_social_code"]),
  readTool("get_business_abnormal", "获取企业经营异常信息。", ENTERPRISE_ID_PROPERTIES, ["unified_social_code"]),
  readTool("get_tax_info", "获取企业税务信息。", ENTERPRISE_ID_PROPERTIES, ["unified_social_code"]),
  readTool("get_dishonest_record", "获取企业及关联方失信记录。", ENTERPRISE_ID_PROPERTIES, ["unified_social_code"]),
  readTool("get_industry_benchmark", "获取行业基准财务指标。", {
    industry_code: { type: "string", minLength: 1, maxLength: 4 },
    year: { type: "integer", minimum: 2015, maximum: 2030, default: 2026 },
  }, ["industry_code"]),
  readTool("get_industry_rating", "获取行业风险评级与景气度。", {
    industry_code: { type: "string", minLength: 1, maxLength: 4 },
  }, ["industry_code"]),
  readTool("get_macro_indicator", "获取演示宏观经济指标。", {
    indicator_type: { type: "string", enum: ["ALL", "GDP", "PMI", "CPI", "PPI", "LPR", "M2"], default: "ALL" },
  }),
] as const;

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function boundedLimit(value: unknown): number {
  const parsed = Number(value || 20);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(100, Math.floor(parsed))) : 20;
}

function stableFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function enterpriseSummary(enterprise: PostLoanRiskDemoEnterprise): JsonObject {
  return {
    enterpriseId: enterprise.unifiedSocialCode,
    unifiedSocialCode: enterprise.unifiedSocialCode,
    enterpriseName: enterprise.enterpriseName,
    industryCode: enterprise.profile.industry_code,
    industryName: enterprise.profile.industry_name,
    operatingStatus: enterprise.profile.operating_status,
    dataAsOf: POST_LOAN_RISK_DEMO_DATA_AS_OF,
  };
}

function findEnterprise(args: JsonObject): PostLoanRiskDemoEnterprise | undefined {
  const code = String(args.unified_social_code || args.credit_code || "").trim().toUpperCase();
  return POST_LOAN_RISK_DEMO_ENTERPRISES.find((enterprise) => enterprise.unifiedSocialCode === code);
}

function sourceRecordIds(enterprise: PostLoanRiskDemoEnterprise): JsonObject {
  const id = enterprise.unifiedSocialCode;
  return {
    profile: `demo://enterprise/${id}/profile`,
    loanAccounts: `demo://enterprise/${id}/loan-accounts`,
    financial: `demo://enterprise/${id}/financial`,
    repayment: `demo://enterprise/${id}/repayment`,
    collateral: `demo://enterprise/${id}/collateral`,
    guarantor: `demo://enterprise/${id}/guarantor`,
    creditRating: `demo://enterprise/${id}/credit-rating`,
    externalRisk: `demo://enterprise/${id}/external-risk`,
  };
}

function envelope(input: {
  schema: string;
  data: unknown;
  enterprise?: PostLoanRiskDemoEnterprise;
  status?: "READY" | "NOT_FOUND" | "BLOCKED";
  reasonCode?: string;
}): JsonObject {
  const evidence = {
    sourceSystem: POST_LOAN_RISK_DATA_SERVICE_NAME,
    sourceMode: "demo_fixture",
    datasetVersion: POST_LOAN_RISK_DEMO_DATASET_VERSION,
    dataAsOf: POST_LOAN_RISK_DEMO_DATA_AS_OF,
    ...(input.enterprise ? { sourceRecordIds: sourceRecordIds(input.enterprise) } : {}),
  };
  const fingerprintPayload = {
    schema: input.schema,
    status: input.status || "READY",
    reasonCode: input.reasonCode || null,
    enterprise: input.enterprise ? enterpriseSummary(input.enterprise) : null,
    data: input.data,
    evidence,
  };
  return {
    ...fingerprintPayload,
    resultFingerprint: stableFingerprint(fingerprintPayload),
  };
}

function result(payload: JsonObject, isError = false): PostLoanRiskToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
    structuredContent: payload,
  };
}

function notFound(args: JsonObject): PostLoanRiskToolResult {
  return result(envelope({
    schema: "ea.post-loan-risk-data.v1",
    status: "NOT_FOUND",
    reasonCode: "ENTERPRISE_NOT_FOUND_OR_NOT_AUTHORIZED",
    data: {
      unifiedSocialCode: String(args.unified_social_code || "").trim(),
      remediation: "请先使用 search_risk_enterprises 定位获授权企业，不得根据企业名称猜测业务事实。",
    },
  }), true);
}

function enterpriseDomainResult(args: JsonObject, domain: keyof PostLoanRiskDemoEnterprise): PostLoanRiskToolResult {
  const enterprise = findEnterprise(args);
  if (!enterprise) return notFound(args);
  return result(envelope({
    schema: "ea.post-loan-risk-data.v1",
    enterprise,
    data: enterprise[domain],
  }));
}

export function buildPostLoanRiskSnapshot(enterprise: PostLoanRiskDemoEnterprise): JsonObject {
  const domains = {
    enterpriseProfile: enterprise.profile,
    loanAccounts: enterprise.loanAccounts,
    financial: enterprise.financial,
    repayment: enterprise.repayment,
    collateral: enterprise.collaterals,
    guarantor: enterprise.guarantors,
    creditRating: enterprise.creditRating,
    judicial: enterprise.judicial,
    publicOpinion: enterprise.publicOpinion,
    businessAbnormal: enterprise.businessAbnormal,
    tax: enterprise.tax,
    dishonest: enterprise.dishonest,
  };
  const criticalDomains = ["enterpriseProfile", "loanAccounts", "financial", "repayment", "creditRating"];
  const missingCriticalDomains = criticalDomains.filter((name) => {
    const value = domains[name as keyof typeof domains];
    return value == null || (Array.isArray(value) ? value.length === 0 : Object.keys(record(value)).length === 0);
  });
  const payload = envelope({
    schema: "ea.post-loan-risk-snapshot.v1",
    enterprise,
    status: missingCriticalDomains.length === 0 ? "READY" : "BLOCKED",
    reasonCode: missingCriticalDomains.length === 0 ? undefined : "CRITICAL_RISK_DATA_INCOMPLETE",
    data: {
      enterprise: enterpriseSummary(enterprise),
      domains,
      completeness: {
        criticalComplete: missingCriticalDomains.length === 0,
        missingCriticalDomains,
        availableDomains: Object.keys(domains),
      },
      constraints: {
        demoOnly: true,
        regulatoryClassificationAllowed: false,
        automaticCreditActionAllowed: false,
        humanReviewRequired: true,
      },
    },
  });
  return {
    ...payload,
    snapshotFingerprint: payload.resultFingerprint,
  };
}

export function executePostLoanRiskDataTool(
  name: string,
  rawArgs: unknown,
  roleTemplate = "post-loan-risk-control",
): PostLoanRiskToolResult {
  if (roleTemplate !== "post-loan-risk-control") {
    return result({
      schema: "ea.post-loan-risk-data.v1",
      status: "BLOCKED",
      reasonCode: "ROLE_NOT_AUTHORIZED",
    }, true);
  }
  if (!TOOL_NAMES.includes(name as PostLoanRiskToolName)) {
    return result({ schema: "ea.post-loan-risk-data.v1", status: "BLOCKED", reasonCode: "UNKNOWN_TOOL" }, true);
  }
  const args = record(rawArgs);
  if (name === "list_risk_enterprises") {
    const rows = POST_LOAN_RISK_DEMO_ENTERPRISES.slice(0, boundedLimit(args.limit)).map(enterpriseSummary);
    return result(envelope({ schema: "ea.post-loan-risk-directory.v1", data: { items: rows, total: rows.length } }));
  }
  if (name === "search_risk_enterprises") {
    const query = String(args.query || "").trim().toLowerCase();
    const rows = POST_LOAN_RISK_DEMO_ENTERPRISES
      .filter((enterprise) => enterprise.enterpriseName.toLowerCase().includes(query) || enterprise.unifiedSocialCode.toLowerCase().includes(query))
      .slice(0, boundedLimit(args.limit))
      .map(enterpriseSummary);
    return result(envelope({ schema: "ea.post-loan-risk-directory.v1", data: { query, items: rows, total: rows.length } }));
  }
  if (name === "get_post_loan_risk_snapshot") {
    const enterprise = findEnterprise(args);
    return enterprise ? result(buildPostLoanRiskSnapshot(enterprise)) : notFound(args);
  }
  const domainByTool: Partial<Record<PostLoanRiskToolName, keyof PostLoanRiskDemoEnterprise>> = {
    get_enterprise_profile: "profile",
    get_loan_account: "loanAccounts",
    get_financial_statements: "financial",
    get_repayment_history: "repayment",
    get_collateral_info: "collaterals",
    get_guarantor_info: "guarantors",
    get_credit_rating: "creditRating",
    get_judicial_info: "judicial",
    get_public_opinion: "publicOpinion",
    get_business_abnormal: "businessAbnormal",
    get_tax_info: "tax",
    get_dishonest_record: "dishonest",
  };
  const domain = domainByTool[name as PostLoanRiskToolName];
  if (domain) return enterpriseDomainResult(args, domain);
  if (name === "get_industry_benchmark" || name === "get_industry_rating") {
    const industryCode = String(args.industry_code || "").trim().toUpperCase();
    const industry = POST_LOAN_RISK_DEMO_INDUSTRY[industryCode];
    if (!industry) return result(envelope({
      schema: "ea.post-loan-risk-industry.v1",
      status: "NOT_FOUND",
      reasonCode: "INDUSTRY_NOT_FOUND",
      data: { industryCode },
    }), true);
    const field = name === "get_industry_benchmark" ? "benchmark" : "rating";
    return result(envelope({ schema: "ea.post-loan-risk-industry.v1", data: { industryCode, [field]: industry[field] } }));
  }
  const indicatorType = String(args.indicator_type || "ALL").trim().toUpperCase();
  const macro = indicatorType === "ALL" ? POST_LOAN_RISK_DEMO_MACRO : POST_LOAN_RISK_DEMO_MACRO[indicatorType];
  return result(envelope({ schema: "ea.post-loan-risk-macro.v1", data: { indicatorType, indicators: macro || {} } }));
}
