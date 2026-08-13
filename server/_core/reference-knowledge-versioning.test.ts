import { describe, expect, it } from "vitest";
import {
  resolveReferenceKnowledgeSeries,
  type ReferenceKnowledgeAsset,
  validateReferenceKnowledgeVersionGraph,
} from "../../scripts/import-demo-knowledge";

function asset(
  assetId: string,
  overrides: Partial<ReferenceKnowledgeAsset> = {},
): ReferenceKnowledgeAsset {
  return {
    assetId,
    file: `01-${assetId}.md`,
    versionLabel: "V1.0",
    sourceDepartment: "合规部",
    classification: "internal",
    authority: "reference",
    lifecycle: "active",
    effectiveAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    taskIds: ["WM-GT-03"],
    ...overrides,
  };
}

describe("reference knowledge version graph", () => {
  it("resolves replacement versions to one stable document series", () => {
    const previous = asset("policy-v1", {
      lifecycle: "expired",
      expiresAt: "2026-06-30T00:00:00.000Z",
      supersededBy: "policy-v2",
    });
    const current = asset("policy-v2", {
      effectiveAt: "2026-07-01T00:00:00.000Z",
      supersedes: "policy-v1",
    });

    validateReferenceKnowledgeVersionGraph([previous, current]);
    expect(resolveReferenceKnowledgeSeries([previous, current])).toEqual(new Map([
      ["policy-v1", "policy-v1"],
      ["policy-v2", "policy-v1"],
    ]));
  });

  it("rejects cyclic replacement chains", () => {
    expect(() => resolveReferenceKnowledgeSeries([
      asset("policy-a", { supersedes: "policy-b" }),
      asset("policy-b", { supersedes: "policy-a" }),
    ])).toThrow(/Cyclic knowledge replacement chain/);
  });

  it("rejects overlapping active versions in one series", () => {
    expect(() => validateReferenceKnowledgeVersionGraph([
      asset("policy-v1", { expiresAt: "2026-12-31T00:00:00.000Z", supersededBy: "policy-v2" }),
      asset("policy-v2", { effectiveAt: "2026-06-01T00:00:00.000Z", supersedes: "policy-v1" }),
    ])).toThrow(/Overlapping active knowledge versions/);
  });
});
