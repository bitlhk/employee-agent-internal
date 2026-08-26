import { describe, expect, it } from "vitest";
import { normalizeWealthCustomerPortfolio } from "./customer-context-tools";

describe("Customer Context portfolio projection", () => {
  it("keeps portfolio facts while excluding raw biography and upstream recommendations", () => {
    const result = normalizeWealthCustomerPortfolio({
      expectedSubjectId: "C005",
      now: new Date("2026-08-26T02:00:00.000Z"),
      payload: {
        updatedAt: "2026-08-26T01:59:00.000Z",
        data: {
          customer: {
            CUST_NO: "C005",
            CUST_NAME: "陈明",
            CUST_PHONE_NO: "13812348005",
            WORK_UNIT: "must-not-pass",
          },
          assetInfo: {
            FINC_AST_CNY_BAL: 800000,
            checking: 100000,
            investments: 700000,
          },
          heldProducts: [{
            productCode: "P001",
            productName: "稳健产品",
            balance: 500000,
            status: "active",
            internalRemark: "must-not-pass",
          }],
          maturedProducts: [{
            productCode: "P002",
            productName: "到期产品",
            maturityDate: "2026-09-01",
            amount: 300000,
          }],
          recommendations: ["must-not-pass"],
        },
      },
    });

    expect(result).toMatchObject({
      contract: "ea.customer-context.v1",
      logicalContextId: "customer_portfolio",
      subjectId: "C005",
      status: "READY",
      summary: { totalAssets: 800000, availableCash: 100000, investedAssets: 700000 },
      holdings: [{ productRef: "P001", productName: "稳健产品", balance: 500000 }],
      maturities: [{ productRef: "P002", amount: 300000 }],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("13812348005");
    expect(serialized).not.toContain("WORK_UNIT");
    expect(serialized).not.toContain("must-not-pass");
    expect(serialized).not.toContain("recommendations");
  });

  it("fails closed when the upstream subject does not match the requested customer", () => {
    expect(() => normalizeWealthCustomerPortfolio({
      expectedSubjectId: "C005",
      payload: { data: { customer: { CUST_NO: "C006" } } },
    })).toThrow("CUSTOMER_PORTFOLIO_SOURCE_SUBJECT_MISMATCH");
  });
});
