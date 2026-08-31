import {
  evaluateGovernance,
  type GovernanceDecision,
  type RuntimePrincipal,
} from "./governance/contracts";
import {
  WEALTH_SUITABILITY_RULE_VERSION,
  wealthSuitabilityPolicyAdapter,
  wealthSuitabilityUserGuidance,
  type WealthCustomerSuitabilityContext,
  type WealthPolicySource,
  type WealthProductSuitabilityContext,
  type WealthSuitabilityRequestContext,
} from "./governance/wealth-suitability-policy";
import { loadWealthCustomerContext } from "./wealth-customer-context";

type JsonObject = Record<string, unknown>;

export type WealthAllocationRequest = {
  customerId: string;
  sourceCustomerId?: string;
  amount: number | null;
  horizonMonths: number | null;
  channel: string;
  keyword: string;
  productType: string;
  maxProducts: number;
};

export type WealthAllocationContextResult = {
  schema: "ea.wealth-allocation-context.v1";
  status: "ready" | "no_eligible_products";
  customer: WealthCustomerSuitabilityContext & { name: string; aum: number | null };
  eligibleProducts: WealthProductSuitabilityContext[];
  excludedProducts: Array<{
    productId: string;
    name: string;
    title: string;
    reason: string;
    nextStep: string;
    retryable: boolean;
  }>;
  policySource: WealthPolicySource;
  evidence: {
    ruleVersion: string;
    customerDataAsOf: string;
    profileDataAsOf: string;
    portfolioDataAsOf: string;
    profileResultFingerprint: string;
    portfolioResultFingerprint: string;
    productDataAsOf: string[];
    policyDecisionIds: string[];
    decisions: Array<{ productId: string; effect: GovernanceDecision["effect"]; policyCode: string; policyDecisionId: string }>;
  };
};

export type WealthAllocationDependencies = {
  loadCustomer?(customerId: string): Promise<JsonObject>;
  loadCustomerProfile?(customerId: string): Promise<JsonObject>;
  loadCustomerPortfolio?(customerId: string): Promise<JsonObject>;
  searchProducts(input: { keyword: string; type: string; pageSize: number }): Promise<JsonObject>;
  resolvePolicySource(): Promise<WealthPolicySource>;
};

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function finiteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function stringArray(...values: unknown[]): string[] {
  for (const value of values) {
    if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20);
    if (typeof value === "string" && value.trim()) return value.split(/[,，]/).map((item) => item.trim()).filter(Boolean).slice(0, 20);
  }
  return [];
}

function dataObject(payload: JsonObject): JsonObject {
  const data = object(payload.data);
  const directCustomer = object(payload.customer);
  if (Object.keys(directCustomer).length) return directCustomer;
  const nestedCustomer = object(data.customer);
  if (Object.keys(nestedCustomer).length) return nestedCustomer;
  return Object.keys(data).length ? data : payload;
}

function customerRiskLevel(value: unknown): string {
  const riskLevel = String(value ?? "").trim().toUpperCase();
  return /^[1-5]$/.test(riskLevel) ? `C${riskLevel}` : riskLevel;
}

function productRiskLevel(value: unknown): string {
  const riskLevel = String(value ?? "").trim().toUpperCase();
  const match = riskLevel.match(/^R?([1-5])/);
  return match ? `R${match[1]}` : riskLevel;
}

