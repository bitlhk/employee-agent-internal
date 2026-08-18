import { describe, expect, it } from "vitest";
import { businessToolLabel, classifyToolName } from "./tool-presentation";

describe("classifyToolName", () => {
  it.each([
    ["web_search", "web"],
    ["browser_navigate", "browser"],
    ["bash", "terminal"],
    ["read_file", "file"],
    ["install_skill", "skill"],
    ["mcp_call_tool", "mcp"],
    ["mysql_query", "database"],
    ["image_generate", "image"],
    ["delegate_agent", "agent"],
    ["python", "code"],
    ["unknown_tool", "generic"],
  ] as const)("maps %s to %s", (name, expected) => {
    expect(classifyToolName(name)).toBe(expected);
  });

  it("keeps skill-specific file tools under the skill visual", () => {
    expect(classifyToolName("read_skill_file")).toBe("skill");
  });
});

describe("businessToolLabel", () => {
  it("translates governed role tools into business actions", () => {
    expect(businessToolLabel("enterprise_abcd_get_customer_profile_by_name")).toBe("获取客户画像");
    expect(businessToolLabel("evaluate_post_loan_risk_escalation")).toBe("评估贷后预警等级");
    expect(businessToolLabel("skill_tool")).toBe("加载岗位技能");
  });

  it("recognizes skill workspace operations without hiding ordinary file operations", () => {
    expect(businessToolLabel("read", '{"path":"skills/demo/SKILL.md"}')).toBe("读取技能资料");
    expect(businessToolLabel("read", '{"path":"notes/today.md"}')).toBe("");
  });
});
