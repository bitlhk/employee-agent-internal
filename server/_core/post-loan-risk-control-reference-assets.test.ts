import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyPostLoanRiskRolePackBaseline } from "../../scripts/install-post-loan-risk-control-reference-pack";
import { parseSkillSourceDirectory } from "./skills/skill-source";

const root = process.cwd();
const packRoot = path.join(root, "examples", "post-loan-risk-control-reference-role-pack");

describe("post-loan risk control Reference Role Pack assets", () => {
  it("ships a safe top-level role skill that reuses the existing specialist skill", () => {
    const skillRoot = path.join(packRoot, "skills", "post-loan-risk-control-assistant");
    const parsed = parseSkillSourceDirectory(skillRoot, "post-loan-risk-control-assistant");
    const markdown = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
    expect(parsed.warnings).toEqual([]);
    expect(markdown).toContain("post-loan-risk-prediction");
    expect(markdown).toContain("evaluate_post_loan_risk_escalation");
    expect(markdown).toContain("demo_create_followup_task");
  });

  it("maps all six benchmark tasks to governed knowledge assets", () => {
    const manifest = JSON.parse(readFileSync(path.join(packRoot, "knowledge", "manifest.json"), "utf8")) as {
      assets: Array<{ lifecycle: string; taskIds: string[] }>;
    };
    for (let index = 1; index <= 6; index += 1) {
      const taskId = `RC-GT-${String(index).padStart(2, "0")}`;
      expect(manifest.assets.some((asset) => asset.taskIds.includes(taskId))).toBe(true);
    }
    expect(manifest.assets.filter((asset) => asset.lifecycle === "expired")).toHaveLength(1);
  });

  it("adds only the bounded role skill and MCP dependencies to the baseline", () => {
    const baseline = {
      industries: {
        banking: {
          roles: {
            "post-loan-risk-control": {
              defaultSkills: ["post-loan-risk-prediction"],
              optionalSkills: [],
              mcpServers: ["post_loan_risk_data"],
            },
          },
        },
      },
      skillRequirements: {},
    };
    const updated = applyPostLoanRiskRolePackBaseline(baseline);
    const role = updated.industries!.banking.roles!["post-loan-risk-control"]!;
    expect(role.defaultSkills).toEqual(["post-loan-risk-control-assistant", "post-loan-risk-prediction"]);
    expect(role.mcpServers).toEqual(["post_loan_risk_data", "platform_tools", "wealth_governance_demo"]);
    expect(updated.skillRequirements?.["post-loan-risk-control-assistant"]?.servers?.post_loan_risk_data)
      .toContain("get_enterprise_profile");
  });
});
