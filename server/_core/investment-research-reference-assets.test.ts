import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyInvestmentResearchRolePackBaseline } from "../../scripts/install-investment-research-reference-pack";
import { parseSkillSourceDirectory } from "./skills/skill-source";

const packRoot = path.join(process.cwd(), "examples", "investment-research-reference-role-pack");

describe("investment research Reference Role Pack assets", () => {
  it("ships a bounded main skill that reuses Wind and existing research skills", () => {
    const skillRoot = path.join(packRoot, "skills", "investment-research-assistant");
    const parsed = parseSkillSourceDirectory(skillRoot, "investment-research-assistant");
    const markdown = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
    expect(parsed.skillId).toBe("investment-research-assistant");
    expect(parsed.manifest?.version).toBe("1.0.0");
    expect(parsed.warnings).toEqual([]);
    expect(markdown).toContain("wind_stock_data");
    expect(markdown).toContain("wind_financial_docs");
    expect(markdown).toContain("evaluate_investment_research_data_assurance");
    expect(markdown).toContain("evaluate_investment_research_output_boundary");
    expect(markdown).toContain("demo_create_research_watch_task");
    expect(markdown).not.toMatch(/张先生|李女士|CUST[-_]/u);
  });

  it("updates the existing investment baseline additively and idempotently", () => {
    const baseline = { industries: { finance: { roles: { "investment-researcher": { defaultSkills: ["earnings-analysis"], optionalSkills: ["stock-screener"], mcpServers: ["wind_stock_data"] } } } }, skillRequirements: {} };
    const updated = applyInvestmentResearchRolePackBaseline(baseline);
    const role = updated.industries!.finance.roles!["investment-researcher"]!;
    expect(role.defaultSkills).toEqual(["investment-research-assistant", "earnings-analysis"]);
    expect(role.optionalSkills).toEqual(["stock-screener"]);
    expect(role.mcpServers).toEqual(["wind_stock_data", "wind_financial_docs", "wind_analytics_data", "platform_tools", "wealth_governance_demo"]);
    expect(updated.skillRequirements?.["investment-research-assistant"]?.servers).toMatchObject({
      wind_stock_data: ["get_stock_basicinfo", "get_stock_fundamentals", "get_stock_price_indicators", "get_risk_metrics"],
      wind_financial_docs: ["get_company_announcements", "get_financial_news"],
    });
    expect(updated.skillRequirements?.["investment-research-assistant"]?.servers).not.toHaveProperty("wind_analytics_data");
    const once = JSON.stringify(updated);
    expect(JSON.stringify(applyInvestmentResearchRolePackBaseline(updated))).toBe(once);
  });

  it("labels the pack as Reference Ready instead of production investment advice", () => {
    const readme = readFileSync(path.join(packRoot, "README.md"), "utf8");
    expect(readme).toContain("`Reference Ready`");
    expect(readme).toContain("只增加、不删除");
    expect(readme).toContain("不构成投资建议");
  });
});
