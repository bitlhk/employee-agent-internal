import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSkillSourceDirectory } from "./skills/skill-source";

const root = path.resolve(process.cwd(), "examples", "insurance-advisor-reference-role-pack");

describe("insurance advisor reference role pack", () => {
  it("ships eight governed reference knowledge assets covering all benchmark tasks", () => {
    const manifest = JSON.parse(readFileSync(path.join(root, "knowledge", "manifest.json"), "utf8")) as {
      schemaVersion: string;
      roleTemplate: string;
      assets: Array<{ file: string; taskIds: string[] }>;
    };
    expect(manifest.schemaVersion).toBe("ea.reference-role-pack.knowledge.v1");
    expect(manifest.roleTemplate).toBe("insurance-advisor");
    expect(manifest.assets).toHaveLength(8);
    const files = readdirSync(path.join(root, "knowledge", "documents")).filter((file) => file.endsWith(".md"));
    expect(files).toHaveLength(8);
    expect(new Set(manifest.assets.map((asset) => asset.file))).toEqual(new Set(files));
    const taskIds = new Set(manifest.assets.flatMap((asset) => asset.taskIds));
    for (let index = 1; index <= 6; index += 1) expect(taskIds.has(`IA-GT-0${index}`)).toBe(true);
  });

  it("ships a safe auto-insurance orchestration skill without static business data", () => {
    const skillDir = path.join(root, "skills", "auto-insurance-advisor");
    const parsed = parseSkillSourceDirectory(skillDir, "auto-insurance-advisor");
    expect(parsed.skillId).toBe("auto-insurance-advisor");
    expect(parsed.manifest?.version).toBe("1.0.0");
    expect(parsed.warnings).toEqual([]);
    const markdown = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    expect(markdown).toContain("客户画像和产品事实必须来自本轮已授权 MCP");
    expect(markdown).toContain("`insurance-telesales-recommend`");
    expect(markdown).toContain("`goldencoach-stage-evaluation`");
    expect(markdown).toContain("`save_product` 不属于本岗位可用能力");
    expect(markdown).not.toMatch(/张先生|李女士|CUST[-_]/);
  });

  it("defines normal, deny, degraded and source paths for all six tasks", () => {
    for (let index = 1; index <= 6; index += 1) {
      const taskId = `IA-GT-0${index}`;
      const file = path.join(root, "eval", `ia-gt-0${index}-cases.json`);
      const suite = JSON.parse(readFileSync(file, "utf8")) as {
        taskId: string;
        roleTemplate: string;
        cases: Array<{ path: string; assertions: string[] }>;
      };
      expect(suite.taskId).toBe(taskId);
      expect(suite.roleTemplate).toBe("insurance-advisor");
      const expectedPaths = index === 1
        ? new Set(["NORMAL", "DENY", "DEGRADED", "SOURCE", "CONFIRM"])
        : new Set(["NORMAL", "DENY", "DEGRADED", "SOURCE"]);
      expect(new Set(suite.cases.map((item) => item.path))).toEqual(expectedPaths);
      expect(suite.cases.every((item) => item.assertions.length >= 3)).toBe(true);
    }
  });

  it("documents the unauthenticated MCP boundary as Demo/Shadow only", () => {
    const readme = readFileSync(path.join(root, "README.md"), "utf8");
    expect(readme).toContain("Demo/Shadow Ready");
    expect(readme).toContain("JWKS 验签");
    expect(readme).toContain("`save_product` 保持停用");
  });
});
