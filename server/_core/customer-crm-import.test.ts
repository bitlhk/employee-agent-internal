import { describe, expect, it } from "vitest";
import {
  prepareInsuranceCustomerCrmImport,
  recordsToCsv,
  type InsuranceCustomerImportSourceV1,
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

describe("Customer CRM import preparation", () => {
  it("creates stable source links and keeps suggestions out of facts", () => {
    const bundle = prepareInsuranceCustomerCrmImport({
      records: [autoCustomer],
      now: new Date("2026-08-27T08:00:00Z"),
    });
    expect(bundle.customers[0]?.graceCustomerId).toBe("DEMO-INS-TN_DEMO-1");
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
      })
    ).toThrow("CUSTOMER_CRM_PROFILE_SCHEMA_REVIEW_REQUIRED");
    expect(() =>
      prepareInsuranceCustomerCrmImport({
        records: [{ ...autoCustomer, detail: { vehicleSummary: {} } }],
      })
    ).toThrow("CUSTOMER_CRM_PROFILE_FIELDS_MISSING");
  });

  it("emits quoted CSV with JSON fields", () => {
    const csv = recordsToCsv([
      { graceCustomerId: "C-1", detail: { note: '含"引号"' } },
    ]);
    expect(csv).toContain('"graceCustomerId","detail"');
    expect(csv).toContain('""note""');
    expect(csv).toContain("含");
    expect(csv).toContain("引号");
  });
});
