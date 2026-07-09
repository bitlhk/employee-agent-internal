import { describe, expect, it } from "vitest";
import { inferMcpServerFromOpenClawToolName, inferSkillIdFromToolArgs } from "./openclaw-tool-audit";

describe("openclaw tool audit", () => {
  it("infers skill id from common skill paths", () => {
    expect(inferSkillIdFromToolArgs({ command: "python /workspace/skills/wealth-healthcheck/scripts/run.py" })).toBe("wealth-healthcheck");
    expect(inferSkillIdFromToolArgs({ path: "/home/ubuntu/.agents/skills/wind-mcp-skill/SKILL.md" })).toBe("wind-mcp-skill");
    expect(inferSkillIdFromToolArgs({ path: "/tmp/temp-skills/skills/insurance-advisor/SKILL.md" })).toBe("insurance-advisor");
  });

  it("infers skill id from explicit fields", () => {
    expect(inferSkillIdFromToolArgs({ skillId: "company-deep-analysis" })).toBe("company-deep-analysis");
    expect(inferSkillIdFromToolArgs({ nested: { skill_name: "wealth-manager-assistant" } })).toBe("wealth-manager-assistant");
  });

  it("returns null when no skill marker exists", () => {
    expect(inferSkillIdFromToolArgs({ command: "echo hello" })).toBeNull();
  });

  it("maps business tool names to MCP server ids", () => {
    expect(inferMcpServerFromOpenClawToolName("mcp_demo_server__lookup_customer")).toBe("demo_server");
    expect(inferMcpServerFromOpenClawToolName("get_bond_valuation")).toBe("wind_bond_data");
    expect(inferMcpServerFromOpenClawToolName("execute_cmd")).toBeNull();
  });
});
