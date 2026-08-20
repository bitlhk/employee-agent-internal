import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import {
  applyEnterpriseAssetModelSuggestion,
  discoverObjectInventoryArtifact,
  discoverZipArtifacts,
  enterpriseAssetIdForPath,
  extractEnterpriseAssetVersion,
  suggestEnterpriseAssetMetadata,
} from "./enterprise-asset-discovery";

const roles = [
  { id: "general-assistant", name: "通用助手" },
  { id: "wealth-manager", name: "财富经理" },
];

describe("enterprise asset discovery", () => {
  it("keeps one logical asset identity across document versions", () => {
    expect(enterpriseAssetIdForPath("bank-policy", "财富管理办法V3.2.pdf"))
      .toBe(enterpriseAssetIdForPath("bank-policy", "财富管理办法V3.3.pdf"));
    expect(extractEnterpriseAssetVersion("财富管理办法V3.2.pdf")).toBe("3.2");
  });

  it("suggests governed metadata and exposes unresolved quality issues", () => {
    const artifact = discoverObjectInventoryArtifact({
      key: "财富/私人银行客户适当性管理办法.pdf",
      checksum: "a".repeat(64),
      sizeBytes: 1024,
      sourceUri: "obs://bank/财富/私人银行客户适当性管理办法.pdf",
    });
    const result = suggestEnterpriseAssetMetadata({
      artifact,
      sourceId: "bank-policy",
      ownerDepartment: "财富管理部",
      roles,
    });
    expect(result.metadata.applicableRoles).toEqual(["wealth-manager"]);
    expect(result.metadata.logicalAssetCandidates).toEqual(["current_wealth_policy"]);
    expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(["MISSING_VERSION", "MISSING_EFFECTIVE_DATE"]));
    expect(result.sourceVersion).toMatch(/^content-/);
  });

  it("lets model assistance fill suggestions without gaining publication authority", () => {
    const artifact = discoverObjectInventoryArtifact({
      key: "制度/销售办法.pdf",
      checksum: "b".repeat(64),
      sizeBytes: 2048,
      sourceUri: "obs://bank/制度/销售办法.pdf",
    });
    const deterministic = suggestEnterpriseAssetMetadata({ artifact, sourceId: "bank-policy", ownerDepartment: "财富管理部", roles });
    const result = applyEnterpriseAssetModelSuggestion({
      ...deterministic,
      suggestion: {
        relativePath: artifact.relativePath,
        version: "4.0",
        effectiveAt: "2026-08-20T00:00:00.000Z",
        roleIds: ["wealth-manager"],
        domain: "wealth",
        logicalAssetCandidates: ["current_wealth_policy"],
      },
    });
    expect(result.sourceVersion).toBe("4.0");
    expect(result.metadata.lifecycle).toBe("draft");
    expect(result.metadata.suggestionMethod).toBe("model_assisted");
    expect(result.diagnostics.map(item => item.code)).not.toContain("MISSING_EFFECTIVE_DATE");
  });

  it("discovers supported documents from a bounded ZIP", () => {
    const zip = new AdmZip();
    zip.addFile("财富/销售制度V2.1.md", Buffer.from("# 销售制度\n"));
    zip.addFile("财富/readme.exe", Buffer.from("not executable"));
    const artifacts = discoverZipArtifacts(zip.toBuffer());
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ relativePath: "财富/销售制度V2.1.md", extension: "md" });
  });

  it("turns connector parse observations into remediation diagnostics", () => {
    const artifact = discoverObjectInventoryArtifact({
      key: "历史/制度旧版V1.pdf",
      checksum: "c".repeat(64),
      sizeBytes: 4096,
      sourceUri: "obs://bank/历史/制度旧版V1.pdf",
      observations: { parseStatus: "failed", ocrStatus: "failed", tableStatus: "anomaly" },
    });
    const result = suggestEnterpriseAssetMetadata({ artifact, sourceId: "bank-policy", ownerDepartment: "财富管理部", roles });
    expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      "SUSPECTED_OLD_VERSION",
      "CONTENT_PARSE_FAILED",
      "OCR_FAILED",
      "TABLE_PARSE_ANOMALY",
    ]));
  });
});
