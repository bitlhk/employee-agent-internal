import { describe, expect, it } from "vitest";
import { inferMcpServerFromOpenClawToolName, inferSkillIdFromToolArgs } from "./openclaw-tool-audit";

describe("openclaw tool audit", () => {
  it("infers skill id from common skill paths", () => {
    expect(inferSkillIdFromToolArgs({ command: "python /workspace/skills/wealth-healthcheck/scripts/run.py" })).toBe("wealth-healthcheck");
    expect(inferSkillIdFromToolArgs({ path: "/home/ubuntu/.agents/skills/market-data-skill/SKILL.md" })).toBe("market-data-skill");
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
    expect(inferMcpServerFromOpenClawToolName("mcp_market_data__get_quote")).toBe("market_data");
    expect(inferMcpServerFromOpenClawToolName("execute_cmd")).toBeNull();
  });
});