export function normalizeWealthCustomer(payload: JsonObject, expectedCustomerId: string) {
  const customer = dataObject(payload);
  const assessment = object(customer.riskAssessment || customer.risk_assessment || customer.assessment);
  const assessmentExpiresAt = firstString(
    customer.assessmentExpiresAt,
    customer.assessment_expires_at,
    customer.riskAssessmentExpiresAt,
    customer.risk_assessment_expires_at,
    assessment.expiresAt,
    assessment.expires_at,
    assessment.validUntil,
    customer.CUST_RSK_RT_VLD_DT,
  ) || null;
  const assessmentStatus = firstString(
    customer.assessmentStatus,
    customer.assessment_status,
    customer.riskAssessmentStatus,
    customer.risk_assessment_status,
    assessment.status,
    assessmentExpiresAt ? "valid" : "",
  );
  return {
    customerId: firstString(customer.customerId, customer.customer_id, customer.CUST_NO, customer.id, expectedCustomerId),
    name: firstString(customer.name, customer.customerName, customer.customer_name, customer.CUST_NAME),
    riskLevel: customerRiskLevel(firstString(
      customer.riskLevel,
      customer.risk_level,
      customer.riskRating,
      customer.risk_rating,
      customer.CUSTM_RSK_LVL_CD,
      assessment.level,
    )),
    assessmentStatus,
    assessmentExpiresAt,
    dataAsOf: firstString(customer.dataAsOf, customer.data_as_of, customer.updatedAt, customer.updated_at, payload.updatedAt, payload.updated_at),
    aum: finiteNumber(customer.aum, customer.totalAssets, customer.total_assets),
  };
}

function productRows(payload: JsonObject): JsonObject[] {
  const data = object(payload.data);
  for (const value of [payload.products, payload.items, payload.rows, data.products, data.items, data.rows, data.list, payload.data]) {
    if (Array.isArray(value)) return value.map(object).filter((item) => Object.keys(item).length > 0);
  }
  return [];
}

export function normalizeWealthProducts(payload: JsonObject): WealthProductSuitabilityContext[] {
  const data = object(payload.data);
  const defaultDataAsOf = firstString(payload.asOf, payload.as_of, data.asOf, data.as_of, payload.updatedAt, payload.updated_at, data.updatedAt, data.updated_at);
  return productRows(payload).map((product) => {
    const facts = object(product.productFacts || product.product_facts);
    const salesEligibility = object(product.salesEligibility || product.sales_eligibility);
    const termDays = finiteNumber(product.termDays, product.term_days, facts.termDays, facts.term_days);
    return {
      productId: firstString(product.productId, product.product_id, product.productCode, product.product_code, product.code, product.id),
      name: firstString(product.name, product.productName, product.product_name, facts.name),
      dataSourceType: firstString(product.dataSourceType, product.data_source_type),
      riskLevel: productRiskLevel(firstString(
        product.riskLevel,
        product.risk_level,
        product.riskRating,
        product.risk_rating,
        product.risk_label,
        facts.riskLevel,
        facts.risk_level,
        facts.riskLevelCode,
      )),
      status: firstString(product.status, product.saleStatus, product.sale_status, product.salesStatus, product.sales_status, salesEligibility.salesStatus, salesEligibility.sales_status),
      channels: stringArray(product.channels, product.saleChannels, product.sale_channels, product.channel, salesEligibility.channels),
      minAmount: finiteNumber(
        product.minAmount,
        product.min_amount,
        product.minimumAmount,
        product.minimum_amount,
        product.minPurchaseAmount,
        product.min_purchase_amount,
        facts.minPurchaseAmount,
        facts.min_purchase_amount,
      ),
      termMonths: finiteNumber(
        product.termMonths,
        product.term_months,
        product.durationMonths,
        product.duration_months,
        product.lockPeriodMonths,
        facts.termMonths,
        facts.term_months,
      ) ?? (termDays === null ? null : Math.ceil(termDays / 30)),
      dataAsOf: firstString(product.dataAsOf, product.data_as_of, salesEligibility.asOf, salesEligibility.as_of, product.updatedAt, product.updated_at, defaultDataAsOf),
    };
  }).slice(0, 50);
}

function policyContext(input: {
  customer: WealthCustomerSuitabilityContext;
  product: WealthProductSuitabilityContext;
  request: WealthAllocationRequest;
  policySource: WealthPolicySource;
  evaluatedAt: string;
}): WealthSuitabilityRequestContext {
  return {
    customer: input.customer,
    product: input.product,
    request: {
      amount: input.request.amount,
      horizonMonths: input.request.horizonMonths,
      channel: input.request.channel,
    },
    policySource: input.policySource,
    evaluatedAt: input.evaluatedAt,
  };
}

