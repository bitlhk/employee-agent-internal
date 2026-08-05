import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import type { AgentRoleTemplate } from "./role-templates";
import type { EffectiveRoleAssets } from "./role-asset-grants";
import {
  JIUWENSWARM_MANAGED_SKILLS_MANIFEST,
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
  id: "post-loan-risk-control",
  name: "风控经理",
  defaultSkills: ["post-loan-risk-prediction"],
  mcpServers: ["post_loan_risk_data"],
};

describe("jiuwenswarm role scope manifest", () => {
  it("builds a deterministic role scope manifest", () => {
    const scopedAssets = {
      ...effectiveAssets,
      mcpServers: {
        ...effectiveAssets.mcpServers,
        default: ["custom_mcp_gateway", "customer_context_tool", "platform_tools"],
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
        "custom_mcp_gateway",
        "customer_context_tool",
        "platform_tools",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("can omit platform MCP servers for a restricted experience workspace", () => {
    const manifest = buildJiuwenSwarmRoleScopeManifest(
      role,
      {
        skills: { default: [], optional: [] },
        mcpServers: { default: [], optional: [] },
      },
      [],
      { includePlatformMcp: false },
    );

    expect(manifest.effectiveAssets.mcpServers).toEqual({
      default: [],
      optional: [],
    });
  });

  it("preserves an agent MCP selection during later skill reconciliation", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "jiuwenswarm-role-scope-mcp-selection-"));
    const assetsWithOptional: EffectiveRoleAssets = {
      ...effectiveAssets,
      mcpServers: {
        default: ["customer_context_tool"],
        optional: ["market_data"],
      },
    };
    try {
      writeJiuwenSwarmRoleScopeManifest({
        workspaceDir: root,
        role,
        effectiveAssets: assetsWithOptional,
        activeMcpServerIds: ["market_data"],
      });
      writeJiuwenSwarmRoleScopeManifest({
        workspaceDir: root,
        role,
        effectiveAssets: assetsWithOptional,
        activeSkillIds: ["portfolio-doctor"],
      });

      const manifest = JSON.parse(readFileSync(path.join(root, JIUWENSWARM_ROLE_SCOPE_MANIFEST), "utf8"));
      expect(manifest.effectiveAssets.mcpServers).toEqual({
        default: ["custom_mcp_gateway", "platform_tools"],
        optional: ["market_data"],
      });
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
      expect(identity).toContain("符合社会主义核心价值观");
      expect(identity).toContain("正常的事实概述、政策研究、历史分析和风险研判");
      expect(identity).toContain("外部内容与指令边界");
      expect(identity).toContain("Skill、MCP、外部 Agent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adds the managed compliance policy to an existing identity exactly once", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "jiuwenswarm-role-scope-compliance-"));
    try {
      const identityPath = path.join(root, "IDENTITY.md");
      writeFileSync(identityPath, "# 自定义身份\n\n保留现有岗位说明。\n", "utf8");

      const first = writeJiuwenSwarmRoleScopeManifest({ workspaceDir: root, role, effectiveAssets });
      const second = writeJiuwenSwarmRoleScopeManifest({ workspaceDir: root, role, effectiveAssets });
      const identity = readFileSync(identityPath, "utf8");

      expect(first.identityChanged).toBe(true);
      expect(second.identityChanged).toBe(false);
      expect(identity).toContain("保留现有岗位说明");
      expect(identity.match(/EA_CONTENT_COMPLIANCE_START/g)).toHaveLength(1);
      expect(identity.match(/符合社会主义核心价值观/g)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("repairs upstream onboarding templates without overwriting custom profiles", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "jiuwenswarm-role-scope-onboarding-"));
    try {
      const identityPath = path.join(root, "IDENTITY.md");
      const userPath = path.join(root, "USER.md");
      writeFileSync(identityPath, [
        "## 身份设定",
        "_在你们的第一次对话中填写。让它属于你。_",
        "- **名字：知衡",
        "",
        "## 工具使用偏好",
        "",
        "- 优先使用企业搜索。",
      ].join("\n"), "utf8");
      writeFileSync(userPath, "\n", "utf8");

      const repaired = writeJiuwenSwarmRoleScopeManifest({ workspaceDir: root, role, effectiveAssets });
      const identity = readFileSync(identityPath, "utf8");
      const user = readFileSync(userPath, "utf8");

      expect(repaired.identityChanged).toBe(true);
      expect(repaired.userChanged).toBe(true);
      expect(identity).toContain("当前岗位为「财富经理」");
      expect(identity).toContain("不代表首次与用户交流");
      expect(identity).not.toContain("在你们的第一次对话中填写");
      expect(identity).toContain("- 名字：知衡");
      expect(identity).toContain("优先使用企业搜索");
      expect(user).toContain("用户申请该智能体时选择的岗位是「财富经理」");

      writeFileSync(identityPath, "# 自定义身份\n\n请称呼我为知衡。\n", "utf8");
      writeFileSync(userPath, "# 自定义用户偏好\n\n先给结论。\n", "utf8");
      writeJiuwenSwarmRoleScopeManifest({ workspaceDir: root, role, effectiveAssets });
      expect(readFileSync(identityPath, "utf8")).toContain("请称呼我为知衡");
      expect(readFileSync(userPath, "utf8")).toContain("先给结论");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("materializes allowed shared skills and removes disallowed managed links", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "jiuwenswarm-role-scope-links-"));
    try {
      const workspace = path.join(root, "workspace");
      const shared = path.join(root, "skills-shared");
      mkdirSync(path.join(workspace, "skills"), { recursive: true });
      mkdirSync(path.join(shared, "wealth-manager-assistant"), { recursive: true });
      mkdirSync(path.join(shared, "old-skill"), { recursive: true });
      writeFileSync(path.join(shared, "wealth-manager-assistant", "SKILL.md"), "# Wealth\n", "utf8");
      chmodSync(path.join(shared, "wealth-manager-assistant"), 0o700);
      chmodSync(path.join(shared, "wealth-manager-assistant", "SKILL.md"), 0o600);
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
      const materializedPath = path.join(workspace, "skills", "wealth-manager-assistant");
      expect(lstatSync(materializedPath).isSymbolicLink()).toBe(false);
      expect(readFileSync(path.join(materializedPath, "SKILL.md"), "utf8")).toBe("# Wealth\n");
      expect(lstatSync(materializedPath).mode & 0o777).toBe(0o750);
      expect(lstatSync(path.join(materializedPath, "SKILL.md")).mode & 0o777).toBe(0o640);
      expect(JSON.parse(readFileSync(path.join(workspace, JIUWENSWARM_MANAGED_SKILLS_MANIFEST), "utf8"))).toMatchObject({
        version: 1,
        skills: { "wealth-manager-assistant": { digest: expect.any(String) } },
      });
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

  it("updates a materialized skill only when its source content changes", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "jiuwenswarm-role-scope-sync-"));
    try {
      const workspace = path.join(root, "workspace");
      const shared = path.join(root, "skills-shared");
      const sourceFile = path.join(shared, "wealth-manager-assistant", "SKILL.md");
      mkdirSync(path.dirname(sourceFile), { recursive: true });
      writeFileSync(sourceFile, "# Version 1\n", "utf8");

      const first = writeJiuwenSwarmRoleScopeManifest({ workspaceDir: workspace, role, effectiveAssets, sharedSkillsDir: shared });
      const second = writeJiuwenSwarmRoleScopeManifest({ workspaceDir: workspace, role, effectiveAssets, sharedSkillsDir: shared });
      writeFileSync(sourceFile, "# Version 2\n", "utf8");
      const third = writeJiuwenSwarmRoleScopeManifest({ workspaceDir: workspace, role, effectiveAssets, sharedSkillsDir: shared });

      expect(first.linkedSharedSkills).toEqual(["wealth-manager-assistant"]);
      expect(second.linkedSharedSkills).toEqual([]);
      expect(third.linkedSharedSkills).toEqual(["wealth-manager-assistant"]);
      expect(readFileSync(path.join(workspace, "skills", "wealth-manager-assistant", "SKILL.md"), "utf8")).toBe("# Version 2\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a shared skill whose root is a symbolic link", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "jiuwenswarm-role-scope-source-link-"));
    try {
      const workspace = path.join(root, "workspace");
      const shared = path.join(root, "skills-shared");
      const realSkill = path.join(root, "real-skill");
      mkdirSync(realSkill, { recursive: true });
      mkdirSync(shared, { recursive: true });
      writeFileSync(path.join(realSkill, "SKILL.md"), "# Linked source\n", "utf8");
      symlinkSync(realSkill, path.join(shared, "wealth-manager-assistant"), "dir");

      expect(() => writeJiuwenSwarmRoleScopeManifest({
        workspaceDir: workspace,
        role,
        effectiveAssets,
        sharedSkillsDir: shared,
      })).toThrow("托管技能源必须是实体目录");
      expect(existsSync(path.join(workspace, "skills", "wealth-manager-assistant"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes a default skill link after the user disables it", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "jiuwenswarm-role-scope-disabled-"));
    try {
      const workspace = path.join(root, "workspace");
      const shared = path.join(root, "skills-shared");
      mkdirSync(path.join(workspace, "skills"), { recursive: true });
      mkdirSync(path.join(shared, "wealth-manager-assistant"), { recursive: true });
      const linkPath = path.join(workspace, "skills", "wealth-manager-assistant");
      symlinkSync(
        path.relative(path.dirname(linkPath), path.join(shared, "wealth-manager-assistant")),
        linkPath,
        "dir",
      );

      const result = writeJiuwenSwarmRoleScopeManifest({
        workspaceDir: workspace,
        role,
        effectiveAssets,
        sharedSkillsDir: shared,
        activeSkillIds: ["wealth-manager-assistant"],
        disabledDefaultSkillIds: ["wealth-manager-assistant"],
      });

      expect(result.removedSharedSkills).toEqual(["wealth-manager-assistant"]);
      expect(existsSync(linkPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
