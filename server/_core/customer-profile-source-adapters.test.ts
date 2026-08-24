import { describe, expect, it } from "vitest";
import { normalizeCustomerProfileSource } from "./customer-profile-source-adapters";

describe("Customer Profile source adapters", () => {
  it("normalizes and minimizes the existing Wealth Customer MCP payload", () => {
    const normalized = normalizeCustomerProfileSource({
      sourceContractId: "wealth-assistant-customer-v2.1",
      observedAt: "2026-08-24T07:00:00.000Z",
      authorization: {
        inScope: true,
        organizationRef: "org-demo",
        principalRef: "principal-wealth",
      },
      payload: {
        updatedAt: "2026-08-24T06:59:00.000Z",
        data: {
          customer: {
            CUST_NO: "CUST-001",
            CUST_NAME: "Wang Demo",
            AGE: 41,
            CUST_PHONE_NO: "13812345678",
            CUST_LVL_CD: "PRIVATE",
            CUSTM_RSK_LVL_CD: "3",
            CUST_RSK_RT_VLD_DT: "2027-01-31",
            RSDNC_ST_CD: "full-address-must-not-pass",
          },
          activityInfo: { CHREM_INVST_RT_CD: "balanced" },
          assetInfo: {
            FINC_AST_CNY_BAL: 5_500_000,
            checking: 300_000,
            investments: 5_200_000,
          },
          recommendations: ["must-not-pass"],
        },
      },
    });

    const fields = new Map(
      normalized.fields.map(field => [field.path, field.value])
    );
    expect(normalized).toMatchObject({
      sourceSystem: "wealth_assistant_customer",
      subjectId: "CUST-001",
      asOf: "2026-08-24T06:59:00.000Z",
      productionReady: false,
    });
    expect(fields.get("contact.maskedPhone")).toBe("138****5678");
    expect(fields.get("demographics.ageBand")).toBe("30_44");
    expect(fields.get("risk.investmentRiskLevel")).toBe("C3");
    expect(fields.get("wealth.aumBand")).toBe("5m_10m");
    expect(fields.get("wealth.assetAllocationSummary")).toBe(
      "available_fields:3"
    );
    expect(JSON.stringify(normalized)).not.toContain(
      "full-address-must-not-pass"
    );
    expect(JSON.stringify(normalized)).not.toContain("must-not-pass");
    expect(JSON.stringify(normalized)).not.toContain("13812345678");
    expect(normalized.fields.every(field => field.provenance.asOf)).toBe(true);
  });

  it("normalizes the Insurance demo payload without passing raw biography data", () => {
    const normalized = normalizeCustomerProfileSource({
      sourceContractId: "insurance-customer-profile-demo-v1",
      observedAt: "2026-08-24T07:00:00.000Z",
      authorization: {
        inScope: false,
        organizationRef: "org-demo",
        principalRef: "principal-insurance",
      },
      payload: {
        id: "CUST-001",
        name: "Wang Demo",
        customer_status: "active",
        age: 41,
        occupation: "business_owner",
        city: "Shanghai",
        risk_preference: "balanced",
        contact_strategy: "call in the afternoon",
        vehicle_info: "沪A12345 VIN:LSV12345678901234",
        annual_mileage: "12000 km",
        driving_record: "no material claims",
        protection_gap: "medical, accident",
        bio: { raw: "must-not-pass" },
      },
    });

    const fields = new Map(
      normalized.fields.map(field => [field.path, field.value])
    );
    expect(normalized).toMatchObject({
      sourceSystem: "insurance_customer_profile",
      subjectId: "CUST-001",
      productionReady: false,
    });
    expect(
      JSON.stringify(fields.get("insurance.vehicleSummary"))
    ).not.toContain("沪A12345");
    expect(fields.get("insurance.vehicleSummary")).toEqual([
      { summary: "沪A****5 VIN:LSV**********1234" },
    ]);
    expect(fields.get("insurance.annualMileageBand")).toBe("10k_20k");
    expect(fields.get("insurance.protectionGaps")).toEqual([
      "medical",
      "accident",
    ]);
    expect(JSON.stringify(normalized)).not.toContain("must-not-pass");
  });
});
