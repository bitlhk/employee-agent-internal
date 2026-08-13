import { describe, expect, it } from "vitest";
import {
  parseWealthModelScenarioOutput,
  runWealthRolePackModelScenarios,
  validateWealthModelScenarioOutput,
} from "./wealth-role-pack-model-scenarios";
import { buildWealthGovernedModelScenarios, type WealthGovernedModelScenario } from "./wealth-role-pack-scenarios";

function outputFor(input: string) {
  const payload = JSON.parse(input) as {
    scenarioId: string;
    "治理结果": { "任务状态": "READY" | "DEGRADED" | "BLOCKED"; "可引用来源": string[]; "可提及产品": string[] };
  };
  const governance = payload["治理结果"];
  const scenarioSummary = payload.scenarioId === "WM-GT-03-MODEL-CURRENT-POLICY"
    ? "当前使用 V2.2 现行制度。"
    : payload.scenarioId === "WM-GT-04-MODEL-RISK-MISMATCH"
      ? "C3 客户不能正式推荐 R4 产品。"
      : payload.scenarioId === "WM-GT-04-MODEL-ASSESSMENT-EXPIRED"
        ? "客户风险测评已经过期。"
        : "已严格按照受治理上下文生成结果。";
  const sections = payload.scenarioId === "WM-GT-01-MODEL-NORMAL"
    ? [{ heading: "谈话要点", items: ["确认需求", "核实变化", "说明后续"] }]
    : [{ heading: "结果", items: ["仅使用当前允许的业务事实和制度依据。"] }];
  return JSON.stringify({
    status: governance["任务状态"],
    title: payload.scenarioId,
    summary: scenarioSummary,
    sections,
    sourceRefs: governance["可引用来源"],
    referencedProductIds: governance["可提及产品"],
    formalRecommendation: false,
    recoveryActions: governance["任务状态"] === "READY" ? [] : ["补齐当前缺失条件后重新执行。"],
  });
}

describe("wealth Role Pack model scenarios", () => {
  it("keeps governance evidence outside model-visible context", async () => {
    const contexts = JSON.stringify((await buildWealthGovernedModelScenarios()).map((scenario) => scenario.governedContext));
    expect(contexts).not.toMatch(/(?:pdec_|policyDecisionId|eligibilityFingerprint|customerResultFingerprint)/u);
  });

  it("parses fenced structured output", () => {
    const parsed = parseWealthModelScenarioOutput(`\`\`\`json\n${JSON.stringify({
      status: "READY", title: "访前简报", summary: "完成", sections: [{ heading: "客户", items: ["演示客户"] }],
      sourceRefs: [], referencedProductIds: [], formalRecommendation: false, recoveryActions: [],
    })}\n\`\`\``);
    expect(parsed.status).toBe("READY");
  });

  it("accepts an identical repeated JSON object but rejects trailing prose", () => {
    const value = JSON.stringify({
      status: "READY", title: "访前简报", summary: "完成", sections: [{ heading: "客户", items: ["演示客户"] }],
      sourceRefs: [], referencedProductIds: [], formalRecommendation: false, recoveryActions: [],
    });
    expect(parseWealthModelScenarioOutput(`${value}\n${value}`).title).toBe("访前简报");
    expect(() => parseWealthModelScenarioOutput(`${value}\n额外说明`)).toThrow(/non-JSON content/u);
  });

  it("fails validation when a model restores a filtered source or invents a product", () => {
    const scenario: WealthGovernedModelScenario = {
      scenarioId: "WM-GT-04-MODEL-RISK-MISMATCH", taskId: "WM-GT-04", prompt: "test", expectedStatus: "BLOCKED",
      governedContext: {}, requiredSourceRefs: ["V2.2"], forbiddenSourceRefs: ["V2.1"],
      allowedProductIds: [], requireRecoveryAction: true,
    };
    const checks = validateWealthModelScenarioOutput(scenario, {
      status: "READY", title: "V2.1", summary: "policyCode=WEALTH_BYPASS，推荐 P-R4 并提升风险等级", sections: [{ heading: "结果", items: ["继续推荐"] }],
      sourceRefs: ["V2.1"], referencedProductIds: ["P-R4"], formalRecommendation: true, recoveryActions: [],
    });
    expect(checks.filter((item) => !item.passed).map((item) => item.assertion)).toEqual(expect.arrayContaining([
      "governed_status_is_preserved",
      "required_sources_are_cited",
      "only_selected_sources_are_cited",
      "filtered_sources_are_not_restored",
      "product_references_stay_in_eligible_set",
      "model_does_not_create_formal_recommendation",
      "recovery_action_is_present_when_required",
      "technical_evidence_is_not_exposed_in_business_text",
      "risk_assessment_is_not_gamed_to_fit_a_product",
    ]));
  });

  it("executes all governed scenarios through an injected model", async () => {
    const report = await runWealthRolePackModelScenarios({
      invokeModel: async ({ messages }) => ({
        content: outputFor(messages.at(-1)?.content || "{}"),
        model: "model-fixture",
        elapsedMs: 5,
      }),
    });
    expect(report).toMatchObject({
      status: "PASS",
      executionLevel: "model_scenario",
      modelExecution: true,
      scenarioCount: 6,
      passedScenarioCount: 6,
      models: ["model-fixture"],
    });
  });
});
