import { describe, expect, it } from "vitest";
import {
  buildSkillValueEvidenceMarkdown,
  buildSkillValueEvidenceSummary,
  type SkillValueEvidenceJob,
} from "./skill-value-evidence";

const dimensions = [
  ["professional_fit", "专业匹配", 2, 4],
  ["business_completeness", "业务完整", 3, 4],
  ["clarity", "表达清晰", 3, 4],
  ["actionability", "可执行性", 2, 4],
].map(([id, label, leftScore, rightScore]) => ({
  id: String(id),
  label: String(label),
  leftScore: Number(leftScore),
  rightScore: Number(rightScore),
  reason: "B 的业务判断更完整",
}));

function completedJob(): SkillValueEvidenceJob {
  return {
    jobId: "skill-eval-test-001",
    skillId: "wealth-manager-assistant",
    skillName: "客户经理财富助手",
    roleTemplate: "wealth-manager",
    status: "completed",
    stageLabel: "评测已完成",
    createdAt: "2026-09-04T10:00:00.000Z",
    updatedAt: "2026-09-04T10:03:00.000Z",
    left: {
      modelId: "glm-5.2",
      skillVersion: "2.0.1",
      skillVersionId: "version-201",
      skillArtifactSha256: "a".repeat(64),
    },
    right: {
      modelId: "glm-5.2",
      skillVersion: "2.1.5",
      skillVersionId: "version-215",
      skillArtifactSha256: "b".repeat(64),
    },
    cases: [
      {
        promptId: "case-1",
        name: "到期续接访前准备",
        prompt: "请准备访前要点",
        evaluationGoal: "识别流动性冲突",
        left: {
          status: "completed",
          assistantText: "A 输出",
          elapsedMs: 20_000,
          error: null,
        },
        right: {
          status: "completed",
          assistantText: "B 输出",
          elapsedMs: 10_000,
          error: null,
        },
        judge: {
          winner: "right",
          confidence: "high",
          summary: "B 更能解释客户决策条件",
          dimensions,
          reviewerLabel: "匿名业务 Judge",
        },
        judgeError: null,
      },
      {
        promptId: "case-2",
        name: "正式配置方案",
        prompt: "请生成两套配置",
        evaluationGoal: "验证配置闭环",
        left: {
          status: "completed",
          assistantText: "A2 输出",
          elapsedMs: 40_000,
          error: null,
        },
        right: {
          status: "completed",
          assistantText: "B2 输出",
          elapsedMs: 20_000,
          error: null,
        },
        judge: {
          winner: "right",
          confidence: "high",
          summary: "B 的方案闭合且可执行",
          dimensions,
          reviewerLabel: "匿名业务 Judge",
        },
        judgeError: null,
      },
    ],
    promptfoo: { version: "0.122.2", completed: true },
    evaluationEngine: { id: "finance-skill-eval", version: "0.2.5" },
    judge: { modelId: "glm-5.2", completedCases: 2 },
    summary: {
      leftWins: 0,
      rightWins: 2,
      ties: 0,
      unavailable: 0,
      headline: "B 在 2/2 个任务中表现更优",
    },
    configurationFingerprint: "config-fingerprint",
    reportFingerprint: "report-fingerprint",
    error: null,
  };
}

describe("buildSkillValueEvidenceSummary", () => {
  it("summarizes version value, aggregate scores, success and latency", () => {
    const evidence = buildSkillValueEvidenceSummary(completedJob());

    expect(evidence).toMatchObject({
      comparisonType: "Skill 版本对比",
      winner: "right",
      winnerLabel: "B：v2.1.5 · glm-5.2",
      completedSides: 4,
      totalSides: 4,
      judgedCases: 2,
      highConfidenceCases: 2,
      averageElapsedSeconds: { left: 30, right: 15 },
      evidenceStatus: "complete",
      evidenceLabel: "证据完整",
    });
    expect(evidence.dimensions[0]).toEqual({
      id: "professional_fit",
      label: "专业匹配",
      leftScore: 2,
      rightScore: 4,
      delta: 2,
    });
  });

  it("marks interrupted and unavailable runs honestly", () => {
    const job = completedJob();
    job.status = "failed";
    job.summary = null;
    job.error = "Runtime timeout";
    job.cases[0].right = {
      status: "failed",
      assistantText: "",
      elapsedMs: 60_000,
      error: "timeout",
    };

    expect(buildSkillValueEvidenceSummary(job)).toMatchObject({
      winner: "unavailable",
      evidenceStatus: "interrupted",
      evidenceLabel: "本轮执行中断",
      headline: "Runtime timeout",
      completedSides: 3,
    });
  });
});

describe("buildSkillValueEvidenceMarkdown", () => {
  it("exports auditable configuration, Judge evidence and fingerprints", () => {
    const markdown = buildSkillValueEvidenceMarkdown(completedJob());

    expect(markdown).toContain("# 客户经理财富助手 Skill 价值评测证据");
    expect(markdown).toContain("版本 ID version-215");
    expect(markdown).toContain(`Artifact ${"b".repeat(64)}`);
    expect(markdown).toContain("B 更能解释客户决策条件");
    expect(markdown).toContain("| 专业匹配 | 2.0 | 4.0 | +2.0 |");
    expect(markdown).toContain("报告指纹：`report-fingerprint`");
    expect(markdown).toContain("不等同于对所有任务和生产场景的普遍保证");
  });
});
