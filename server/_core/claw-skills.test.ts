import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  managedSkillPathReason,
  shouldDiscoverGeneratedRuntimeSkill,
} from "./skills/skill-discovery";

function tempRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "ea-claw-skills-"));
}

function makeSkillDir(root: string, name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `# ${name}\n`, "utf-8");
  return dir;
}

describe("generated runtime skill discovery", () => {
  it("accepts real workspace skill directories", () => {
    const root = tempRoot();
    const skillDir = makeSkillDir(root, "personal-skill");

    expect(shouldDiscoverGeneratedRuntimeSkill(skillDir, [])).toEqual({ ok: true });
  });

  it("does not auto-register managed symlink skills as generated", () => {
    const root = tempRoot();
    const approvedRoot = path.join(root, "approved");
    const workspaceSkills = path.join(root, "workspace", "skills");
    const approvedSkill = makeSkillDir(approvedRoot, "market-skill");
    mkdirSync(workspaceSkills, { recursive: true });
    const linkedSkill = path.join(workspaceSkills, "market-skill");
    symlinkSync(path.relative(workspaceSkills, approvedSkill), linkedSkill, "dir");

    expect(existsSync(path.join(linkedSkill, "SKILL.md"))).toBe(true);
    expect(shouldDiscoverGeneratedRuntimeSkill(linkedSkill, [approvedRoot])).toEqual({
      ok: false,
      reason: "managed_or_shared_skill_link",
    });
  });

  it("does not auto-register skills under managed source roots", () => {
    const root = tempRoot();
    const approvedRoot = path.join(root, "approved");
    const approvedSkill = makeSkillDir(approvedRoot, "market-skill");

    expect(shouldDiscoverGeneratedRuntimeSkill(approvedSkill, [approvedRoot])).toEqual({
      ok: false,
      reason: "managed_or_shared_skill_source",
    });
  });

  it("identifies historical generated records backed by managed paths", () => {
    const root = tempRoot();
    const approvedRoot = path.join(root, "approved");
    const workspaceSkills = path.join(root, "workspace", "skills");
    const approvedSkill = makeSkillDir(approvedRoot, "market-skill");
    const personalSkill = makeSkillDir(path.join(root, "workspace", "personal"), "personal-skill");
    mkdirSync(workspaceSkills, { recursive: true });
    const linkedSkill = path.join(workspaceSkills, "market-skill");
    symlinkSync(path.relative(workspaceSkills, approvedSkill), linkedSkill, "dir");

    expect(managedSkillPathReason(linkedSkill, [approvedRoot])).toBe("managed_or_shared_skill_link");
    expect(managedSkillPathReason(approvedSkill, [approvedRoot])).toBe("managed_or_shared_skill_source");
    expect(managedSkillPathReason(personalSkill, [approvedRoot])).toBeNull();
  });
});
