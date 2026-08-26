import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyPostLoanRiskRolePackBaseline } from "../../scripts/install-post-loan-risk-control-reference-pack";
import { parseSkillSourceDirectory } from "./skills/skill-source";

const root = process.cwd();
const packRoot = path.join(root, "examples", "post-loan-risk-control-reference-role-pack");

describe("post-loan risk control Reference Role Pack assets", () => {
  it("ships a safe top-level role skill with a bounded diagnostic framework", () => {
    const skillRoot = path.join(packRoot, "skills", "post-loan-risk-control-assistant");
    const parsed = parseSkillSourceDirectory(skillRoot, "post-loan-risk-control-assistant");
    const markdown = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
    expect(parsed.warnings).toEqual([]);
    expect(parsed.manifest?.version).toBe("1.2.0");
    expect(markdown).toContain("version: 1.2.0");
    expect(markdown).toContain("references/four-dimension-diagnostic-framework.md");
    expect(markdown).toContain("get_post_loan_risk_snapshot");
    expect(markdown).toContain("snapshotRef");
    expect(markdown).toContain("不得把完整快照交给模型转抄");
    expect(markdown).toContain("risk-control-a2a");
    expect(markdown).toContain("evaluate_post_loan_risk_escalation");
    expect(markdown).toContain("写能力不可用时保留草稿");
  });

  it("ships a snapshot-only A2A executor contract", () => {
    const skillRoot = path.join(packRoot, "a2a", "skills", "post-loan-risk-snapshot-analyst");
    const parsed = parseSkillSourceDirectory(skillRoot, "post-loan-risk-snapshot-analyst");
    const markdown = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
    const agent = JSON.parse(readFileSync(
      path.join(packRoot, "a2a", "risk-control-a2a-agent.example.json"),
      "utf8",
    )) as { endpointConfig?: Record<string, unknown> };

    expect(parsed.warnings).toEqual([]);
    expect(markdown).toContain("ea.post-loan-risk-assessment-request.v1");
    expect(markdown).toContain("version: 1.2.1");
    expect(markdown).toContain("不得超过 4500 个中文字符");
    expect(markdown).toContain("完整 64 位 `snapshotFingerprint`");
    expect(markdown.match(/<ea_final>/g)).toHaveLength(1);
    expect(markdown).not.toContain("</ea_final>");
    expect(markdown).toContain("ea.post-loan-risk-snapshot.v1");
    expect(markdown).toContain("<ea_final>");
    expect(markdown).toContain("禁止调用企业数据 MCP");
    expect(agent.endpointConfig).toMatchObject({
      reuseConversationContext: false,
      requireFinalEnvelope: true,
      includeGovernedPayloadInText: true,
      acceptedDataSchemas: ["ea.post-loan-risk-assessment-request.v1"],
      roleTemplates: ["post-loan-risk-control"],
    });
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
    expect(role.defaultSkills).toEqual(["post-loan-risk-control-assistant"]);
    expect(role.mcpServers).toEqual(["post_loan_risk_data", "platform_tools"]);
    expect(updated.skillRequirements?.["post-loan-risk-control-assistant"]?.servers?.post_loan_risk_data)
      .toContain("get_enterprise_profile");
    expect(updated.skillRequirements?.["post-loan-risk-control-assistant"]?.servers?.post_loan_risk_data)
      .toEqual(expect.arrayContaining(["list_risk_enterprises", "search_risk_enterprises", "get_post_loan_risk_snapshot"]));
    expect(updated.skillRequirements?.["post-loan-risk-control-assistant"]?.servers?.platform_tools)
      .toEqual(expect.arrayContaining(["list_available_agents", "submit_agent_task", "evaluate_post_loan_risk_escalation"]));
  });
});
