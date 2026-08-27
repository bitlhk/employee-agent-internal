import { describe, expect, it } from "vitest";
import type { RuntimePrincipalV2 } from "./governance/contracts";
import {
  loadTwentyCustomerProfileCompatibilitySource,
  normalizeTwentyCustomerProfileSource,
  type TwentyCustomerProfileRecordV1,
} from "./customer-profile-twenty-adapter";

const principal: RuntimePrincipalV2 = {
  userId: 101,
  tenantId: "tn_demo",
  organizationId: "tn_demo",
  adoptionId: "insurance-adoption",
  agentId: "insurance-agent",
  roleTemplate: "insurance-advisor",
  workspaceId: "insurance-workspace",
  permissionProfile: "insurance-advisor",
  authorizationSnapshotId: "auth-snapshot",
  authorizationFingerprint: "auth-fingerprint",
  sessionId: "session-1",
  identityVersion: "2",
};

const record: TwentyCustomerProfileRecordV1 = {
  graceCustomerId: "CUST-000101",
  displayName: "测试客户",
  customerStatus: "续保客户",
  tenantId: "tn_demo",
  ownerUserId: "101",
  businessAsOf: "2026-08-20",
  profileType: "auto_insurance",
  detailSchemaVersion: "auto-insurance.v1",
  demographics: { age: 48, occupation: "制造业老板", city: "苏州" },
  preferences: {
    riskPreference: "稳健",
    budgetConcern: "中等",
    servicePreference: "专人服务",
    communicationPreference: "面谈",
  },
  insuranceFacts: {
    renewalAt: "2026-09-15",
    renewalStatus: "pending",
    currentCoverageSummary: "基础组合",
    claimsRiskSummary: "连续五年无出险",
    recentContactSummary: "已联系一次",
    confirmedNeeds: "道路救援,专人服务",
  },
  detail: {
    vehicleSummary: {
      vehicleCount: 1,
      vehicles: [
        {
          vehicleIdDesensitized: "V-A1B2****",
          brand: "奔驰",
          model: "S级",
          year: 2021,
          purchasePrice: 1_100_000,
          energyType: "fuel",
          usage: "business_reception",
        },
      ],
    },
    annualMileage: "约3-4万公里",
    drivingRecord: "连续五年未出险",
  },
  fieldProvenance: {
    currentCoverageSummary: {
      sourceSystem: "insurance_policy_system",
      asOf: "2026-08-01",
    },
  },
};

describe("Twenty Customer Profile adapter", () => {
  it("normalizes CRM records without broad vehicle or suggestion fields", () => {
    const source = normalizeTwentyCustomerProfileSource({
      record,
      principal,
      subjectInScope: true,
      observedAt: "2026-08-27T08:00:00.000Z",
    });
    const byPath = new Map(source.fields.map(field => [field.path, field]));
    expect(byPath.get("insurance.annualMileageBand")?.value).toBe("gte_20k");
    expect(
      byPath.get("insurance.currentCoverageSummary")?.provenance
    ).toMatchObject({
      sourceSystem: "insurance_policy_system",
      asOf: "2026-08-01T00:00:00.000Z",
    });
    expect(byPath.get("insurance.vehicleSummary")?.value).toEqual([
      {
        vehicleRef: "V-A1B2****",
        brand: "奔驰",
        model: "S级",
        year: 2021,
        energyType: "fuel",
        usage: "business_reception",
      },
    ]);
    expect(byPath.has("insurance.protectionGaps")).toBe(false);
    expect(JSON.stringify(source.fields)).not.toContain("purchasePrice");
  });

  it("requires the requested Global Customer ID and organization scope", async () => {
    const loaded = await loadTwentyCustomerProfileCompatibilitySource({
      principal,
      subjectId: record.graceCustomerId,
      recordLoader: async () => ({
        record,
        principalAuthorized: true,
        subjectInScope: true,
        authorizationEvidenceId: "crm-auth-1",
      }),
    });
    expect(loaded.subjectInScope).toBe(true);
    expect(loaded.sources[0]?.sourceContractId).toBe("twenty-crm-customer-v1");

    await expect(
      loadTwentyCustomerProfileCompatibilitySource({
        principal,
        subjectId: "CUST-000102",
        recordLoader: async () => ({
          record,
          principalAuthorized: true,
          subjectInScope: true,
          authorizationEvidenceId: "crm-auth-1",
        }),
      })
    ).rejects.toThrow("CUSTOMER_CRM_SOURCE_SUBJECT_MISMATCH");
  });

  it("normalizes wealth CRM profiles without exposing exact balances", () => {
    const source = normalizeTwentyCustomerProfileSource({
      record: {
        ...record,
        graceCustomerId: "CUST-000005",
        displayName: "陈明",
        profileType: "wealth",
        detailSchemaVersion: "wealth.v1",
        maskedPhone: "138****8005",
        demographics: { ageBand: "45_59", occupationCategory: "1" },
        preferences: { riskPreference: "2" },
        insuranceFacts: {},
        detail: {
          customerTier: "2",
          riskAssessment: {
            riskLevel: "C4",
            validUntil: "2027-12-31T23:59:59.000Z",
          },
          assetAllocationSummary: {
            aumBand: "500k_1m",
            totalAssets: 750810,
          },
        },
        fieldProvenance: {},
      },
      principal: { ...principal, roleTemplate: "wealth-manager" },
      subjectInScope: true,
      observedAt: "2026-08-27T08:00:00.000Z",
    });
    const values = new Map(
      source.fields.map(field => [field.path, field.value])
    );
    expect(values.get("contact.maskedPhone")).toBe("138****8005");
    expect(values.get("risk.investmentRiskLevel")).toBe("C4");
    expect(values.get("wealth.aumBand")).toBe("500k_1m");
    expect(values.get("wealth.assetAllocationSummary")).toBe(
      "资产规模区间：500k_1m"
    );
    expect(JSON.stringify(source.fields)).not.toContain("750810");
  });

  it("preserves authorization and subject-scope denials without returning data", async () => {
    const denied = await loadTwentyCustomerProfileCompatibilitySource({
      principal,
      subjectId: record.graceCustomerId,
      recordLoader: async () => ({
        record: null,
        principalAuthorized: false,
        subjectInScope: false,
        authorizationEvidenceId: "crm-deny-1",
      }),
    });
    expect(denied).toMatchObject({
      sources: [],
      principalAuthorized: false,
      subjectInScope: false,
    });
    expect(denied.notes.join(" ")).toContain("crm-deny-1");
  });
});
