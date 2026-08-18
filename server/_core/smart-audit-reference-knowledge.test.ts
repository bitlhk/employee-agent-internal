import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveReferenceKnowledgeSeries,
  validateReferenceKnowledgeManifest,
  type ReferenceKnowledgeAsset,
} from "../../scripts/import-demo-knowledge";

const root = process.cwd();
const packRoot = path.join(root, "examples", "smart-audit-reference-role-pack");
const documentsRoot = path.join(packRoot, "knowledge", "documents");
const manifest = JSON.parse(readFileSync(path.join(packRoot, "knowledge", "manifest.json"), "utf8")) as {
  schemaVersion: string;
  rolePackId: string;
  roleTemplate: string;
  assets: ReferenceKnowledgeAsset[];
};

describe("smart audit Reference Knowledge", () => {
  it("ships ten governed assets covering all six benchmark tasks", () => {
    expect(manifest.schemaVersion).toBe("ea.reference-role-pack.knowledge.v1");
    expect(manifest.rolePackId).toBe("linggan-bank.smart-audit");
    expect(manifest.roleTemplate).toBe("credential-compliance");
    expect(manifest.assets).toHaveLength(10);

    const files = readdirSync(documentsRoot).filter((file) => file.endsWith(".md"));
    expect(files).toHaveLength(10);
    expect(new Set(manifest.assets.map((asset) => asset.file))).toEqual(new Set(files));

    const taskIds = new Set(manifest.assets.flatMap((asset) => asset.taskIds));
    for (let index = 1; index <= 6; index += 1) {
      expect(taskIds.has(`AU-GT-${String(index).padStart(2, "0")}`)).toBe(true);
    }
  });

  it("passes the shared manifest and replacement-chain validator", () => {
    expect(() => validateReferenceKnowledgeManifest(manifest, {
      key: "smart-audit",
      sourceDir: documentsRoot,
      taskIdPattern: /^AU-GT-0[1-6]$/u,
    })).not.toThrow();

    const series = resolveReferenceKnowledgeSeries(manifest.assets);
    expect(series.get("au-audit-rule-policy-v2.0")).toBe("au-audit-rule-policy");
    expect(series.get("au-audit-rule-policy-v1.0")).toBe("au-audit-rule-policy");
  });

  it("keeps the superseded rule as historical evidence only", () => {
    const current = manifest.assets.find((asset) => asset.assetId === "au-audit-rule-policy-v2.0");
    const historical = manifest.assets.find((asset) => asset.assetId === "au-audit-rule-policy-v1.0");
    expect(current).toMatchObject({ lifecycle: "active", supersedes: historical?.assetId });
    expect(historical).toMatchObject({ lifecycle: "expired", supersededBy: current?.assetId });

    const historicalText = readFileSync(path.join(documentsRoot, historical!.file), "utf8");
    expect(historicalText).toContain("不得用于当前审核");
    expect(historicalText).toContain("历史追溯");
  });

  it("keeps dynamic customer facts and final approval outside static knowledge", () => {
    const combined = manifest.assets
      .map((asset) => readFileSync(path.join(documentsRoot, asset.file), "utf8"))
      .join("\n");
    expect(combined).not.toMatch(/张先生|李女士|CUST[-_]|固定客户/u);
    expect(combined).toContain("不直接作出贷款通过、拒绝、授信调整或例外批准");
    expect(combined).toContain("异常线索不是欺诈结论");
    expect(combined).toContain("当前任务上传或案件系统授权");
  });
});
