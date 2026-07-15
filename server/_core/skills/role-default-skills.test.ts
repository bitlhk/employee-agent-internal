import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import type { Skill } from "../../../shared/types/skill";
import { mergeRoleDefaultSkills } from "./role-default-skills";

describe("role default skill projection", () => {
  it("shows runtime-linked defaults even when the personal registry is empty", () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "ea-role-default-skill-"));
    try {
      const skillDir = path.join(workspace, "skills", "post-loan-risk-prediction");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(path.join(skillDir, "SKILL.md"), [
        "---",
        "name: 企业贷后风控预测",
        "description: 识别贷后风险信号并生成处置建议。",
        "version: 1.0.0",
        "---",
        "# 企业贷后风控预测",
        "",
        "识别贷后风险信号并生成处置建议。",
      ].join("\n"), "utf8");

      const skills = mergeRoleDefaultSkills({
        adoptId: "lgj-test",
        defaultSkillIds: ["post-loan-risk-prediction"],
        registeredSkills: [],
        runtimeWorkspaceDir: workspace,
        now: new Date("2026-07-14T00:00:00.000Z"),
      });

      expect(skills).toHaveLength(1);
      expect(skills[0]).toMatchObject({
        id: "post-loan-risk-prediction",
        adoptId: "lgj-test",
        source: {
          kind: "role_default",
          displayName: "企业贷后风控预测",
        },
        state: "ready",
        enabled: true,
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("projects current defaults and hides stale role defaults", () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "ea-role-default-switch-"));
    const timestamp = "2026-07-14T00:00:00.000Z";
    const makeSkill = (id: string, kind: Skill["source"]["kind"]): Skill => ({
      id,
      adoptId: "lgj-test",
      source: { kind, skillId: id, displayName: id },
      state: "ready",
      enabled: true,
      review: { state: "none" },
      sync: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    try {
      for (const id of ["current-default", "stale-default"]) {
        const dir = path.join(workspace, "skills", id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "SKILL.md"), `# ${id}\n`, "utf8");
      }
      const skills = mergeRoleDefaultSkills({
        adoptId: "lgj-test",
        defaultSkillIds: ["current-default"],
        registeredSkills: [
          makeSkill("current-default", "marketplace"),
          makeSkill("stale-default", "role_default"),
          makeSkill("personal", "uploaded"),
        ],
        runtimeWorkspaceDir: workspace,
      });

      expect(skills.map((skill) => [skill.id, skill.source.kind])).toEqual([
        ["current-default", "role_default"],
        ["personal", "uploaded"],
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps a disabled role default visible without treating it as runnable", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-role-default-disabled-"));
    try {
      const workspace = path.join(root, "workspace");
      const shared = path.join(root, "shared");
      const sourceDir = path.join(shared, "default-skill");
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(path.join(sourceDir, "SKILL.md"), [
        "---",
        "name: Default Skill",
        "description: Default role capability.",
        "---",
        "# Default Skill",
        "",
        "Default role capability.",
      ].join("\n"), "utf8");

      const skills = mergeRoleDefaultSkills({
        adoptId: "lgj-test",
        defaultSkillIds: ["default-skill"],
        disabledDefaultSkillIds: ["default-skill"],
        registeredSkills: [],
        runtimeWorkspaceDir: workspace,
        skillSourceDirs: [shared],
      });

      expect(skills[0]).toMatchObject({
        id: "default-skill",
        enabled: false,
        state: "disabled",
        source: {
          kind: "role_default",
          displayName: "Default Skill",
          sourcePath: sourceDir,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