async function evaluateCandidate(input: {
  principal: RuntimePrincipal;
  context: WealthSuitabilityRequestContext;
}): Promise<GovernanceDecision> {
  return evaluateGovernance({
    principal: input.principal,
    operation: {
      capabilityId: "wealth.product.recommendation",
      operation: "evaluate_candidate",
      sideEffect: "read",
      resource: `product:${input.context.product.productId || "unknown"}`,
    },
    context: input.context as unknown as Record<string, unknown>,
  }, [wealthSuitabilityPolicyAdapter(input.context)], {
    effect: "DENY",
    policyCode: "EA_WEALTH_POLICY_UNAVAILABLE",
    ruleVersion: WEALTH_SUITABILITY_RULE_VERSION,
    reason: "适当性策略不可用，暂不能形成产品推荐。",
    obligations: [{ type: "AUDIT", level: "highest" }],
  });
}

export async function prepareWealthAllocationContext(input: {
  principal: RuntimePrincipal;
  request: WealthAllocationRequest;
  dependencies: WealthAllocationDependencies;
  now?: Date;
}): Promise<WealthAllocationContextResult> {
  const [customerContext, productPayload, policySource] = await Promise.all([
    loadWealthCustomerContext({
      customerId: input.request.sourceCustomerId || input.request.customerId,
      loadCustomer: input.dependencies.loadCustomer,
      loadCustomerProfile: input.dependencies.loadCustomerProfile,
      loadCustomerPortfolio: input.dependencies.loadCustomerPortfolio,
    }),
    input.dependencies.searchProducts({
      keyword: input.request.keyword,
      type: input.request.productType,
      pageSize: input.request.maxProducts,
    }),
    input.dependencies.resolvePolicySource(),
  ]);
  const expectedSourceCustomerId = input.request.sourceCustomerId || input.request.customerId;
  const customer = normalizeWealthCustomer(
    { customer: customerContext.customer },
    expectedSourceCustomerId,
  );
  if (customer.customerId !== expectedSourceCustomerId) throw new Error("客户 MCP 返回的客户标识与请求不一致");
  customer.customerId = input.request.customerId;
  const products = normalizeWealthProducts(productPayload).slice(0, input.request.maxProducts);
  const evaluatedAt = (input.now || new Date()).toISOString();
  const decisions = await Promise.all(products.map(async (product) => ({
    product,
    decision: await evaluateCandidate({
      principal: input.principal,
      context: policyContext({ customer, product, request: input.request, policySource, evaluatedAt }),
    }),
  })));
  const eligibleProducts = decisions
    .filter(({ decision }) => decision.effect === "ALLOW")
    .map(({ product }) => product);
  const excludedProducts = decisions
    .filter(({ decision }) => decision.effect !== "ALLOW")
    .map(({ product, decision }) => ({
      productId: product.productId,
      name: product.name,
      ...wealthSuitabilityUserGuidance(decision.policyCode, decision.reason),
    }));
  return {
    schema: "ea.wealth-allocation-context.v1",
    status: eligibleProducts.length ? "ready" : "no_eligible_products",
    customer,
    eligibleProducts,
    excludedProducts,
    policySource,
    evidence: {
      ruleVersion: WEALTH_SUITABILITY_RULE_VERSION,
      customerDataAsOf: customer.dataAsOf,
      profileDataAsOf: customerContext.evidence.profileDataAsOf,
      portfolioDataAsOf: customerContext.evidence.portfolioDataAsOf,
      profileResultFingerprint: customerContext.evidence.profileResultFingerprint,
      portfolioResultFingerprint: customerContext.evidence.portfolioResultFingerprint,
      productDataAsOf: Array.from(new Set(products.map((product) => product.dataAsOf).filter(Boolean))),
      policyDecisionIds: decisions.map(({ decision }) => decision.decisionId),
      decisions: decisions.map(({ product, decision }) => ({
        productId: product.productId,
        effect: decision.effect,
        policyCode: decision.policyCode,
        policyDecisionId: decision.decisionId,
      })),
    },
  };
}
