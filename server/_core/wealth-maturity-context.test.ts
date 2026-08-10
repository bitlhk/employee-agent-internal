import { describe, expect, it, vi } from "vitest";
import {
  normalizeWealthCustomerList,
  normalizeWealthMaturityItems,
  prepareWealthMaturityContext,
} from "./wealth-maturity-context";

const now = new Date("2026-08-10T00:00:00.000Z");

function detail(customerId: string, name: string, maturities: Array<Record<string, unknown>>) {
  return {
    ok: true,
    updatedAt: "2026-08-10T01:00:00.000Z",
    data: {
      customerId,
      name,
      riskLevel: "C3",
      riskAssessment: { status: "valid", validUntil: "2027-01-01T00:00:00.000Z" },
      lastContactAt: "2026-06-01T00:00:00.000Z",
      expiringProducts: maturities,
    },
  };
}

describe("wealth maturity context", () => {
  it("normalizes common authorized customer-list envelopes", () => {
    expect(normalizeWealthCustomerList({
      data: { items: [{ customerId: "C-1", name: "客户甲" }, { id: "C-2", customerName: "客户乙" }] },
    })).toEqual([
      { customerId: "C-1", customerName: "客户甲" },
      { customerId: "C-2", customerName: "客户乙" },
    ]);
  });

  it("rejects detail data outside the authorized customer-list identity", () => {
    expect(() => normalizeWealthMaturityItems({
      payload: detail("C-OTHER", "越权客户", []),
      expectedCustomerId: "C-1",
      fallbackCustomerName: "客户甲",
      from: now,
      to: new Date("2026-09-09T00:00:00.000Z"),
    })).toThrow("客户标识与授权清单不一致");
  });

  it("rejects maturity facts without a verifiable data timestamp", () => {
    const payload = detail("C-1", "客户甲", [{
      productId: "P-1",
      maturityDate: "2026-08-15T00:00:00.000Z",
    }]);
    delete payload.updatedAt;
    expect(() => normalizeWealthMaturityItems({
      payload,
      expectedCustomerId: "C-1",
      fallbackCustomerName: "客户甲",
      from: now,
      to: new Date("2026-09-09T00:00:00.000Z"),
    })).toThrow("未提供可验证的数据时间");
  });

  it("returns a bounded, prioritized 30-day maturity list without product recommendations", async () => {
    const loadCustomer = vi.fn(async (customerId: string) => customerId === "C-1"
      ? detail("C-1", "客户甲", [{
          productId: "P-1",
          productName: "演示固收一号",
          maturityDate: "2026-08-15T00:00:00.000Z",
          maturityAmount: 1_500_000,
          status: "holding",
        }])
      : customerId === "C-2"
        ? detail("C-2", "客户乙", [{
            productId: "P-2",
            productName: "演示固收二号",
            maturityDate: "2026-08-30T00:00:00.000Z",
            maturityAmount: 200_000,
            status: "holding",
          }])
        : detail("C-3", "客户丙", [{
            productId: "P-3",
            productName: "时间窗外产品",
            maturityDate: "2026-10-01T00:00:00.000Z",
            maturityAmount: 3_000_000,
          }]));
    const result = await prepareWealthMaturityContext({
      roleTemplate: "wealth-manager",
      request: { windowDays: 30, maxCustomers: 3, maxItems: 10 },
      dependencies: {
        listCustomers: async () => ({
          data: { customers: [
            { customerId: "C-1", name: "客户甲" },
            { customerId: "C-2", name: "客户乙" },
            { customerId: "C-3", name: "客户丙" },
          ] },
        }),
        loadCustomer,
      },
      now,
    });
    expect(result.status).toBe("ready");
    expect(result.items.map((item) => item.productId)).toEqual(["P-1", "P-2"]);
    expect(result.items[0]).toMatchObject({ priority: "high", daysUntilMaturity: 5 });
    expect(result.guidance).toMatchObject({
      productRecommendationAllowed: false,
      writeRequiresSeparateConfirmation: true,
    });
    expect(result.evidence.scope).toBe("current-user-authorized-customers");
    expect(result.evidence.dataAsOf).toEqual(["2026-08-10T01:00:00.000Z"]);
    expect(loadCustomer).toHaveBeenCalledTimes(3);
  });

  it("reports partial results when one authorized customer detail fails", async () => {
    const result = await prepareWealthMaturityContext({
      roleTemplate: "wealth-manager",
      request: { windowDays: 30, maxCustomers: 2, maxItems: 10 },
      dependencies: {
        listCustomers: async () => ({ customers: [{ id: "C-1" }, { id: "C-2" }] }),
        loadCustomer: async (customerId) => {
          if (customerId === "C-2") throw new Error("temporary failure");
          return detail("C-1", "客户甲", [{ productId: "P-1", maturityDate: "2026-08-15", amount: 10_000 }]);
        },
      },
      now,
    });
    expect(result.status).toBe("partial");
    expect(result.summary).toMatchObject({ customersScanned: 2, customersFailed: 1, returnedItems: 1 });
  });
});
