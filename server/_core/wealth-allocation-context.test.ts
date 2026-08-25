import { describe, expect, it } from "vitest";
import type { RuntimePrincipal } from "./governance/contracts";
import {
  normalizeWealthCustomer,
  normalizeWealthProducts,
  prepareWealthAllocationContext,
  type WealthAllocationDependencies,
} from "./wealth-allocation-context";

const principal: RuntimePrincipal = {
  userId: 7,
  adoptionId: "lgj-wealth",
  agentId: "jiuwen_lgj-wealth",
  roleTemplate: "wealth-manager",
  workspaceId: "/tmp/wealth",
  permissionProfile: "internal",
  sessionId: "session-1",
};

const customer = {
  ok: true,
  data: {
    customerId: "C-001",
    name: "演示客户",
    riskLevel: "C3",
    riskAssessment: { status: "valid", validUntil: "2027-01-01T00:00:00.000Z" },
    aum: 1_500_000,
    updatedAt: "2026-08-10T00:00:00.000Z",
  },
};

const products = {
  ok: true,
  updatedAt: "2026-08-10T01:00:00.000Z",
  data: {
    products: [
      { id: "P-R2", name: "稳健固收", riskRating: "R2", status: "on_sale", channels: ["branch"], minAmount: 100_000, termMonths: 24 },
      { id: "P-R4", name: "高风险权益", riskRating: "R4", status: "on_sale", channels: ["branch"], minAmount: 100_000, termMonths: 24 },
      { id: "P-STOP", name: "停售产品", riskRating: "R1", status: "stopped", channels: ["branch"], minAmount: 10_000, termMonths: 6 },
    ],
  },
};

function dependencies(patch: Partial<WealthAllocationDependencies> = {}): WealthAllocationDependencies {
  return {
    loadCustomer: async () => customer,
    searchProducts: async () => products,
    resolvePolicySource: async () => ({
      ready: true,
      sourceAssetId: "doc-policy-v22",
      versionLabel: "V2.2",
      sourceLocator: "第四条 风险等级匹配",
      eligibilityFingerprint: "a".repeat(64),
    }),
    ...patch,
  };
}

