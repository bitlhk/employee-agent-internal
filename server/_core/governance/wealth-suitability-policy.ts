import type {
  GovernanceDecisionDraft,
  GovernancePolicyAdapter,
} from "./contracts";

export const WEALTH_SUITABILITY_POLICY_ID = "WEALTH_SUITABILITY_MATCH";
export const WEALTH_SUITABILITY_RULE_VERSION = "wealth-suitability-v1";

export type WealthPolicySource = {
  ready: boolean;
  sourceAssetId: string;
  versionLabel: string;
  sourceLocator: string;
  eligibilityFingerprint: string;
};

export type WealthCustomerSuitabilityContext = {
  customerId: string;
  riskLevel: string;
  assessmentStatus: string;
  assessmentExpiresAt: string | null;
  dataAsOf: string;
};

export type WealthProductSuitabilityContext = {
  productId: string;
  name: string;
  riskLevel: string;
  status: string;
  channels: string[];
  minAmount: number | null;
  termMonths: number | null;
  dataAsOf: string;
};

export type WealthSuitabilityRequestContext = {
  customer: WealthCustomerSuitabilityContext;
  product: WealthProductSuitabilityContext;
  request: {
    amount: number | null;
    horizonMonths: number | null;
    channel: string;
  };
  policySource: WealthPolicySource;
  evaluatedAt?: string;
};

export type WealthSuitabilityReasonCode =
  | "ROLE_NOT_ALLOWED"
  | "POLICY_SOURCE_UNAVAILABLE"
  | "CUSTOMER_CONTEXT_INCOMPLETE"
  | "ASSESSMENT_INVALID"
  | "ASSESSMENT_EXPIRED"
  | "PRODUCT_CONTEXT_INCOMPLETE"
  | "RISK_MISMATCH"
  | "PRODUCT_NOT_SELLABLE"
  | "CHANNEL_NOT_ALLOWED"
  | "AMOUNT_BELOW_MINIMUM"
  | "HORIZON_TOO_SHORT"
  | "ELIGIBLE";

const SELLABLE_STATUSES = new Set([
  "active", "available", "on_sale", "onsale", "selling", "在售", "可售", "开放",
]);
const VALID_ASSESSMENT_STATUSES = new Set(["active", "valid", "有效", "正常"]);

function normalized(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

export function wealthRiskOrdinal(value: unknown): number | null {
  const match = normalized(value).toUpperCase().match(/^[CR]([1-5])$/);
  return match ? Number(match[1]) : null;
}

function decision(
  effect: "ALLOW" | "DENY",
  reasonCode: WealthSuitabilityReasonCode,
  reason: string,
): GovernanceDecisionDraft {
  return {
    effect,
    policyCode: `${WEALTH_SUITABILITY_POLICY_ID}:${reasonCode}`,
    ruleVersion: WEALTH_SUITABILITY_RULE_VERSION,
    reason,
    obligations: [{ type: "AUDIT", level: effect === "ALLOW" ? "strong" : "highest" }],
  };
}

export function evaluateWealthSuitabilityRules(input: {
  roleTemplate: string;
  context: WealthSuitabilityRequestContext;
}): GovernanceDecisionDraft {
  const { customer, product, request, policySource } = input.context;
  if (input.roleTemplate !== "wealth-manager") {
    return decision("DENY", "ROLE_NOT_ALLOWED", "当前岗位没有执行财富产品适当性判断的权限。");
  }
  if (!policySource.ready || !policySource.sourceAssetId || !policySource.versionLabel || !policySource.eligibilityFingerprint) {
    return decision("DENY", "POLICY_SOURCE_UNAVAILABLE", "当前没有通过有效性校验的适当性制度，暂不能形成正式产品推荐。");
  }
  const customerRisk = wealthRiskOrdinal(customer.riskLevel);
  if (!customer.customerId || !customerRisk || !customer.dataAsOf) {
    return decision("DENY", "CUSTOMER_CONTEXT_INCOMPLETE", "客户风险等级或数据时间不完整，请先核验客户信息。");
  }
  if (!VALID_ASSESSMENT_STATUSES.has(normalized(customer.assessmentStatus))) {
    return decision("DENY", "ASSESSMENT_INVALID", "客户风险测评当前无效，请先完成或核验风险测评。");
  }
  const evaluatedAt = Date.parse(input.context.evaluatedAt || new Date().toISOString());
  const assessmentExpiresAt = customer.assessmentExpiresAt ? Date.parse(customer.assessmentExpiresAt) : Number.NaN;
  if (!Number.isFinite(assessmentExpiresAt) || assessmentExpiresAt <= evaluatedAt) {
    return decision("DENY", "ASSESSMENT_EXPIRED", "客户风险测评已过期或缺少有效期，不能形成正式产品推荐。");
  }
  const productRisk = wealthRiskOrdinal(product.riskLevel);
  if (!product.productId || !productRisk || !product.status || !product.dataAsOf) {
    return decision("DENY", "PRODUCT_CONTEXT_INCOMPLETE", "产品风险等级、状态或数据时间不完整，不能进入推荐集合。");
  }
  if (productRisk > customerRisk) {
    return decision("DENY", "RISK_MISMATCH", `产品风险等级 ${product.riskLevel} 高于客户风险承受等级 ${customer.riskLevel}。`);
  }
  if (!SELLABLE_STATUSES.has(normalized(product.status))) {
    return decision("DENY", "PRODUCT_NOT_SELLABLE", "产品当前不在可售状态，不能进入推荐集合。");
  }
  if (request.channel) {
    if (!product.channels.length || !product.channels.some((channel) => normalized(channel) === normalized(request.channel))) {
      return decision("DENY", "CHANNEL_NOT_ALLOWED", `产品当前不支持 ${request.channel} 渠道销售。`);
    }
  }
  if (request.amount !== null && product.minAmount !== null && request.amount < product.minAmount) {
    return decision("DENY", "AMOUNT_BELOW_MINIMUM", "本次拟配置金额低于产品最低金额要求。");
  }
  if (request.horizonMonths !== null && product.termMonths !== null && request.horizonMonths < product.termMonths) {
    return decision("DENY", "HORIZON_TOO_SHORT", "客户投资期限短于产品期限，不能进入推荐集合。");
  }
  return decision("ALLOW", "ELIGIBLE", "客户、产品和当前有效适当性规则均通过，产品可以进入候选集合。");
}

export function wealthSuitabilityPolicyAdapter(
  context: WealthSuitabilityRequestContext,
): GovernancePolicyAdapter {
  return {
    id: "wealth-suitability-policy",
    evaluate(request): GovernanceDecisionDraft {
      return evaluateWealthSuitabilityRules({
        roleTemplate: request.principal.roleTemplate,
        context,
      });
    },
  };
}
