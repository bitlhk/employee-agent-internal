import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { missingDefaultRoleSkills } from "./role-runtime-adapters";

describe("role runtime default skill preflight", () => {
  it("reports only default skills that do not have a deployable SKILL.md", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-role-preflight-"));
    try {
      const ready = path.join(root, "ready-skill");
      const incomplete = path.join(root, "incomplete-skill");
      mkdirSync(ready, { recursive: true });
      mkdirSync(incomplete, { recursive: true });
      writeFileSync(path.join(ready, "SKILL.md"), "# Ready\n", "utf8");

      expect(missingDefaultRoleSkills(
        ["ready-skill", "missing-skill", "incomplete-skill", "missing-skill"],
        [root],
      )).toEqual(["incomplete-skill", "missing-skill"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
