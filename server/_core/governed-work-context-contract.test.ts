import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadLogicalContextCatalog, logicalContextIndex, validateLogicalContextCatalog } from "./logical-context-catalog";

describe("governed work continuity Context contract", () => {
  it("adds a non-conflicting memory Context extension without changing the frozen V1 catalog", () => {
    const baseline = loadLogicalContextCatalog();
    expect(validateLogicalContextCatalog(baseline)).toEqual([]);
    expect(logicalContextIndex(baseline).has("governed_work_state")).toBe(false);

    const extension = JSON.parse(readFileSync(path.join(
      process.cwd(),
      "examples/governed-work-continuity-v1/context-contract.json",
    ), "utf8"));
    expect(extension).toMatchObject({
      schemaVersion: "ea.logical-context-catalog-extension.v1",
      extensionVersion: "1.0.0",
      baselineCatalogVersion: baseline.catalogVersion,
    });
    expect(extension.entries).toEqual([expect.objectContaining({
      canonicalId: "governed_work_state",
      contextType: "memory",
      status: "active",
    })]);
    expect(extension.plans[0].needs).toEqual([expect.objectContaining({
      logicalAssetId: "governed_work_state",
      contextType: "memory",
      requiredness: "required",
    })]);
    const baselineIdentifiers = logicalContextIndex(baseline);
    for (const entry of extension.entries) {
      expect(baselineIdentifiers.has(entry.canonicalId)).toBe(false);
      for (const alias of entry.aliases || []) expect(baselineIdentifiers.has(alias)).toBe(false);
    }
  });
});
