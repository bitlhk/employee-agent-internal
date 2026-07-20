import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import {
  getDefaultAgentRoleTemplate,
  getRoleSkillMcpBaseline,
  getSkillMcpRequirement,
  listAgentRoleTemplates,
  resetRoleTemplateCacheForTests,
  resolveAgentRoleTemplate,
} from "./role-templates";

function baseRole(overrides: Record<string, unknown> = {}) {
  return {
    name: "普通助手",
    description: "default",
    status: "mvp",
    displayOrder: 0,
    permissionProfile: "plus",
    defaultVisibleZones: ["opensource"],
    defaultSkills: [],
    optionalSkills: [],
    mcpServers: [],
    mcpTools: [],
    defaultModel: "openai/gpt-5.5",
    runtime: "openclaw",
    dataScope: "none",
    ...overrides,
  };
}

function baseline(overrides: Record<string, unknown> = {}) {
  return {
    version: "test-v1",
    principles: [],
    schema: {
      defaultRole: "general-assistant",
      permissionProfiles: ["plus", "internal"],
      runtimes: ["jiuwenswarm", "openclaw"],
      origins: ["opensource", "finance", "squad"],
      roleStatus: ["mvp", "planned", "disabled"],
      visibleZones: ["opensource", "finance", "squad"],
      notes: [],
    },
    runtimePolicy: {
      defaultRuntime: "openclaw",
      fallbackRuntime: "jiuwenswarm",
      selection: "role-driven",
    },
    skillRequirements: {},
    industries: {
      general: {
        name: "通用",
        roles: {
          "general-assistant": baseRole(),
        },
      },
      banking: {
        name: "银行",
        roles: {
          "wealth-manager": baseRole({
            name: "财富经理",
            displayOrder: 10,
            permissionProfile: "internal",
            defaultVisibleZones: ["squad", "finance"],
            defaultSkills: ["wealth-manager-assistant"],
            mcpServers: ["customer_context_tool"],
          }),
        },
      },
      insurance: { name: "保险", roles: {} },
      securities: { name: "证券", roles: {} },
    },
    ...overrides,
  };
}

function withBaselineFile(payload: unknown, fn: () => void) {
  const root = mkdtempSync(path.join(os.tmpdir(), "role-baseline-"));
  const file = path.join(root, "baseline.json");
  const previous = process.env.ROLE_SKILL_MCP_BASELINE_PATH;
  try {
    writeFileSync(file, JSON.stringify(payload), "utf8");
    process.env.ROLE_SKILL_MCP_BASELINE_PATH = file;
    resetRoleTemplateCacheForTests();
    fn();
  } finally {
    if (previous === undefined) delete process.env.ROLE_SKILL_MCP_BASELINE_PATH;
    else process.env.ROLE_SKILL_MCP_BASELINE_PATH = previous;
    resetRoleTemplateCacheForTests();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("role template baseline loader", () => {
  afterEach(() => resetRoleTemplateCacheForTests());

  it("loads and flattens role templates from a valid baseline", () => {
    withBaselineFile(baseline(), () => {
      const loaded = getRoleSkillMcpBaseline();
      const roles = listAgentRoleTemplates();

      expect(loaded.version).toBe("test-v1");
      expect(roles.map((role) => role.id)).toEqual(["general-assistant", "wealth-manager"]);
      expect(getDefaultAgentRoleTemplate().id).toBe("general-assistant");
      expect(resolveAgentRoleTemplate("wealth-manager").industry).toBe("banking");
      expect(resolveAgentRoleTemplate(null).id).toBe("general-assistant");
    });
  });

  it("loads optional per-skill MCP requirements without affecting older baselines", () => {
    withBaselineFile(baseline({
      skillRequirements: {
        "wealth-manager-assistant": {
          servers: {
            wealth_customer: ["context_probe", "customer_list"],
          },
        },
      },
    }), () => {
      expect(getSkillMcpRequirement("wealth-manager-assistant")).toEqual({
        servers: {
          wealth_customer: ["context_probe", "customer_list"],
        },
      });
      expect(getSkillMcpRequirement("plain-skill")).toEqual({ servers: {} });
    });
  });

  it("fails fast when the default role is missing", () => {
    const bad = baseline({
      schema: {
        ...baseline().schema,
        defaultRole: "missing-role",
      },
      industries: {
        ...baseline().industries,
        general: {
          name: "通用",
          roles: {},
        },
      },
    });

    withBaselineFile(bad, () => {
      expect(() => getRoleSkillMcpBaseline()).toThrow(/default role not found/i);
    });
  });

  it("fails fast on unknown runtime values", () => {
    const bad = baseline({
      industries: {
        ...baseline().industries,
        general: {
          name: "通用",
          roles: {
            "general-assistant": baseRole({ runtime: "bad-runtime" }),
          },
        },
      },
    });

    withBaselineFile(bad, () => {
      expect(() => getRoleSkillMcpBaseline()).toThrow();
    });
  });

  it("fails fast when a role id appears in more than one industry", () => {
    const bad = baseline({
      industries: {
        ...baseline().industries,
        insurance: {
          name: "保险",
          roles: {
            "wealth-manager": baseRole({ name: "重复财富经理", displayOrder: 20 }),
          },
        },
      },
    });

    withBaselineFile(bad, () => {
      expect(() => getRoleSkillMcpBaseline()).toThrow(/duplicate role template id/i);
    });
  });

  it("rejects unknown requested role ids", () => {
    withBaselineFile(baseline(), () => {
      expect(() => resolveAgentRoleTemplate("not-a-role")).toThrow(/unknown role template/i);
    });
  });
});
