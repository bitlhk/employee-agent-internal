import { describe, expect, it } from "vitest";
import {
  buildSelectedSkillsManifest,
  normalizeSelectedSkillIds,
  selectAutomaticSkillMatch,
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

  it("automatically matches an enabled skill only for a clear request", () => {
    const skills = [{
      id: "vehicle-insurance-coach",
      enabled: true,
      state: "ready",
      sync: { runtimePath: "/workspace/skills/vehicle-insurance-coach" },
      source: {
        displayName: "车险销售智能陪练",
        description: "模拟客户开展车险销售训练。触发词：模拟陪练功能",
      },
    }];

    expect(selectAutomaticSkillMatch(skills, "开始智能陪练")).toMatchObject({
      skillId: "vehicle-insurance-coach",
      reason: "intent",
    });
    expect(selectAutomaticSkillMatch(skills, "今天天气怎么样")).toBeNull();
  });

  it("does not auto-select a disabled or ambiguous skill", () => {
    const skill = (id: string, name: string, enabled = true) => ({
      id,
      enabled,
      state: enabled ? "ready" : "disabled",
      sync: { runtimePath: `/workspace/skills/${id}` },
      source: { displayName: name, description: `${name}工具` },
    });

    expect(selectAutomaticSkillMatch([
      skill("fund-compare", "场外基金对比"),
      skill("fund-select", "公募基金筛选"),
    ], "帮我分析基金")).toBeNull();
    expect(selectAutomaticSkillMatch([
      skill("vehicle-insurance-coach", "车险销售智能陪练", false),
    ], "开始智能陪练")).toBeNull();
  });

  it("labels automatic selection without claiming the user clicked a chip", () => {
    const manifest = buildSelectedSkillsManifest([{
      id: "vehicle-insurance-coach",
      name: "车险销售智能陪练",
      skillFile: "/workspace/skills/vehicle-insurance-coach/SKILL.md",
      runtimePath: "/workspace/skills/vehicle-insurance-coach",
    }], "开始智能陪练", "automatic");

    expect(manifest).toContain("平台根据用户请求匹配技能");
    expect(manifest).not.toContain("输入框选择技能 Chip");
  });
});
