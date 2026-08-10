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

type JsonObject = Record<string, unknown>;

export type WealthAllocationRequest = {
  customerId: string;
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
    productDataAsOf: string[];
    policyDecisionIds: string[];
    decisions: Array<{ productId: string; effect: GovernanceDecision["effect"]; policyCode: string; policyDecisionId: string }>;
  };
};

export type WealthAllocationDependencies = {
  loadCustomer(customerId: string): Promise<JsonObject>;
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
  return object(payload.customer).customerId || object(payload.customer).id
    ? object(payload.customer)
    : object(data.customer).customerId || object(data.customer).id
      ? object(data.customer)
      : Object.keys(data).length ? data : payload;
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
    customerId: firstString(customer.customerId, customer.customer_id, customer.id, expectedCustomerId),
    name: firstString(customer.name, customer.customerName, customer.customer_name),
    riskLevel: firstString(customer.riskLevel, customer.risk_level, customer.riskRating, customer.risk_rating, assessment.level),
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
  const defaultDataAsOf = firstString(payload.updatedAt, payload.updated_at, object(payload.data).updatedAt, object(payload.data).updated_at);
  return productRows(payload).map((product) => ({
    productId: firstString(product.productId, product.product_id, product.id, product.productCode, product.product_code),
    name: firstString(product.name, product.productName, product.product_name),
    riskLevel: firstString(product.riskLevel, product.risk_level, product.riskRating, product.risk_rating),
    status: firstString(product.status, product.saleStatus, product.sale_status, product.salesStatus, product.sales_status),
    channels: stringArray(product.channels, product.saleChannels, product.sale_channels, product.channel),
    minAmount: finiteNumber(product.minAmount, product.min_amount, product.minimumAmount, product.minimum_amount),
    termMonths: finiteNumber(product.termMonths, product.term_months, product.durationMonths, product.duration_months, product.lockPeriodMonths),
    dataAsOf: firstString(product.dataAsOf, product.data_as_of, product.updatedAt, product.updated_at, defaultDataAsOf),
  })).slice(0, 50);
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
  const [customerPayload, productPayload, policySource] = await Promise.all([
    input.dependencies.loadCustomer(input.request.customerId),
    input.dependencies.searchProducts({
      keyword: input.request.keyword,
      type: input.request.productType,
      pageSize: input.request.maxProducts,
    }),
    input.dependencies.resolvePolicySource(),
  ]);
  const customer = normalizeWealthCustomer(customerPayload, input.request.customerId);
  if (customer.customerId !== input.request.customerId) throw new Error("客户 MCP 返回的客户标识与请求不一致");
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
