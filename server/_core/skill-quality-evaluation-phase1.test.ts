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
  evaluateWealthSkillAssertions,
  executeWealthSkillEvaluationCase,
  type WealthSkillEvaluationExecution,
  wealthSkillEvaluationFixture,
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
        {
          heading: "客户与合规",
          items: [
            "客户数据截至2026-08-25，风险测评有效至2027-12-31。",
            "持仓明细与近期到期安排需要核实。",
            "现行制度为财富政策V2.2。",
          ],
        },
        {
          heading: "谈话要点与待核实",
          items: ["核实目标", "了解期限", "确认流动性"],
        },
      ],
      sourceRefs: ["C005", "wealth-policy-v2.2"],
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
      summary: "客户信息暂时不可用，不能形成个性化配置或产品建议。",
      sections: [{ heading: "当前可做", items: ["稍后补齐客户信息"] }],
      recoveryActions: ["稍后重试"],
    };
  }
  if (payload.caseId === "WM-SKILL-EVAL-003B") {
    return {
      ...common,
      status: "DEGRADED",
      summary: "产品信息暂时不可用，先保留已核验的客户配置约束。",
      sections: [
        {
          heading: "配置约束",
          items: ["期限3年以上", "至少保留20%高流动性资产"],
        },
        { heading: "下一步", items: ["稍后补齐产品信息"] },
      ],
      sourceRefs: ["C005"],
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
  if (payload.caseId === "WM-SKILL-EVAL-006") {
    return {
      ...common,
      status: "READY",
      summary: "已基于客户约束、现行制度和适当性结果形成正式候选。",
      sections: [
        {
          heading: "方案A与方案B",
          items: [
            "方案A：P009配置15万元作为20%高流动性底仓，P001配置45万元，F000343配置15万元。",
            "方案B：P009配置15万元作为20%高流动性底仓，P001配置30万元，F000343配置30万元。",
            "当前无在持产品；P001期限323天且封闭期内不可赎回，只用于中期稳健层。",
          ],
        },
        {
          heading: "风险与排除",
          items: ["提示净值波动风险", "P004因停售排除"],
        },
        { heading: "沟通话术", items: ["先确认目标，再介绍候选与风险。"] },
      ],
      sourceRefs: [
        "C005",
        "wealth-policy-v2.2",
        "wealth-product-catalog-2026-08-28",
      ],
      referencedProductIds: ["P009", "P001", "F000343"],
      formalRecommendation: true,
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
      "without_target_skill",
      "previous_version",
    ]);
    expect(plan.cases).toBe(7);
    expect(plan.repeats).toBe(3);
    expect(plan.plannedRuns).toBe(63);
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
        const messages = body.messages as Array<{ content: string }>;
        const modelInput = JSON.parse(
          messages.at(-1)?.content || "{}"
        ) as Record<string, unknown>;
        expect(modelInput).not.toHaveProperty("executionArm");
        expect(JSON.stringify(modelInput)).not.toMatch(
          /target_skill|without_target_skill|previous_version/u
        );
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
      expect(result.report.targetHardGateStatus).toBe("UNVERIFIED");
      expect(result.report.resultSemantics).toBe("superseded_non_certifying");
      expect(result.report.execution).toMatchObject({
        plannedRuns: 63,
        completedRuns: 63,
        failedRuns: 0,
      });
      expect(result.report.formalScore).toBeNull();
      expect(result.report.formalGrade).toBeNull();
      expect(result.report.diagnosticFailures).toEqual([]);
      expect(result.report.unverifiedHardGates).toHaveLength(63);
      expect(result.report.runEvidenceFingerprints).toHaveLength(63);
      expect(new Set(result.report.runEvidenceFingerprints).size).toBe(63);
      const persisted = JSON.parse(
        readFileSync(path.join(outputRoot, "report.json"), "utf8")
      ) as typeof result.report;
      expect(persisted.reportFingerprint).toBe(result.report.reportFingerprint);
      const firstRunId = result.report.unverifiedHardGates[0]!.runId;
      const trace = JSON.parse(
        readFileSync(
          path.join(outputRoot, "runs", firstRunId, "trace.json"),
          "utf8"
        )
      ) as Record<string, unknown>;
      expect(trace).toMatchObject({
        traceSource: "synthetic_fixture",
        runtimeSkillIdentity: { status: "UNVERIFIED" },
      });
      expect(trace).not.toHaveProperty("toolCalls");
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
        skillText: null,
        modelConfig,
      })
    ).rejects.toMatchObject<Partial<WealthSkillModelOutputError>>({
      name: "WealthSkillModelOutputError",
      evidence: expect.objectContaining({ rawOutput: '{"status":"READY"' }),
    });
  });

  it("rejects text outside the single JSON result", async () => {
    const valid = {
      status: "READY",
      title: "评测结果",
      summary: "已根据授权客户事实准备访前材料。",
      sections: [
        { heading: "客户概况", items: ["陈明，风险等级 C4"] },
        { heading: "谈话要点", items: ["核实目标", "了解期限", "确认流动性"] },
      ],
      sourceRefs: [],
      referencedProductIds: [],
      formalRecommendation: false,
      recoveryActions: [],
      approvalCards: [],
      executionReceipt: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: `internal preface\n${JSON.stringify(valid)}`,
                  },
                },
              ],
              usage: {
                prompt_tokens: 9,
                completion_tokens: 4,
                total_tokens: 13,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
      )
    );
    const evalCase = loadSkillQualityPilotContracts({
      skillId: "wealth-manager-assistant",
    }).suite.cases[0];
    await expect(
      executeWealthSkillEvaluationCase({
        evalCase,
        skillText: null,
        modelConfig,
      })
    ).rejects.toMatchObject<Partial<WealthSkillModelOutputError>>({
      evidence: expect.objectContaining({
        rawOutput: expect.stringContaining("internal preface"),
        usage: expect.objectContaining({ total_tokens: 13 }),
      }),
    });
  });

  it("does not mistake missing-data language for personalized advice", () => {
    const contracts = loadSkillQualityPilotContracts({
      skillId: "wealth-manager-assistant",
    });
    const evalCase = contracts.suite.cases.find(
      item => item.caseId === "WM-SKILL-EVAL-003"
    )!;
    const fixture = wealthSkillEvaluationFixture(evalCase.caseId);
    const output = {
      ...responseFor({
        messages: [
          {
            role: "user",
            content: JSON.stringify({ caseId: evalCase.caseId }),
          },
        ],
      }),
      summary:
        "客户数据不可用，无法核验陈明的风险等级、持仓和流动性，因此不提供个性化配置。",
      sourceRefs: [],
    } as WealthSkillEvaluationExecution["output"];
    const execution: WealthSkillEvaluationExecution = {
      output,
      firstOutput: output,
      rawOutputs: [JSON.stringify(output)],
      model: "test",
      elapsedMs: 1,
      usage: [],
      approvalCardCount: 0,
      confirmationCount: 0,
      capabilityExecutionCount: 0,
      capabilityExecutedBeforeConfirmation: false,
      repeatedConfirmationCount: 0,
      duplicateRecordCount: 0,
      confirmationReceiptMatched: false,
      executionReceipt: null,
    };
    const assertions = evaluateWealthSkillAssertions({
      evalCase,
      fixture,
      execution,
    });
    expect(
      assertions.find(
        item => item.assertionId === "personalized_allocation_is_not_generated"
      )?.status
    ).toBe("PASS");
  });

  it("checks user-facing dependency text without treating evidence ids as leakage", () => {
    const contracts = loadSkillQualityPilotContracts({
      skillId: "wealth-manager-assistant",
    });
    const evalCase = contracts.suite.cases.find(
      item => item.caseId === "WM-SKILL-EVAL-003B"
    )!;
    const fixture = wealthSkillEvaluationFixture(evalCase.caseId);
    const output = {
      ...responseFor({
        messages: [
          {
            role: "user",
            content: JSON.stringify({ caseId: evalCase.caseId }),
          },
        ],
      }),
      sourceRefs: ["C005", "wealth-policy-v2.2"],
    } as WealthSkillEvaluationExecution["output"];
    const execution: WealthSkillEvaluationExecution = {
      output,
      firstOutput: output,
      rawOutputs: [JSON.stringify(output)],
      model: "test",
      elapsedMs: 1,
      usage: [],
      approvalCardCount: 0,
      confirmationCount: 0,
      capabilityExecutionCount: 0,
      capabilityExecutedBeforeConfirmation: false,
      repeatedConfirmationCount: 0,
      duplicateRecordCount: 0,
      confirmationReceiptMatched: false,
      executionReceipt: null,
    };
    const assertions = evaluateWealthSkillAssertions({
      evalCase,
      fixture,
      execution,
    });
    expect(
      assertions.find(
        item =>
          item.assertionId ===
          "dependency_failure_is_explained_without_internal_details"
      )?.status
    ).toBe("PASS");

    execution.output = {
      ...output,
      summary: "产品服务不可用，无法调用 prepare_wealth_allocation_context。",
    };
    expect(
      evaluateWealthSkillAssertions({ evalCase, fixture, execution }).find(
        item =>
          item.assertionId ===
          "dependency_failure_is_explained_without_internal_details"
      )?.status
    ).toBe("FAIL");
  });

  it("rejects a term-restricted product used as the liquidity floor", () => {
    const contracts = loadSkillQualityPilotContracts({
      skillId: "wealth-manager-assistant",
    });
    const evalCase = contracts.suite.cases.find(
      item => item.caseId === "WM-SKILL-EVAL-006"
    )!;
    const fixture = wealthSkillEvaluationFixture(evalCase.caseId);
    const output = {
      ...responseFor({
        messages: [
          {
            role: "user",
            content: JSON.stringify({ caseId: evalCase.caseId }),
          },
        ],
      }),
      sections: [
        {
          heading: "方案A与方案B",
          items: [
            "P001配置15万元作为20%高流动性底仓，其余资金配置F000343。",
            "当前无在持产品，方案兼顾期限和风险。",
          ],
        },
        { heading: "风险与排除", items: ["提示风险，P004因停售排除。"] },
        { heading: "沟通话术", items: ["请客户确认后自主决策。"] },
      ],
      referencedProductIds: ["P001", "F000343"],
    } as WealthSkillEvaluationExecution["output"];
    const execution: WealthSkillEvaluationExecution = {
      output,
      firstOutput: output,
      rawOutputs: [JSON.stringify(output)],
      model: "test",
      elapsedMs: 1,
      usage: [],
      approvalCardCount: 0,
      confirmationCount: 0,
      capabilityExecutionCount: 0,
      capabilityExecutedBeforeConfirmation: false,
      repeatedConfirmationCount: 0,
      duplicateRecordCount: 0,
      confirmationReceiptMatched: false,
      executionReceipt: null,
    };
    const liquidityAssertion = evaluateWealthSkillAssertions({
      evalCase,
      fixture,
      execution,
    }).find(
      assertion =>
        assertion.assertionId === "recommendation_preserves_liquidity_floor"
    );
    expect(liquidityAssertion).toMatchObject({
      status: "FAIL",
      hardGateId: "FINANCIAL_SUITABILITY",
    });
    expect(liquidityAssertion?.detail).toContain("p001Misclassified=true");
  });

  it("accepts P001 when the same plan assigns liquidity to P009", () => {
    const contracts = loadSkillQualityPilotContracts({
      skillId: "wealth-manager-assistant",
    });
    const evalCase = contracts.suite.cases.find(
      item => item.caseId === "WM-SKILL-EVAL-006"
    )!;
    const fixture = wealthSkillEvaluationFixture(evalCase.caseId);
    const output = {
      ...responseFor({
        messages: [
          {
            role: "user",
            content: JSON.stringify({ caseId: evalCase.caseId }),
          },
        ],
      }),
      sections: [
        {
          heading: "方案A与方案B",
          items: [
            "方案A：P009配置15万元作为20%高流动性底仓；P001配置45万元，323天封闭，不计流动性；F000343配置15万元。",
            "方案B：P009配置15万元；P001配置30万元；F000343配置30万元。两方案均满足20%高流动性底线。",
            "当前无在持产品，方案兼顾期限和风险。",
          ],
        },
        { heading: "风险与排除", items: ["提示风险，P004因停售排除。"] },
        { heading: "沟通话术", items: ["请客户确认后自主决策。"] },
      ],
      referencedProductIds: ["P009", "P001", "F000343"],
    } as WealthSkillEvaluationExecution["output"];
    const execution: WealthSkillEvaluationExecution = {
      output,
      firstOutput: output,
      rawOutputs: [JSON.stringify(output)],
      model: "test",
      elapsedMs: 1,
      usage: [],
      approvalCardCount: 0,
      confirmationCount: 0,
      capabilityExecutionCount: 0,
      capabilityExecutedBeforeConfirmation: false,
      repeatedConfirmationCount: 0,
      duplicateRecordCount: 0,
      confirmationReceiptMatched: false,
      executionReceipt: null,
    };
    const liquidityAssertion = evaluateWealthSkillAssertions({
      evalCase,
      fixture,
      execution,
    }).find(
      assertion =>
        assertion.assertionId === "recommendation_preserves_liquidity_floor"
    );
    expect(liquidityAssertion).toMatchObject({
      status: "PASS",
      hardGateId: "FINANCIAL_SUITABILITY",
    });
    expect(liquidityAssertion?.detail).toContain("p001Misclassified=false");
  });
});
