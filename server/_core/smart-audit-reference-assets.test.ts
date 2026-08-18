import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applySmartAuditRolePackBaseline } from "../../scripts/install-smart-audit-reference-pack";
import { parseSkillSourceDirectory } from "./skills/skill-source";

const root = process.cwd();
const packRoot = path.join(root, "examples", "smart-audit-reference-role-pack");

describe("smart audit Reference Role Pack assets", () => {
  it("ships a safe bounded main skill without copying the user-installed suite", () => {
    const skillRoot = path.join(packRoot, "skills", "smart-audit-assistant");
    const parsed = parseSkillSourceDirectory(skillRoot, "smart-audit-assistant");
    const markdown = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");

    expect(parsed.skillId).toBe("smart-audit-assistant");
    expect(parsed.manifest?.version).toBe("1.0.0");
    expect(parsed.warnings).toEqual([]);
    expect(markdown).toContain("credential_image_extract_from_workspace");
    expect(markdown).toContain("evaluate_audit_required_materials");
    expect(markdown).toContain("evaluate_audit_rule_eligibility");
    expect(markdown).toContain("evaluate_audit_human_review");
    expect(markdown).toContain("demo_create_audit_review_task");
    expect(markdown).toContain("只有文本内容时，不得声称核验印章");
    expect(markdown).toContain("当前没有写能力或 Policy Gate 时，只返回草稿");
    expect(markdown).not.toMatch(/张先生|李女士|CUST[-_]/u);
  });

  it("updates the role baseline additively and idempotently", () => {
    const baseline = {
      industries: {
        banking: {
          roles: {
            "credential-compliance": {
              defaultSkills: ["credential-prompt-generator", "group-insurance-audit"],
              optionalSkills: ["kyc-doc-parse"],
              mcpServers: ["credential_skills", "credential_image_workspace", "group_insurance_audit"],
            },
          },
        },
      },
      skillRequirements: {
        "credential-prompt-generator": {
          servers: { credential_skills: ["credential-prompt-generator"] },
        },
      },
    };

    const updated = applySmartAuditRolePackBaseline(baseline);
    const role = updated.industries!.banking.roles!["credential-compliance"]!;
    expect(role.defaultSkills).toEqual([
      "smart-audit-assistant",
      "credential-prompt-generator",
      "group-insurance-audit",
    ]);
    expect(role.optionalSkills).toEqual(["kyc-doc-parse"]);
    expect(role.mcpServers).toEqual([
      "credential_skills",
      "credential_image_workspace",
      "group_insurance_audit",
      "platform_tools",
      "wealth_governance_demo",
    ]);
    expect(updated.skillRequirements?.["smart-audit-assistant"]?.servers).toEqual({
      credential_image_workspace: ["credential_image_extract_from_workspace"],
    });

    const once = JSON.stringify(updated);
    expect(JSON.stringify(applySmartAuditRolePackBaseline(updated))).toBe(once);
  });

  it("documents the validated reference boundary without claiming production readiness", () => {
    const readme = readFileSync(path.join(packRoot, "README.md"), "utf8");
    expect(readme).toContain("`Reference Ready`");
    expect(readme).toContain("只增加、不删除");
    expect(readme).toContain("不能描述为银行生产就绪");
  });
});
