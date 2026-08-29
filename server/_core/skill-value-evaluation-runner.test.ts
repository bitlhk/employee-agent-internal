import { describe, expect, it } from "vitest";
import {
  buildSkillValueEvaluationEnvironment,
  summarizeSkillValueEvaluationCases,
  type SkillValueEvaluationCaseResult,
  type SkillValueEvaluationJudgeResult,
} from "./skill-value-evaluation-runner";

const dimensions: SkillValueEvaluationJudgeResult["dimensions"] = [
  ["professional_fit", "专业匹配"],
  ["business_completeness", "业务完整"],
  ["clarity", "表达清晰"],
  ["actionability", "可执行性"],
].map(([id, label]) => ({
  id: id as SkillValueEvaluationJudgeResult["dimensions"][number]["id"],
  label,
  leftScore: 3,
  rightScore: 4,
  reason: "测试理由",
}));

function evaluationCase(
  winner: SkillValueEvaluationJudgeResult["winner"] | null,
): SkillValueEvaluationCaseResult {
  return {
    promptId: `prompt-${winner || "unavailable"}`,
    name: "测试题",
    prompt: "请完成测试任务",
    evaluationGoal: "比较专业质量",
    left: null,
    right: null,
    judge: winner ? {
      winner,
      confidence: "high",
      summary: "测试结论",
      dimensions,
      reviewerLabel: "测试 Judge",
    } : null,
    judgeError: winner ? null : "Judge unavailable",
  };
}

describe("summarizeSkillValueEvaluationCases", () => {
  it("summarizes a right-side advantage", () => {
    const summary = summarizeSkillValueEvaluationCases([
      evaluationCase("right"),
      evaluationCase("right"),
      evaluationCase("tie"),
    ]);

    expect(summary).toEqual({
      leftWins: 0,
      rightWins: 2,
      ties: 1,
      headline: "B 在 2/3 个任务中表现更优",
    });
  });

  it("keeps ties and unavailable judge results distinct", () => {
    expect(summarizeSkillValueEvaluationCases([
      evaluationCase("left"),
      evaluationCase("right"),
      evaluationCase("tie"),
    ]).headline).toBe("本轮对比持平：A、B 各胜 1 题，1 题持平");

    expect(summarizeSkillValueEvaluationCases([
      evaluationCase(null),
    ])).toEqual({
      leftWins: 0,
      rightWins: 0,
      ties: 0,
      headline: "左右输出已完成，专业 Judge 暂未形成可用结论",
    });
  });
});

describe("skill value evaluation environment", () => {
  it("normalizes the declared MCP tool environment shared by both sides", () => {
    expect(buildSkillValueEvaluationEnvironment("stock-screener", {
      servers: {
        wind_stock_data: ["search_stocks", "get_stock_basicinfo", "search_stocks"],
        wind_analytics_data: ["get_financial_data"],
      },
    })).toEqual({
      mode: "skill_declared",
      isolation: "target_skill_only",
      sameForBothSides: true,
      mcpServers: [
        {
          serverId: "wind_analytics_data",
          requiredTools: ["get_financial_data"],
        },
        {
          serverId: "wind_stock_data",
          requiredTools: ["get_stock_basicinfo", "search_stocks"],
        },
      ],
      declaredToolCount: 3,
    });
  });

  it("keeps a Skill without MCP requirements in a native-only environment", () => {
    expect(buildSkillValueEvaluationEnvironment("report-writer", { servers: {} }))
      .toMatchObject({ mcpServers: [], declaredToolCount: 0, sameForBothSides: true });
  });
});