describe("wealth allocation context", () => {
  it("normalizes supported customer and product MCP envelopes", () => {
    expect(normalizeWealthCustomer(customer, "C-001")).toMatchObject({
      customerId: "C-001",
      riskLevel: "C3",
      assessmentStatus: "valid",
      assessmentExpiresAt: "2027-01-01T00:00:00.000Z",
    });
    expect(normalizeWealthProducts(products)).toHaveLength(3);
  });

  it("normalizes the current Wealth product MCP field names", () => {
    expect(normalizeWealthProducts({
      updatedAt: "2026-08-25T09:50:12.200Z",
      data: {
        products: [{
          id: 4,
          code: "P004",
          name: "灵活配置理财",
          risk_rating: "4",
          risk_label: "R4较高风险",
          status: "on_sale",
          min_purchase_amount: 50_000,
          channels: ["branch"],
        }],
      },
    })).toEqual([expect.objectContaining({
      productId: "P004",
      riskLevel: "R4",
      status: "on_sale",
      minAmount: 50_000,
      dataAsOf: "2026-08-25T09:50:12.200Z",
    })]);
  });

  it("normalizes numeric and labeled product risk ratings to governed R-levels", () => {
    const normalized = normalizeWealthProducts({
      updatedAt: "2026-08-25T09:50:12.200Z",
      data: {
        products: [
          { code: "P002", risk_rating: "3", risk_label: "R3中风险", status: "on_sale" },
          { code: "P004", risk_rating: 4, risk_label: "R4较高风险", status: "on_sale" },
        ],
      },
    });

    expect(normalized.map(product => product.riskLevel)).toEqual(["R3", "R4"]);
  });

  it("normalizes the governed enterprise wealth customer fields", () => {
    expect(normalizeWealthCustomer({
      ok: true,
      data: {
        customer: {
          CUST_NO: "C001",
          CUST_NAME: "演示客户",
          CUSTM_RSK_LVL_CD: "3",
          CUST_RSK_RT_VLD_DT: "2027-01-01T00:00:00.000Z",
        },
      },
      updatedAt: "2026-08-20T00:00:00.000Z",
    }, "C001")).toMatchObject({
      customerId: "C001",
      name: "演示客户",
      riskLevel: "C3",
      assessmentStatus: "valid",
      assessmentExpiresAt: "2027-01-01T00:00:00.000Z",
      dataAsOf: "2026-08-20T00:00:00.000Z",
    });
  });

  it("returns only policy-eligible candidates to the model context", async () => {
    const result = await prepareWealthAllocationContext({
      principal,
      request: {
        customerId: "C-001",
        amount: 500_000,
        horizonMonths: 36,
        channel: "branch",
        keyword: "",
        productType: "",
        maxProducts: 10,
      },
      dependencies: dependencies(),
      now: new Date("2026-08-10T00:00:00.000Z"),
    });

    expect(result.status).toBe("ready");
    expect(result.eligibleProducts.map((product) => product.productId)).toEqual(["P-R2"]);
    expect(result.evidence.decisions.filter((decision) => decision.effect === "DENY").map((decision) => decision.policyCode)).toEqual([
      "WEALTH_SUITABILITY_MATCH:RISK_MISMATCH",
      "WEALTH_SUITABILITY_MATCH:PRODUCT_NOT_SELLABLE",
    ]);
    expect(result.excludedProducts[0]).toMatchObject({
      title: "暂不能形成正式推荐",
      nextStep: "请改选风险等级不高于客户当前有效风险等级的产品。",
    });
    expect(JSON.stringify(result.excludedProducts)).not.toContain("WEALTH_SUITABILITY_MATCH");
    expect(JSON.stringify(result.eligibleProducts)).not.toContain("P-R4");
    expect(result.policySource.versionLabel).toBe("V2.2");
    expect(result.evidence.policyDecisionIds).toHaveLength(3);
  });

  it("fails closed when the current policy source is unavailable", async () => {
    const result = await prepareWealthAllocationContext({
      principal,
      request: { customerId: "C-001", amount: null, horizonMonths: null, channel: "", keyword: "", productType: "", maxProducts: 10 },
      dependencies: dependencies({
        resolvePolicySource: async () => ({ ready: false, sourceAssetId: "", versionLabel: "", sourceLocator: "", eligibilityFingerprint: "b".repeat(64) }),
      }),
      now: new Date("2026-08-10T00:00:00.000Z"),
    });
    expect(result.status).toBe("no_eligible_products");
    expect(result.eligibleProducts).toEqual([]);
    expect(result.excludedProducts.every((item) => item.nextStep.includes("知识管理员"))).toBe(true);
    expect(result.evidence.decisions.every((item) => item.policyCode.endsWith("POLICY_SOURCE_UNAVAILABLE"))).toBe(true);
  });

  it("uses the governed profile projection while keeping the portfolio source separate", async () => {
    const result = await prepareWealthAllocationContext({
      principal,
      request: { customerId: "C-001", amount: 500_000, horizonMonths: 36, channel: "branch", keyword: "", productType: "", maxProducts: 10 },
      dependencies: dependencies({
        loadCustomer: undefined,
        loadCustomerProfile: async () => ({
          logicalContextId: "customer_profile",
          projectionId: "WealthCustomerProfileV1",
          purposeId: "wealth_advisory",
          status: "READY",
          sourceEvidence: [{ asOf: "2026-08-10T00:00:00.000Z" }],
          fields: [
            { path: "subject.subjectId", value: "C-001" },
            { path: "subject.displayName", value: "演示客户" },
            { path: "risk.investmentRiskLevel", value: "C3" },
            { path: "risk.investmentRiskValidUntil", value: "2027-01-01T00:00:00.000Z" },
          ],
        }),
        loadCustomerPortfolio: async () => ({
          data: { customer: { CUST_NO: "C-001" }, heldProducts: [{ productId: "P-OLD" }] },
          updatedAt: "2026-08-10T00:01:00.000Z",
        }),
      }),
      now: new Date("2026-08-10T00:02:00.000Z"),
    });

    expect(result.customer).toMatchObject({
      customerId: "C-001",
      riskLevel: "C3",
      assessmentExpiresAt: "2027-01-01T00:00:00.000Z",
    });
    expect(result.evidence.profileDataAsOf).toBe("2026-08-10T00:00:00.000Z");
    expect(result.evidence.portfolioDataAsOf).toBe("2026-08-10T00:01:00.000Z");
  });

  it("rejects a customer response for a different customer id", async () => {
    await expect(prepareWealthAllocationContext({
      principal,
      request: { customerId: "C-OTHER", amount: null, horizonMonths: null, channel: "", keyword: "", productType: "", maxProducts: 10 },
      dependencies: dependencies(),
      now: new Date("2026-08-10T00:00:00.000Z"),
    })).rejects.toThrow("客户标识与请求不一致");
  });
});
