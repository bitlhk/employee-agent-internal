import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveReferenceKnowledgeSeries, validateReferenceKnowledgeManifest, type ReferenceKnowledgeAsset } from "../../scripts/import-demo-knowledge";

const packRoot = path.join(process.cwd(), "examples", "investment-research-reference-role-pack");
const documentsRoot = path.join(packRoot, "knowledge", "documents");
const manifest = JSON.parse(readFileSync(path.join(packRoot, "knowledge", "manifest.json"), "utf8")) as { schemaVersion: string; rolePackId: string; roleTemplate: string; assets: ReferenceKnowledgeAsset[] };

describe("investment research Reference Knowledge", () => {
  it("ships ten governed assets covering all six tasks", () => {
    expect(manifest.schemaVersion).toBe("ea.reference-role-pack.knowledge.v1");
    expect(manifest.rolePackId).toBe("linggan-finance.investment-research");
    expect(manifest.roleTemplate).toBe("investment-researcher");
    expect(manifest.assets).toHaveLength(10);
    expect(readdirSync(documentsRoot).filter((file) => file.endsWith(".md"))).toHaveLength(10);
    const taskIds = new Set(manifest.assets.flatMap((asset) => asset.taskIds));
    for (let index = 1; index <= 6; index += 1) expect(taskIds.has(`IR-GT-${String(index).padStart(2, "0")}`)).toBe(true);
  });

  it("passes shared validation and keeps the historical data policy in lineage", () => {
    expect(() => validateReferenceKnowledgeManifest(manifest, { key: "investment-research", sourceDir: documentsRoot, taskIdPattern: /^IR-GT-0[1-6]$/u })).not.toThrow();
    const series = resolveReferenceKnowledgeSeries(manifest.assets);
    expect(series.get("ir-data-assurance-v2.0")).toBe("ir-data-assurance");
    expect(series.get("ir-data-assurance-v1.0")).toBe("ir-data-assurance");
    const current = manifest.assets.find((asset) => asset.assetId === "ir-data-assurance-v2.0");
    const historical = manifest.assets.find((asset) => asset.assetId === "ir-data-assurance-v1.0");
    expect(current).toMatchObject({ lifecycle: "active", supersedes: historical?.assetId });
    expect(historical).toMatchObject({ lifecycle: "expired", supersededBy: current?.assetId });
  });

  it("keeps dynamic prices, fixed demo securities and trading out of static knowledge", () => {
    const combined = manifest.assets.map((asset) => readFileSync(path.join(documentsRoot, asset.file), "utf8")).join("\n");
    expect(combined).not.toMatch(/张先生|李女士|CUST[-_]|600519\.SH/u);
    expect(combined).toContain("直接触发交易");
    expect(combined).toContain("动态行情");
  });
});
