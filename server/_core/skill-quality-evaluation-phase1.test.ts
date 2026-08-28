import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EaAssistantModelConfig } from "./ea-assistant-model";
import { loadSkillQualityPilotContracts } from "./skill-quality-evaluation-contracts";
import {
  buildWealthSkillQualityPhase1Plan,
  runWealthSkillQualityPhase1,
} from "./skill-quality-evaluation-phase1";
import {
  executeWealthSkillEvaluationCase,
  WealthSkillModelOutputError,
} from "./skill-quality-wealth-pilot";

const modelConfig: EaAssistantModelConfig = {
  baseUrl: "https://model.example.test/v1/chat/completions",
  model: "phase1-test-model",
  apiKey: "test-key",
  provider: "test-provider",
  timeoutMs: 1_000,
  disableThinking: true,
  tokenParam: "max_tokens",
};

function responseFor(body: Record<string, unknown>) {
  const messages = body.messages as Array<{ role: string; content: string }>;
  const payload = JSON.parse(messages.at(-1)?.content || "{}") as {
    caseId?: string;
    governedContext?: { executionReceipt?: unknown };
  };
  const common = {
    title: "评测结果",
    sourceRefs: [] as string[],
    referencedProductIds: [] as string[],
    formalRecommendation: false,
    recoveryActions: [] as string[],
    approvalCards: [] as Array<{ title: string; payloadSummary: string }>,
    executionReceipt: null as null | {
      recordId: string;
      status: "created";
      dataBoundary: "isolated_evaluation_workspace";
    },
  };
  if (payload.caseId === "WM-SKILL-EVAL-001") {
    return {
      ...common,
      status: "READY",
      summary: "已根据授权客户事实准备访前材料。",
      sections: [
        { heading: "客户概况", items: ["陈明，风险等级 C4"] },
        { heading: "谈话要点", items: ["核实目标", "了解期限", "确认流动性"] },
      ],
    };
  }
  if (payload.caseId === "WM-SKILL-EVAL-002") {
    return {
      ...common,
      status: "BLOCKED",
      summary: "风险测评已过期，不能形成正式推荐。",
      sections: [{ heading: "合规处理", items: ["请先重新完成风险测评"] }],
      recoveryActions: ["重新完成风险测评"],
    };
  }
  if (payload.caseId === "WM-SKILL-EVAL-003") {
    return {
      ...common,
      status: "DEGRADED",
      summary: "客户和产品信息暂时不可用，只能提供配置框架。",
      sections: [{ heading: "当前可做", items: ["稍后补齐信息"] }],
      recoveryActions: ["稍后重试"],
    };
  }
  if (payload.caseId === "WM-SKILL-EVAL-004") {
    return {
      ...common,
      status: "BLOCKED",
      summary: "该客户不在当前授权范围内。",
      sections: [{ heading: "处理建议", items: ["请申请正式授权"] }],
    };
  }
  if (payload.governedContext?.executionReceipt) {
    return {
      ...common,
      status: "READY",
      summary: "跟进任务已创建。",
      sections: [{ heading: "执行结果", items: ["已写入隔离评测空间"] }],
      executionReceipt: payload.governedContext.executionReceipt,
    };
  }
  return {
    ...common,
    status: "DEGRADED",
    summary: "请确认创建一条客户跟进任务。",
    sections: [{ heading: "待确认", items: ["合并三个跟进事项"] }],
    approvalCards: [
      { title: "创建客户跟进任务", payloadSummary: "陈明 C005，一条合并任务" },
    ],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Skill Quality Evaluation Phase 1", () => {
  it("builds the frozen three-arm pilot plan", () => {
    const plan = buildWealthSkillQualityPhase1Plan();
    expect(plan.status).toBe("READY");
    expect(plan.arms).toEqual([
      "target_skill",
      "without_skill",
      "previous_version",
    ]);
    expect(plan.cases).toBe(5);
    expect(plan.repeats).toBe(3);
    expect(plan.plannedRuns).toBe(45);
    expect(plan.formalScoreAvailable).toBe(false);
  });

  it("runs Promptfoo in isolated diagnostic mode and writes immutable evidence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || "{}")) as Record<
          string,
          unknown
        >;
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify(responseFor(body)) } },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 50,
              total_tokens: 150,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );
    const outputRoot = mkdtempSync(
      path.join(tmpdir(), "skill-quality-p1-test-")
    );
    try {
      const result = await runWealthSkillQualityPhase1({
        outputRoot,
        modelConfig,
      });
      expect(result.report.status).toBe("DIAGNOSTIC_COMPLETE");
      expect(result.report.targetHardGateStatus).toBe("PASS");
      expect(result.report.execution).toMatchObject({
        plannedRuns: 45,
        completedRuns: 45,
        failedRuns: 0,
      });
      expect(result.report.formalScore).toBeNull();
      expect(result.report.formalGrade).toBeNull();
      expect(result.report.diagnosticFailures).toEqual([]);
      expect(result.report.runEvidenceFingerprints).toHaveLength(45);
      expect(new Set(result.report.runEvidenceFingerprints).size).toBe(45);
      const persisted = JSON.parse(
        readFileSync(path.join(outputRoot, "report.json"), "utf8")
      ) as typeof result.report;
      expect(persisted.reportFingerprint).toBe(result.report.reportFingerprint);
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("preserves malformed model output as diagnostic evidence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"status":"READY"' } }],
              usage: { total_tokens: 10 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
      )
    );
    const contracts = loadSkillQualityPilotContracts({
      skillId: "wealth-manager-assistant",
    });
    const evalCase = contracts.suite.cases[0];
    await expect(
      executeWealthSkillEvaluationCase({
        evalCase,
        executionArm: "without_skill",
        skillText: null,
        modelConfig,
      })
    ).rejects.toMatchObject<Partial<WealthSkillModelOutputError>>({
      name: "WealthSkillModelOutputError",
      evidence: expect.objectContaining({ rawOutput: '{"status":"READY"' }),
    });
  });
});
