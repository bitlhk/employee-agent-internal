import { describe, expect, it } from "vitest";
import { analyzeEnterpriseAssetImpact, parseEnterpriseAssetManifest, targetTypeForEnterpriseAsset } from "./enterprise-asset-onboarding";

const metadata = {
  ownerDepartment: "财富管理部",
  classification: "internal" as const,
  applicableRoles: ["wealth-manager"],
  applicableOrganizations: ["org_demo"],
  lifecycle: "active" as const,
  authority: "approved" as const,
  effectiveAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2027-08-01T00:00:00.000Z",
  externalProcessingAllowed: false,
  relatedTasks: ["WM-GT-03"],
  policyCandidates: ["WEALTH_SUITABILITY_MATCH"],
};

describe("enterprise asset onboarding contract", () => {
  it("accepts a governed sidecar manifest", () => {
    const parsed = parseEnterpriseAssetManifest({
      schemaVersion: "linggan.enterprise-asset/v1",
      enterpriseId: "bank-demo",
      assets: [{
        assetId: "wealth.sales-policy.v2.2",
        name: "财富产品销售管理办法 V2.2",
        assetType: "knowledge_document",
        file: "sales-policy-v2.2.pdf",
        versionLabel: "2.2",
        checksum: "a".repeat(64),
        metadata,
      }],
    });
    expect(parsed.assets[0].metadata.externalProcessingAllowed).toBe(false);
  });

  it("rejects inconsistent lifecycle dates", () => {
    expect(() => parseEnterpriseAssetManifest({
      schemaVersion: "linggan.enterprise-asset/v1",
      enterpriseId: "bank-demo",
      assets: [{
        assetId: "wealth.invalid",
        name: "Invalid",
        assetType: "knowledge_document",
        versionLabel: "1",
        checksum: "b".repeat(64),
        metadata: { ...metadata, effectiveAt: "2027-08-01T00:00:00.000Z", expiresAt: "2026-08-01T00:00:00.000Z" },
      }],
    })).toThrow(/失效时间/);
  });

  it("produces deterministic role-pack impact without becoming runtime config", () => {
    const impact = analyzeEnterpriseAssetImpact({
      assetType: "knowledge_document",
      enterpriseAssetId: "wealth.sales-policy.v2.2",
      sourceVersion: "2.2",
      checksum: "a".repeat(64),
      metadata,
    });
    expect(impact.affectedRolePackIds).toEqual(["linggan-bank.wealth-manager"]);
    expect(impact.requiresGoldenTaskRerun).toBe(true);
    expect(targetTypeForEnterpriseAsset("business_data")).toBe("enterprise_mcp");
  });
});
