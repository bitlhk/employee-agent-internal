import { describe, expect, it } from "vitest";
import {
  buildEnterpriseSelectedSkillsManifest,
  buildSelectedSkillsManifest,
  normalizeSelectedSkillIds,
  selectAutomaticSkillMatch,
  type SelectedRuntimeSkill,
} from "./chat-selected-skills";

describe("selected skills chat context", () => {
  const sessionSkills = [{
    id: "sales-coach",
    enabled: true,
    state: "ready",
    sync: { runtimePath: "/workspace/skills/sales-coach" },
    source: { displayName: "销售陪练", description: "销售话术模拟与复盘" },
  }];

  it("normalizes an ordered selection and removes duplicates", () => {
    expect(normalizeSelectedSkillIds(["fund-compare", "risk.review", "fund-compare"])).toEqual({
      ok: true,
      skillIds: ["fund-compare", "risk.review"],
    });
  });

  it("reuses the most recent session skill for an explicit continuation", () => {
    const now = new Date("2026-08-05T10:00:00.000Z");
    expect(selectAutomaticSkillMatch(sessionSkills, "继续优化一下", [{
      skillId: "sales-coach",
      useCount: 3,
      lastSelectedAt: new Date("2026-08-05T09:55:00.000Z"),
    }], now)).toMatchObject({ skillId: "sales-coach", reason: "session" });
  });

  it("does not carry a session skill into an unrelated request", () => {
    const now = new Date("2026-08-05T10:00:00.000Z");
    expect(selectAutomaticSkillMatch(sessionSkills, "今天天气怎么样", [{
      skillId: "sales-coach",
      useCount: 8,
      lastSelectedAt: new Date("2026-08-05T09:59:00.000Z"),
    }], now)).toBeNull();
  });

  it("keeps compatibility with the legacy single-skill field", () => {
    expect(normalizeSelectedSkillIds(undefined, "legacy-skill")).toEqual({
      ok: true,
      skillIds: ["legacy-skill"],
    });
  });

  it("treats an absent legacy selection as an empty explicit selection", () => {
    expect(normalizeSelectedSkillIds(undefined, undefined)).toEqual({
      ok: true,
      skillIds: [],
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
    expect(manifest).toContain("不得再用 glob、list_files、find、bash");
    expect(manifest).toContain("读取 SKILL.md 成功后应立即按其中任务路由调用已授权业务工具");
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

  it("uses deterministic name, trigger, and description matches", () => {
    const skill = (id: string, name: string, description: string) => ({
      id,
      enabled: true,
      state: "ready",
      sync: { runtimePath: `/workspace/skills/${id}` },
      source: { displayName: name, description },
    });

    expect(selectAutomaticSkillMatch([
      skill("previsit", "客户访前准备助手", "生成内部访前材料"),
    ], "请使用客户访前准备助手")).toMatchObject({ reason: "name" });

    expect(selectAutomaticSkillMatch([
      skill("risk", "财富客户风险分析", "识别客户风险"),
    ], "客户风险分析")).toMatchObject({ reason: "name" });

    expect(selectAutomaticSkillMatch([
      skill("policy", "专项作业", "触发词：保单检查、续期提醒"),
    ], "请做保单检查")).toMatchObject({ reason: "trigger" });

    expect(selectAutomaticSkillMatch([
      skill("allocation", "组合作业", "用于整理客户资产配置建议"),
    ], "资产配置建议")).toMatchObject({ reason: "description" });
  });

  it("ignores invalid and expired session affinity", () => {
    const now = new Date("2026-08-05T10:00:00.000Z");
    expect(selectAutomaticSkillMatch(sessionSkills, "继续", [{
      skillId: "sales-coach",
      useCount: 3,
      lastSelectedAt: "invalid",
    }], now)).toBeNull();
    expect(selectAutomaticSkillMatch(sessionSkills, "继续", [{
      skillId: "sales-coach",
      useCount: 3,
      lastSelectedAt: new Date("2026-08-03T09:00:00.000Z"),
    }], now)).toBeNull();
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

  it("builds a pathless native manifest for the enterprise runtime", () => {
    const manifest = buildEnterpriseSelectedSkillsManifest([{
      id: "auto-insurance-advisor",
      name: "保险顾问助手",
      description: "查询客户画像和保险产品，形成受控建议。",
      skillFile: "/root/control-plane/skills/auto-insurance-advisor/SKILL.md",
      runtimePath: "/root/control-plane/skills/auto-insurance-advisor",
    }], "查询我负责的客户画像和适配产品");

    expect(manifest).toContain("skill_tool");
    expect(manifest).toContain("不要连续重试未知工具");
    expect(manifest).toContain("auto-insurance-advisor");
    expect(manifest).toContain("查询我负责的客户画像和适配产品");
    expect(manifest).not.toContain("/root/control-plane");
    expect(manifest).not.toContain("SKILL.md");
    expect(manifest).not.toContain("read_file");
    expect(manifest).not.toContain("bash");
  });
});
