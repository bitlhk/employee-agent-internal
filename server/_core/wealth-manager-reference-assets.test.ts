import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSkillSourceDirectory } from "./skills/skill-source";

const root = path.resolve(process.cwd(), "examples", "wealth-manager-reference-role-pack");
const sopPath = path.resolve(
  process.cwd(),
  "examples",
  "financial-enterprise-knowledge-demo",
  "12-财富客户访前准备作业指导书.md",
);

describe("wealth manager reference role pack", () => {
  it("ships a safe, parseable previsit skill", () => {
    const skillDir = path.join(root, "skills", "privbank-previsit");
    const parsed = parseSkillSourceDirectory(
      skillDir,
      "privbank-previsit",
    );
    expect(parsed.skillId).toBe("privbank-previsit");
    expect(parsed.displayName).toBe("财富客户访前准备");
    expect(parsed.manifest?.version).toBe("1.2.0");
    expect(parsed.warnings).toEqual([]);
    const skillMarkdown = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    expect(skillMarkdown).toContain("客户事实和产品事实不得通过网页搜索补齐");
    expect(skillMarkdown).toContain("prepare_wealth_allocation_context");
    expect(skillMarkdown).toContain("get_wealth_policy_basis");
    expect(skillMarkdown).toContain("正式候选产品只能来自该工具返回的 `eligibleProducts`");
    expect(skillMarkdown).toContain("默认不执行通知、外发、CRM 写入");
  });

  it("publishes the existing wealth manager skill with governed recommendation routing", () => {
    const skillDir = path.join(root, "skills", "wealth-manager-assistant");
    const parsed = parseSkillSourceDirectory(skillDir, "wealth-manager-assistant");
    expect(parsed.skillId).toBe("wealth-manager-assistant");
    expect(parsed.manifest?.version).toBe("1.3.0");
    expect(parsed.warnings).toEqual([]);
    const skillMarkdown = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    expect(skillMarkdown).toContain("正式候选产品、推荐理由或推荐话术");
    expect(skillMarkdown).toContain("只能推荐其 `eligibleProducts`");
    expect(skillMarkdown).toContain("仅做产品资料查询时才使用原始产品只读工具");
    expect(skillMarkdown).toContain("Policy Code、Decision ID 和规则版本属于执行证据");
    expect(skillMarkdown).toContain("prepare_wealth_maturity_context");
    expect(skillMarkdown).toContain("确认前不得声称任务已创建");
  });

  it("defines normal, deny and degraded benchmark paths without static business data", () => {
    const evalText = readFileSync(path.join(root, "eval", "wm-gt-01-cases.json"), "utf8");
    const suite = JSON.parse(evalText) as {
      taskId: string;
      roleTemplate: string;
      cases: Array<{ path: string; assertions: string[]; requiredCapabilities?: string[] }>;
    };
    expect(suite.taskId).toBe("WM-GT-01");
    expect(suite.roleTemplate).toBe("wealth-manager");
    expect(new Set(suite.cases.map((item) => item.path))).toEqual(new Set(["NORMAL", "DENY", "DEGRADED"]));
    expect(suite.cases.flatMap((item) => item.requiredCapabilities || [])).toContain(
      "wealth_assistant_customer_detail",
    );
    expect(suite.cases.flatMap((item) => item.assertions)).toContain("customer_facts_come_from_mcp");
    expect(evalText).not.toMatch(/张先生.*(?:json|fixture)/i);
  });

  it("defines governed WM-GT-02 allocation paths", () => {
    const evalText = readFileSync(path.join(root, "eval", "wm-gt-02-cases.json"), "utf8");
    const suite = JSON.parse(evalText) as {
      taskId: string;
      requiredCapabilities: string[];
      cases: Array<{ path: string; assertions: string[] }>;
    };
    expect(suite.taskId).toBe("WM-GT-02");
    expect(suite.requiredCapabilities).toEqual(["prepare_wealth_allocation_context"]);
    expect(new Set(suite.cases.map((item) => item.path))).toEqual(new Set(["NORMAL", "DENY", "DEGRADED"]));
    expect(suite.cases.flatMap((item) => item.assertions)).toEqual(expect.arrayContaining([
      "only_policy_eligible_products_enter_recommendation_candidate_set",
      "risk_mismatched_product_is_excluded",
      "formal_product_recommendation_fails_closed",
    ]));
    expect(evalText).not.toMatch(/张先生|李女士|CUST-\d|PRODUCT-\d/i);
  });

  it("defines governed knowledge and deterministic denial tasks", () => {
    const policySuite = JSON.parse(readFileSync(path.join(root, "eval", "wm-gt-03-cases.json"), "utf8")) as {
      taskId: string;
      requiredCapabilities: string[];
      cases: Array<{ path: string; assertions: string[] }>;
    };
    expect(policySuite.taskId).toBe("WM-GT-03");
    expect(policySuite.requiredCapabilities).toEqual(["get_wealth_policy_basis"]);
    expect(policySuite.cases.flatMap((item) => item.assertions)).toEqual(expect.arrayContaining([
      "historical_policy_does_not_enter_selected_context",
      "enterprise_policy_conclusion_fails_closed",
    ]));

    const denialSuite = JSON.parse(readFileSync(path.join(root, "eval", "wm-gt-04-cases.json"), "utf8")) as {
      taskId: string;
      cases: Array<{ path: string; assertions: string[] }>;
    };
    expect(denialSuite.taskId).toBe("WM-GT-04");
    expect(denialSuite.cases.flatMap((item) => item.assertions)).toEqual(expect.arrayContaining([
      "lower_risk_product_recovery_action_is_shown",
      "technical_policy_code_is_evidence_only",
      "risk_reassessment_is_required",
    ]));
  });

  it("defines confirmed business writes and bounded maturity operations", () => {
    const writeText = readFileSync(path.join(root, "eval", "wm-gt-05-cases.json"), "utf8");
    const writeSuite = JSON.parse(writeText) as {
      taskId: string;
      requiredCapabilities: string[];
      cases: Array<{ path: string; assertions: string[] }>;
    };
    expect(writeSuite.taskId).toBe("WM-GT-05");
    expect(writeSuite.requiredCapabilities).toEqual(expect.arrayContaining([
      "demo_create_portfolio_draft",
      "demo_create_followup_task",
    ]));
    expect(writeSuite.cases.flatMap((item) => item.assertions)).toEqual(expect.arrayContaining([
      "remote_executor_is_not_called_before_confirmation",
      "missing_idempotency_key_is_blocked_at_pep",
      "demo_tool_rejects_real_looking_customer_reference",
    ]));

    const maturityText = readFileSync(path.join(root, "eval", "wm-gt-06-cases.json"), "utf8");
    const maturitySuite = JSON.parse(maturityText) as {
      taskId: string;
      requiredCapabilities: string[];
      cases: Array<{ path: string; assertions: string[] }>;
    };
    expect(maturitySuite.taskId).toBe("WM-GT-06");
    expect(maturitySuite.requiredCapabilities).toEqual(["prepare_wealth_maturity_context"]);
    expect(maturitySuite.cases.flatMap((item) => item.assertions)).toEqual(expect.arrayContaining([
      "all_customers_come_from_current_user_authorized_list",
      "data_as_of_is_present",
      "detail_customer_id_must_match_authorized_list",
      "followup_write_requires_separate_confirmation",
    ]));
    expect(`${writeText}\n${maturityText}`).not.toMatch(/(?:customer|客户画像|产品池).+\.json/i);
  });

  it("ships an employee-style SOP with lifecycle and exception handling", () => {
    const sop = readFileSync(sopPath, "utf8");
    for (const section of ["适用范围", "前置条件", "操作步骤", "必查项清单", "异常处理与升级", "会后留痕", "版本记录"]) {
      expect(sop).toContain(section);
    }
    expect(sop).toContain("演示");
    expect(sop).toContain("生效日期");
  });

  it("publishes a governed knowledge manifest for all benchmark tasks", () => {
    const manifest = JSON.parse(readFileSync(path.join(root, "knowledge", "manifest.json"), "utf8")) as {
      schemaVersion: string;
      roleTemplate: string;
      assets: Array<{
        assetId: string;
        file: string;
        lifecycle: string;
        versionLabel: string;
        effectiveAt: string | null;
        expiresAt: string | null;
        supersedes?: string | null;
        supersededBy?: string | null;
        taskIds: string[];
      }>;
    };
    expect(manifest.schemaVersion).toBe("ea.reference-role-pack.knowledge.v1");
    expect(manifest.roleTemplate).toBe("wealth-manager");
    expect(manifest.assets).toHaveLength(8);
    expect(new Set(manifest.assets.flatMap((asset) => asset.taskIds))).toEqual(
      new Set(["WM-GT-01", "WM-GT-02", "WM-GT-03", "WM-GT-04", "WM-GT-05", "WM-GT-06"]),
    );

    const current = manifest.assets.find((asset) => asset.assetId === "wm-suitability-policy-v2.2");
    const historical = manifest.assets.find((asset) => asset.assetId === "wm-suitability-policy-v2.1");
    expect(current).toMatchObject({ lifecycle: "active", versionLabel: "V2.2", supersedes: historical?.assetId });
    expect(historical).toMatchObject({ lifecycle: "expired", versionLabel: "V2.1", supersededBy: current?.assetId });
    expect(historical?.expiresAt).toBeTruthy();

    const knowledgeDir = path.resolve(process.cwd(), "examples", "financial-enterprise-knowledge-demo");
    for (const asset of manifest.assets) {
      const content = readFileSync(path.join(knowledgeDir, asset.file), "utf8");
      for (const section of ["适用范围", "前置条件", "必查项清单", "禁止项", "异常处理与升级", "留痕", "版本记录"]) {
        expect(content, `${asset.file} 缺少 ${section}`).toContain(section);
      }
    }
  });

  it("keeps customer and product facts out of the static role pack", () => {
    const files = readdirSync(root, { recursive: true }).map(String);
    expect(files.some((file) => /(?:customer|客户画像|产品池).+\.json$/i.test(file))).toBe(false);
  });
});
