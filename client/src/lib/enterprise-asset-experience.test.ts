import { describe, expect, it } from "vitest";
import {
  assetMatchesIssue,
  countAssetIssues,
  fromLocalDateTimeInput,
  normalizedReviewMetadata,
  suggestionSourceEvidence,
  suggestionSourceLabel,
  toLocalDateTimeInput,
} from "./enterprise-asset-experience";

describe("enterprise asset experience", () => {
  it("groups unresolved diagnostics by administrator-facing issue", () => {
    const candidates = [
      {
        diagnosticsJson: [
          { code: "MISSING_OWNER" },
          { code: "MISSING_VERSION" },
        ],
      },
      { diagnosticsJson: [{ code: "OCR_FAILED" }] },
      {
        diagnosticsJson: [
          { code: "DUPLICATE_CONTENT", resolvedAt: "2026-08-21T00:00:00.000Z" },
        ],
      },
    ];

    expect(countAssetIssues(candidates)).toMatchObject({
      all: 2,
      owner: 1,
      version: 1,
      parsing: 1,
      duplicate: 0,
    });
    expect(assetMatchesIssue(candidates[2].diagnosticsJson, "all")).toBe(false);
  });

  it("converts suggestions into the existing review metadata contract", () => {
    expect(
      normalizedReviewMetadata({
        ownerDepartment: "财富管理部",
        logicalAssetCandidates: ["current_wealth_policy"],
        suggestionMethod: "deterministic",
        suggestedDomain: "wealth",
      })
    ).toMatchObject({
      ownerDepartment: "财富管理部",
      businessDomain: "wealth",
      logicalAssetIds: ["current_wealth_policy"],
      applicableOrganizations: [],
      relatedTasks: [],
      policyCandidates: [],
      externalProcessingAllowed: false,
    });
  });

  it("describes real suggestion mechanisms without inventing confidence", () => {
    expect(suggestionSourceLabel("model_assisted")).toBe("平台模型建议");
    expect(suggestionSourceEvidence("deterministic")).toContain("接入来源规则");
  });

  it("round-trips effective time through a local datetime input", () => {
    const input = toLocalDateTimeInput("2026-08-21T02:30:00.000Z");
    expect(fromLocalDateTimeInput(input)).toBe("2026-08-21T02:30:00.000Z");
  });
});
