import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, lstatSync, symlinkSync } from "fs";
import os from "os";
import path from "path";
import { applyOpenClawRoleScope, applyOpenClawRoleScopeToConfig } from "./openclaw-role-scope";
import type { EffectiveRoleAssets } from "./role-asset-grants";

const effectiveAssets: EffectiveRoleAssets = {
  skills: {
    default: ["wealth-manager-assistant"],
    optional: ["market-data-skill"],
  },
  mcpServers: {
    default: ["customer_context_tool"],
    optional: ["market_data_tool"],
  },
};

describe("openclaw role scope", () => {
  it("writes agent skill allowlist and MCP codex agent projection", () => {
    const config: any = {
      agents: {
        list: [
          { id: "trial_lgc-test", skills: ["old-skill"] },
        ],
      },
      mcp: {
        servers: {
          customer_context_tool: { codex: { agents: [] } },
          market_data_tool: { codex: { agents: ["trial_lgc-test"] } },
          public_data_docs: {},
        },
      },
    };

    const result = applyOpenClawRoleScopeToConfig(config, "trial_lgc-test", effectiveAssets);

    expect(result).toEqual({
      agentFound: true,
      skillAllowlistChanged: true,
      mcpProjectionChanged: true,
    });
    expect(config.agents.list[0].skills).toEqual(["wealth-manager-assistant"]);
    expect(config.mcp.servers.customer_context_tool.codex.agents).toEqual(["trial_lgc-test"]);
    expect(config.mcp.servers.market_data_tool.codex.agents).toEqual([]);
    expect(config.mcp.servers.public_data_docs.codex.agents).toBeUndefined();
  });

  it("keeps caller-provided active personal skills in the agent allowlist", () => {
    const config: any = {
      agents: {
        list: [
          { id: "trial_lgc-test", skills: ["old-skill"] },
        ],
      },
      mcp: { servers: {} },
    };

    const result = applyOpenClawRoleScopeToConfig(
      config,
      "trial_lgc-test",
      effectiveAssets,
      ["uploaded-personal-skill"],
    );

    expect(result.skillAllowlistChanged).toBe(true);
    expect(config.agents.list[0].skills).toEqual([
      "uploaded-personal-skill",
      "wealth-manager-assistant",
    ]);
  });

  it("removes a user-disabled default while keeping active personal skills", () => {
    const config: any = {
      agents: {
        list: [
          { id: "trial_lgc-test", skills: ["wealth-manager-assistant"] },
        ],
      },
      mcp: { servers: {} },
    };

    applyOpenClawRoleScopeToConfig(
      config,
      "trial_lgc-test",
      effectiveAssets,
      ["uploaded-personal-skill"],
      ["wealth-manager-assistant"],
    );

    expect(config.agents.list[0].skills).toEqual(["uploaded-personal-skill"]);
  });

  it("links caller-provided active marketplace skills without auto-linking all optional grants", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-role-scope-active-"));
    try {
      const configPath = path.join(root, "openclaw.json");
      const workspace = path.join(root, "workspace");
      const shared = path.join(root, "skills-shared");
      mkdirSync(path.join(workspace, "skills"), { recursive: true });
      mkdirSync(path.join(shared, "wealth-manager-assistant"), { recursive: true });
      mkdirSync(path.join(shared, "installed-optional"), { recursive: true });
      mkdirSync(path.join(shared, "market-data-skill"), { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          agents: { list: [{ id: "trial_lgc-test", workspace, skills: [] }] },
          mcp: { servers: {} },
        }),
        "utf8",
      );

      const result = applyOpenClawRoleScope({
        configPath,
        agentId: "trial_lgc-test",
        effectiveAssets,
        sharedSkillsDir: shared,
        activeSkillIds: ["installed-optional"],
      });

      expect(result.linkedSharedSkills).toEqual(["installed-optional", "wealth-manager-assistant"]);
      expect(existsSync(path.join(workspace, "skills", "installed-optional"))).toBe(true);
      expect(existsSync(path.join(workspace, "skills", "market-data-skill"))).toBe(false);
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      expect(config.agents.list[0].skills).toEqual(["installed-optional", "wealth-manager-assistant"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses config workspace, links allowed shared skills, and removes disallowed shared links", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-role-scope-"));
    try {
      const configPath = path.join(root, "openclaw.json");
      const workspace = path.join(root, "custom-workspace");
      const shared = path.join(root, "skills-shared");
      mkdirSync(path.join(workspace, "skills"), { recursive: true });
      mkdirSync(path.join(shared, "wealth-manager-assistant"), { recursive: true });
      mkdirSync(path.join(shared, "old-skill"), { recursive: true });
      writeFileSync(path.join(shared, "wealth-manager-assistant", "SKILL.md"), "# Wealth\n", "utf8");
      writeFileSync(path.join(shared, "old-skill", "SKILL.md"), "# Old\n", "utf8");
      writeFileSync(
        configPath,
        JSON.stringify({
          agents: { list: [{ id: "trial_lgc-test", workspace, skills: ["old-skill"] }] },
          mcp: { servers: { customer_context_tool: {} } },
        }),
        "utf8",
      );
      const oldLink = path.join(workspace, "skills", "old-skill");
      const oldTarget = path.relative(path.dirname(oldLink), path.join(shared, "old-skill"));
      symlinkSync(oldTarget, oldLink, "dir");

      const result = applyOpenClawRoleScope({
        configPath,
        agentId: "trial_lgc-test",
        effectiveAssets,
        workspaceDir: path.join(root, "wrong-workspace"),
        sharedSkillsDir: shared,
      });

      expect(result.removedSharedSkills).toEqual(["old-skill"]);
      expect(result.linkedSharedSkills).toEqual(["wealth-manager-assistant"]);
      expect(existsSync(oldLink)).toBe(false);
      expect(lstatSync(path.join(workspace, "skills", "wealth-manager-assistant")).isSymbolicLink()).toBe(true);
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      expect(config.agents.list[0].skills).toEqual(["wealth-manager-assistant"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
