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

export type WealthSuitabilityUserGuidance = {
  title: string;
  reason: string;
  nextStep: string;
  retryable: boolean;
};

export function wealthSuitabilityUserGuidance(
  policyCode: string,
  reason: string,
): WealthSuitabilityUserGuidance {
  const reasonCode = String(policyCode).split(":").pop() as WealthSuitabilityReasonCode;
  const nextSteps: Record<WealthSuitabilityReasonCode, { nextStep: string; retryable: boolean }> = {
    ROLE_NOT_ALLOWED: { nextStep: "请联系岗位管理员确认职责和能力授权。", retryable: false },
    POLICY_SOURCE_UNAVAILABLE: { nextStep: "请联系知识管理员确认并发布当前有效制度后重试。", retryable: true },
    CUSTOMER_CONTEXT_INCOMPLETE: { nextStep: "请先在客户系统补齐或核验风险等级和数据时间。", retryable: true },
    ASSESSMENT_INVALID: { nextStep: "请先完成客户风险测评或核验测评状态。", retryable: true },
    ASSESSMENT_EXPIRED: { nextStep: "请先更新客户风险测评，再继续正式产品适配。", retryable: true },
    PRODUCT_CONTEXT_INCOMPLETE: { nextStep: "请在产品系统补齐风险等级、销售状态和数据时间。", retryable: true },
    RISK_MISMATCH: { nextStep: "请改选风险等级不高于客户当前有效风险等级的产品。", retryable: false },
    PRODUCT_NOT_SELLABLE: { nextStep: "请选择当前在售的产品，或联系产品管理员核验销售状态。", retryable: true },
    CHANNEL_NOT_ALLOWED: { nextStep: "请改用该产品允许的渠道，或选择当前渠道可售产品。", retryable: true },
    AMOUNT_BELOW_MINIMUM: { nextStep: "请调整拟配置金额，或选择起购金额更低的产品。", retryable: true },
    HORIZON_TOO_SHORT: { nextStep: "请选择期限不超过客户资金安排的产品。", retryable: false },
    ELIGIBLE: { nextStep: "可以继续形成候选方案，并保留适当性依据。", retryable: false },
  };
  const fallback = { nextStep: "请核验客户、产品和现行制度后重试。", retryable: true };
  const guidance = nextSteps[reasonCode] || fallback;
  return {
    title: reasonCode === "ELIGIBLE" ? "已通过适当性校验" : "暂不能形成正式推荐",
    reason,
    ...guidance,
  };
}

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
