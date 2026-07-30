import { describe, expect, it } from "vitest";
import {
  buildSelectedSkillsManifest,
  normalizeSelectedSkillIds,
  type SelectedRuntimeSkill,
} from "./chat-selected-skills";

describe("selected skills chat context", () => {
  it("normalizes an ordered selection and removes duplicates", () => {
    expect(normalizeSelectedSkillIds(["fund-compare", "risk.review", "fund-compare"])).toEqual({
      ok: true,
      skillIds: ["fund-compare", "risk.review"],
    });
  });

  it("keeps compatibility with the legacy single-skill field", () => {
    expect(normalizeSelectedSkillIds(undefined, "legacy-skill")).toEqual({
      ok: true,
      skillIds: ["legacy-skill"],
    });
  });

  it("rejects oversized and invalid selections", () => {
    expect(normalizeSelectedSkillIds(["one", "two", "three", "four"])).toEqual({
      ok: false,
      error: "每轮最多选择 3 个技能",
    });
    expect(normalizeSelectedSkillIds(["valid", "../invalid"])).toEqual({
      ok: false,
      error: "所选技能标识无效",
    });
  });

  it("builds one compact manifest while preserving skill order and the user request", () => {
    const skills: SelectedRuntimeSkill[] = [
      {
        id: "fund-compare",
        name: "场外基金对比",
        description: "比较基金收益、风险与持仓。",
        skillFile: "/workspace/skills/fund-compare/SKILL.md",
        runtimePath: "/workspace/skills/fund-compare",
      },
      {
        id: "portfolio-report",
        name: "组合报告",
        skillFile: "/workspace/skills/portfolio-report/SKILL.md",
        runtimePath: "/workspace/skills/portfolio-report",
      },
    ];

    const manifest = buildSelectedSkillsManifest(skills, "先比较两只基金，再生成组合建议");

    expect(manifest).toContain("selectedSkillCount: 2");
    expect(manifest.indexOf("fund-compare")).toBeLessThan(manifest.indexOf("portfolio-report"));
    expect(manifest).toContain("根据用户目标决定组合方式和执行顺序");
    expect(manifest).toContain("用户问题：先比较两只基金，再生成组合建议");
  });
});
