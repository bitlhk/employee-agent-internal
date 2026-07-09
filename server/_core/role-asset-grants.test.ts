import { describe, expect, it } from "vitest";
import type { AgentRoleTemplate } from "./role-templates";
import {
  buildSeedRoleAssetGrants,
  planRoleAssetSeedSync,
  resolveEffectiveRoleAssetsFromGrants,
  type RoleAssetGrantRecord,
} from "./role-asset-grants";

function role(overrides: Partial<AgentRoleTemplate> = {}): AgentRoleTemplate {
  return {
    id: "wealth-manager",
    industry: "banking",
    industryName: "银行",
    name: "客户经理/财富经理",
    description: "",
    status: "mvp",
    displayOrder: 10,
    permissionProfile: "internal",
    defaultVisibleZones: ["squad", "finance"],
    defaultSkills: ["wealth-manager-assistant", "wealth-manager-assistant"],
    optionalSkills: ["market-data-skill"],
    mcpServers: ["customer_context_tool"],
    mcpTools: ["ignored_tool"],
    defaultModel: "openai/gpt-5.5",
    runtime: "jiuwenswarm",
    dataScope: "",
    ...overrides,
  };
}

describe("role asset grants", () => {
  it("builds seed grants from role default/optional skills and MCP servers only", () => {
    const grants = buildSeedRoleAssetGrants([role()]);

    expect(grants).toEqual([
      {
        roleKey: "wealth-manager",
        assetType: "mcp_server",
        assetId: "customer_context_tool",
        grantMode: "default",
        source: "seed",
        enabled: true,
      },
      {
        roleKey: "wealth-manager",
        assetType: "skill",
        assetId: "market-data-skill",
        grantMode: "optional",
        source: "seed",
        enabled: true,
      },
      {
        roleKey: "wealth-manager",
        assetType: "skill",
        assetId: "wealth-manager-assistant",
        grantMode: "default",
        source: "seed",
        enabled: true,
      },
    ]);
    expect(grants.some((grant) => grant.assetId === "ignored_tool")).toBe(false);
  });

  it("plans seed upsert/prune without touching admin or market grants", () => {
    const desired = buildSeedRoleAssetGrants([role({ defaultSkills: ["new-default"], optionalSkills: [] })]);
    const existing: RoleAssetGrantRecord[] = [
      {
        roleKey: "wealth-manager",
        assetType: "skill",
        assetId: "old-seed",
        grantMode: "default",
        source: "seed",
        enabled: true,
      },
      {
        roleKey: "wealth-manager",
        assetType: "skill",
        assetId: "market-skill",
        grantMode: "optional",
        source: "market",
        enabled: true,
      },
      {
        roleKey: "wealth-manager",
        assetType: "mcp_server",
        assetId: "admin-mcp",
        grantMode: "default",
        source: "admin",
        enabled: true,
      },
    ];

    const plan = planRoleAssetSeedSync(desired, existing);

    expect(plan.prune.map((grant) => grant.assetId)).toEqual(["old-seed"]);
    expect(plan.untouchedDynamic.map((grant) => grant.assetId).sort()).toEqual(["admin-mcp", "market-skill"]);
    expect(plan.upsert.map((grant) => grant.assetId).sort()).toEqual(["customer_context_tool", "new-default"]);
  });

  it("resolves enabled role and wildcard grants with default overriding optional", () => {
    const grants: RoleAssetGrantRecord[] = [
      {
        roleKey: "*",
        assetType: "skill",
        assetId: "common-skill",
        grantMode: "optional",
        source: "market",
        enabled: true,
      },
      {
        roleKey: "wealth-manager",
        assetType: "skill",
        assetId: "common-skill",
        grantMode: "default",
        source: "admin",
        enabled: true,
      },
      {
        roleKey: "wealth-manager",
        assetType: "mcp_server",
        assetId: "customer_context_tool",
        grantMode: "default",
        source: "seed",
        enabled: true,
      },
      {
        roleKey: "wealth-manager",
        assetType: "mcp_server",
        assetId: "disabled_mcp",
        grantMode: "default",
        source: "seed",
        enabled: false,
      },
      {
        roleKey: "insurance-ops",
        assetType: "skill",
        assetId: "other-role-skill",
        grantMode: "default",
        source: "seed",
        enabled: true,
      },
    ];

    expect(resolveEffectiveRoleAssetsFromGrants("wealth-manager", grants)).toEqual({
      skills: {
        default: ["common-skill"],
        optional: [],
      },
      mcpServers: {
        default: ["customer_context_tool"],
        optional: [],
      },
    });
  });
});
