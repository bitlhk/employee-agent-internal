import { describe, expect, it } from "vitest";
import {
  mergeCustomerCrmImportBundles,
  prepareInsuranceCustomerCrmImport,
  prepareNativeCustomerCrmFixtures,
  prepareWealthCustomerCrmImport,
  recordsToCsv,
  type CustomerCrmIdentityCrosswalkV1,
  type InsuranceCustomerImportSourceV1,
  type WealthCustomerMcpExportV1,
} from "./customer-crm-import";

const autoCustomer: InsuranceCustomerImportSourceV1 = {
  id: 1,
  name: "测试客户",
  profile_type: "auto_insurance",
  businessAsOf: "2026-08-20",
  tenant_id: "tn_demo",
  detail: {
    vehicleSummary: { vehicleCount: 1 },
    annualMileage: "15000公里",
    drivingRecord: "连续三年无出险",
  },
  currentCoverageSummary: "基础车险",
  bio: "模型生成摘要",
  protection_gap: "缺少司机座位险",
  contact_strategy: "建议电话沟通",
};

const crosswalk: CustomerCrmIdentityCrosswalkV1 = {
  schemaVersion: "ea.customer-crm-identity-crosswalk.v1",
  crosswalkVersion: "test",
  mappings: [
    {
      sourceSystem: "insurance_customer_profile",
      sourceTenantId: "tn_demo",
      sourceCustomerId: "1",
      globalCustomerId: "CUST-000101",
    },
    {
      sourceSystem: "wealth_assistant_customer",
      sourceTenantId: "tn_linggan_finance",
      sourceCustomerId: "C005",
      globalCustomerId: "CUST-000005",
    },
  ],
};

const wealthExport: WealthCustomerMcpExportV1 = {
  schemaVersion: "ea.wealth-customer-mcp-export.v1",
  exportedAt: "2026-08-27T08:00:00.000Z",
  source: "customer_context/wealth_assistant_customer_detail",
  records: [
    {
      directory: { customerId: "C005", customerName: "陈明" },
      detail: {
        customer: {
          customerId: "C005",
          name: "陈明",
          customerStatus: "active_demo",
          ageBand: "45_59",
          occupationCategory: "1",
          maskedPhone: "138****8005",
          customerTier: "2",
          riskPreference: "2",
          riskLevel: "C4",
          assessmentExpiresAt: "2027-12-31T23:59:59.000Z",
          aumBand: "500k_1m",
          dataAsOf: "2026-08-25T09:00:00.000Z",
        },
        assetInfo: { totalAssets: 750810 },
      },
    },
  ],
};

