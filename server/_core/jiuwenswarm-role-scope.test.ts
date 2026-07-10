import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import type { AgentRoleTemplate } from "./role-templates";
import type { EffectiveRoleAssets } from "./role-asset-grants";
import {
  JIUWENSWARM_ROLE_SCOPE_MANIFEST,
  buildJiuwenSwarmRoleScopeManifest,
  writeJiuwenSwarmRoleScopeManifest,
} from "./jiuwenswarm-role-scope";

const role: AgentRoleTemplate = {
  id: "wealth-manager",
  name: "财富经理",
  industry: "banking",
  status: "mvp",
  permissionProfile: "internal",
  runtime: "jiuwenswarm",
  defaultSkills: ["wealth-manager-assistant"],
  optionalSkills: ["portfolio-doctor"],
  mcpServers: ["customer_context_tool"],
  mcpTools: ["future-tool"],
  defaultVisibleZones: ["squad"],
  dataScope: "客户经理本人授权客户",
  model: "gpt-5.5",
  description: "test",
};

const effectiveAssets: EffectiveRoleAssets = {
  skills: {
    default: ["wealth-manager-assistant"],
    optional: ["portfolio-doctor"],
  },
  mcpServers: {
    default: ["customer_context_tool"],
    optional: [],
  },
};

const riskRole: AgentRoleTemplate = {
  ...role,
  id: "business-review",
  name: "风险管理专员",
  defaultSkills: ["business-review-assistant"],
  mcpServers: ["business_assessment_tool"],
};

describe("jiuwenswarm role scope manifest", () => {
  it("builds a deterministic role scope manifest", () => {
    const scopedAssets = {
      ...effectiveAssets,
      mcpServers: {
        ...effectiveAssets.mcpServers,
        default: ["customer_context_tool", "platform_tools"],
      },
    };
    expect(buildJiuwenSwarmRoleScopeManifest(role, effectiveAssets)).toEqual({
      version: 1,
      runtime: "jiuwenswarm",
      role: {
        id: "wealth-manager",
        name: "财富经理",
        industry: "banking",
        status: "mvp",
      },
      effectiveAssets: scopedAssets,
      enforcement: {
        skills: "per-agent-workspace",
        mcp: "service-side-agent-context",
      },
    });
  });

  it("writes the manifest idempotently and creates the skills directory", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "jiuwenswarm-role-scope-"));
    try {
      const first = writeJiuwenSwarmRoleScopeManifest({ workspaceDir: root, role, effectiveAssets });
      const second = writeJiuwenSwarmRoleScopeManifest({ workspaceDir: root, role, effectiveAssets });

      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
      expect(first.manifestPath).toBe(path.join(root, JIUWENSWARM_ROLE_SCOPE_MANIFEST));
      expect(JSON.parse(readFileSync(first.manifestPath, "utf8")).effectiveAssets.mcpServers.default).toEqual([
        "customer_context_tool",
        "platform_tools",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes external-agent routing guidance into JiuwenSwarm identity", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "jiuwenswarm-role-scope-risk-"));
    try {
      const result = writeJiuwenSwarmRoleScopeManifest({
        workspaceDir: root,
        role: riskRole,
        effectiveAssets,
      });
      const identityPath = path.join(root, "IDENTITY.md");
      expect(result.identityChanged).toBe(true);
      const identity = readFileSync(identityPath, "utf8");
      expect(identity).toContain("轻量数据查询");
      expect(identity).toContain("优先使用本地已安装的岗位技能和已授权 MCP");
      expect(identity).toContain("完整评估");
      expect(identity).toContain("远程 Agent 异步任务");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("links allowed shared skills and removes disallowed shared links", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "jiuwenswarm-role-scope-links-"));
    try {
      const workspace = path.join(root, "workspace");
      const shared = path.join(root, "skills-shared");
      mkdirSync(path.join(workspace, "skills"), { recursive: true });
      mkdirSync(path.join(shared, "wealth-manager-assistant"), { recursive: true });
      mkdirSync(path.join(shared, "old-skill"), { recursive: true });
      writeFileSync(path.join(shared, "wealth-manager-assistant", "SKILL.md"), "# Wealth\n", "utf8");
      writeFileSync(path.join(shared, "old-skill", "SKILL.md"), "# Old\n", "utf8");

      const oldLink = path.join(workspace, "skills", "old-skill");
      symlinkSync(path.relative(path.dirname(oldLink), path.join(shared, "old-skill")), oldLink, "dir");

      const result = writeJiuwenSwarmRoleScopeManifest({
        workspaceDir: workspace,
        role,
        effectiveAssets,
        sharedSkillsDir: shared,
      });

      expect(result.linkedSharedSkills).toEqual(["wealth-manager-assistant"]);
      expect(result.removedSharedSkills).toEqual(["old-skill"]);
      expect(existsSync(oldLink)).toBe(false);
      expect(lstatSync(path.join(workspace, "skills", "wealth-manager-assistant")).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("links installed active skills without linking every optional role grant", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "jiuwenswarm-role-scope-active-links-"));
    try {
      const workspace = path.join(root, "workspace");
      const shared = path.join(root, "skills-shared");
      mkdirSync(path.join(workspace, "skills"), { recursive: true });
      mkdirSync(path.join(shared, "wealth-manager-assistant"), { recursive: true });
      mkdirSync(path.join(shared, "installed-optional"), { recursive: true });
      mkdirSync(path.join(shared, "portfolio-doctor"), { recursive: true });

      const result = writeJiuwenSwarmRoleScopeManifest({
        workspaceDir: workspace,
        role,
        effectiveAssets,
        sharedSkillsDir: shared,
        activeSkillIds: ["installed-optional"],
      });

      expect(result.linkedSharedSkills).toEqual(["installed-optional", "wealth-manager-assistant"]);
      expect(existsSync(path.join(workspace, "skills", "installed-optional"))).toBe(true);
      expect(existsSync(path.join(workspace, "skills", "portfolio-doctor"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
