import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { FileRoleSkillPreferences } from "./role-skill-preferences";

describe("role skill preferences", () => {
  it("persists disabled defaults per agent and restores them independently", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-role-skill-preferences-"));
    try {
      const filePath = path.join(root, "preferences.json");
      const preferences = new FileRoleSkillPreferences(filePath);
      preferences.setDefaultSkillEnabled("lgj-a", "skill-b", false);
      preferences.setDefaultSkillEnabled("lgj-a", "skill-a", false);
      preferences.setDefaultSkillEnabled("lgj-b", "skill-c", false);

      const reloaded = new FileRoleSkillPreferences(filePath);
      expect(reloaded.getDisabledDefaultSkillIds("lgj-a")).toEqual(["skill-a", "skill-b"]);
      expect(reloaded.getDisabledDefaultSkillIds("lgj-b")).toEqual(["skill-c"]);

      reloaded.setDefaultSkillEnabled("lgj-a", "skill-a", true);
      expect(reloaded.getDisabledDefaultSkillIds("lgj-a")).toEqual(["skill-b"]);
      reloaded.clear("lgj-a");
      expect(reloaded.getDisabledDefaultSkillIds("lgj-a")).toEqual([]);
      expect(reloaded.getDisabledDefaultSkillIds("lgj-b")).toEqual(["skill-c"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
