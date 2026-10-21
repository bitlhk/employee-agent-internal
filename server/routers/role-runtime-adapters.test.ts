import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { getRoleRuntimeAdapter, missingDefaultRoleSkills } from "./role-runtime-adapters";
import { resolveAgentRoleTemplate } from "../_core/role-templates";

describe("role runtime default skill preflight", () => {
  it("requires the same configured runtime for the general assistant with scheduling skills", () => {
    const previous = process.env.JIUWENCLAW_RUNTIME_ENABLED;
    process.env.JIUWENCLAW_RUNTIME_ENABLED = "false";
    try {
      expect(() => getRoleRuntimeAdapter("jiuwenswarm").provision({
        adoptId: "lgj-test-scheduling", agentId: "test", userId: 1, permissionProfile: "plus", ttlDays: 0,
        role: resolveAgentRoleTemplate("general-assistant"),
        effectiveAssets: { skills: { default: ["scheduling-assistant"], optional: [] }, mcpServers: { default: [], optional: [] } },
      })).toThrow("jiuwenswarm runtime is not enabled");
    } finally {
      if (previous === undefined) delete process.env.JIUWENCLAW_RUNTIME_ENABLED;
      else process.env.JIUWENCLAW_RUNTIME_ENABLED = previous;
    }
  });
  it("exposes only the active JiuwenSwarm adapter", () => {
    expect(getRoleRuntimeAdapter("jiuwenswarm").runtime).toBe("jiuwenswarm");
    expect(() => getRoleRuntimeAdapter("openclaw")).toThrow("OpenClaw runtime has been retired");
  });

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