describe("Customer CRM import preparation", () => {
  it("creates stable source links and keeps suggestions out of facts", () => {
    const bundle = prepareInsuranceCustomerCrmImport({
      records: [autoCustomer],
      crosswalk,
      canonicalTenantId: "tn_linggan_finance",
      now: new Date("2026-08-27T08:00:00Z"),
    });
    expect(bundle.customers[0]?.globalCustomerId).toBe("CUST-000101");
    expect(bundle.customers[0]?.customerStatus).toBe("active");
    expect(bundle.customers[0]?.tenantId).toBe("tn_linggan_finance");
    expect(bundle.sourceLinks[0]).toMatchObject({
      sourceSystem: "insurance_customer_profile",
      sourceCustomerId: "1",
    });
    expect(bundle.domainProfiles[0]).toMatchObject({
      profileType: "auto_insurance",
      detailSchemaVersion: "auto-insurance.v1",
      runtimeStatus: "candidate",
    });
    expect(bundle.suggestions).toHaveLength(3);
    expect(bundle.suggestions.every(item => item.runtimeFact === false)).toBe(
      true
    );
  });

  it("rejects unknown schemas and incomplete registered detail", () => {
    expect(() =>
      prepareInsuranceCustomerCrmImport({
        records: [{ ...autoCustomer, profile_type: "pet_insurance" }],
        crosswalk,
      })
    ).toThrow("CUSTOMER_CRM_PROFILE_SCHEMA_REVIEW_REQUIRED");
    expect(() =>
      prepareInsuranceCustomerCrmImport({
        records: [{ ...autoCustomer, detail: { vehicleSummary: {} } }],
        crosswalk,
      })
    ).toThrow("CUSTOMER_CRM_PROFILE_FIELDS_MISSING");
  });

  it("imports wealth MCP facts into the same customer and profile model", () => {
    const bundle = prepareWealthCustomerCrmImport({
      export: wealthExport,
      crosswalk,
      sourceTenantId: "tn_linggan_finance",
      canonicalTenantId: "tn_linggan_finance",
      ownerUserId: "2",
    });
    expect(bundle.customers[0]).toMatchObject({
      globalCustomerId: "CUST-000005",
      displayName: "陈明",
      customerStatus: "active",
      maskedPhone: "138****8005",
    });
    expect(bundle.domainProfiles[0]).toMatchObject({
      globalCustomerId: "CUST-000005",
      profileType: "wealth",
      detailSchemaVersion: "wealth.v2",
      detail: {
        customerTier: "2",
        riskAssessment: { riskLevel: "C4" },
        assetAllocationSummary: { aumBand: "500k_1m" },
        portfolioSummary: { totalAssets: 750810 },
        holdings: [],
        maturities: [],
      },
    });
  });

  it("merges source bundles without merging identities heuristically", () => {
    const insurance = prepareInsuranceCustomerCrmImport({
      records: [autoCustomer],
      crosswalk,
    });
    const wealth = prepareWealthCustomerCrmImport({
      export: wealthExport,
      crosswalk,
      sourceTenantId: "tn_linggan_finance",
      canonicalTenantId: "tn_linggan_finance",
      ownerUserId: "2",
    });
    const merged = mergeCustomerCrmImportBundles([insurance, wealth]);
    expect(merged.sourceSystem).toBe("customer_source_composition");
    expect(merged.customers).toHaveLength(2);
    expect(merged.sourceLinks).toHaveLength(2);
    expect(merged.domainProfiles).toHaveLength(2);
  });

  it("keeps multiple governed domain profiles on one native customer", () => {
    const bundle = prepareNativeCustomerCrmFixtures({
      fixtures: {
        schemaVersion: "ea.native-customer-crm-fixtures.v1",
        customers: [
          {
            globalCustomerId: "CUST-000201",
            displayName: "跨域客户",
            customerStatus: "active",
            visibilityScope: "restricted",
            tenantId: "tn_demo",
            ownerUserId: "59",
            businessAsOf: "2026-08-27T08:00:00.000Z",
            profiles: [
              {
                profileType: "wealth",
                demographics: {},
                preferences: {},
                insuranceFacts: {},
                detail: {
                  customerTier: "private_banking",
                  riskAssessment: {},
                  assetAllocationSummary: {},
                  portfolioSummary: {},
                  holdings: [],
                  maturities: [],
                },
              },
              {
                profileType: "life_insurance",
                demographics: {},
                preferences: {},
                insuranceFacts: {},
                detail: {
                  investableAssets: "100万",
                  familyStructure: "已婚",
                  healthStatus: "已告知",
                  dependents: "一名子女",
                  existingCoverage: "基础保障",
                  financialGoals: "退休准备",
                },
              },
            ],
          },
        ],
        assignments: [
          {
            assignmentKey: "org-demo:user:59:CUST-000201",
            globalCustomerId: "CUST-000201",
            organizationId: "org-demo",
            principalType: "user",
            principalRef: "59",
            businessDomain: "shared",
            relationshipRole: "primary",
            assignmentStatus: "active",
          },
        ],
      },
    });
    expect(bundle.customers).toHaveLength(1);
    expect(bundle.domainProfiles.map(item => item.profileType)).toEqual([
      "wealth",
      "life_insurance",
    ]);
    expect(bundle.assignments).toHaveLength(1);
  });

  it("emits quoted CSV with JSON fields", () => {
    const csv = recordsToCsv([
      { globalCustomerId: "C-1", detail: { note: '含"引号"' } },
    ]);
    expect(csv).toContain('"globalCustomerId","detail"');
    expect(csv).toContain('""note""');
    expect(csv).toContain("含");
    expect(csv).toContain("引号");
  });
});
