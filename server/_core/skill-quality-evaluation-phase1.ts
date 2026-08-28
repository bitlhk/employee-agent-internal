import { randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  evaluate,
  type ApiProvider,
  type CallApiContextParams,
  type ProviderResponse,
} from "promptfoo";
import type {
  SkillEvaluationBaselineMode,
  SkillEvaluationExecutionArm,
  SkillEvaluationRunEvidenceV1,
  SkillEvaluationRunSnapshotV1,
  SkillEvalCaseV1,
} from "../../shared/skill-quality-evaluation";
import {
  skillEvaluationRunEvidenceV1Schema,
  skillEvaluationRunSnapshotV1Schema,
} from "../../shared/skill-quality-evaluation";
import type { EaAssistantModelConfig } from "./ea-assistant-model";
import { getEaAssistantModelConfig } from "./ea-assistant-model";
import { governanceFingerprint } from "./governance/contracts";
import {
  loadSkillQualityPilotContracts,
  type PilotManifest,
} from "./skill-quality-evaluation-contracts";
import {
  evaluationConfigFingerprint,
  runEvidenceFingerprint,
} from "./skill-quality-evaluation";
import {
  evaluateWealthSkillAssertions,
  executeWealthSkillEvaluationCase,
  skillEvaluationBaseSystemPrompt,
  wealthSkillEvaluationFixture,
  WealthSkillModelOutputError,
  type SkillEvaluationAssertionResult,
  type WealthSkillEvaluationExecution,
  type WealthSkillEvaluationOutput,
} from "./skill-quality-wealth-pilot";
import { digestSkillSourceTree } from "./skills/skill-artifact-digest";

const RUNNER_VERSION = "ea-skill-quality-phase1-v1";
const PROVIDER_VERSION = "ea-promptfoo-provider-v1";
const PROMPTFOO_VERSION = "0.122.2";
const EXECUTION_CONCURRENCY = 2;

type Pilot = PilotManifest["pilots"][number];
type VersionIdentity = {
  skillId: string;
  skillVersionId: string;
  version: string;
  artifactSha256: string;
  artifactRelativePath: string;
};
type ArmDefinition = {
  executionArm: SkillEvaluationExecutionArm;
  baselineMode: SkillEvaluationBaselineMode | null;
  version: VersionIdentity | null;
};
type HarnessArtifactIdentityCheck = {
  status: "PASS" | "FAIL";
  expected: VersionIdentity | null;
  actual: VersionIdentity[];
  targetArtifactPresentInBaseline: boolean;
  detail: string;
};
type RunRecord = {
  runId: string;
  caseId: string;
  repeatIndex: number;
  executionArm: SkillEvaluationExecutionArm;
  status: "PASS" | "FAIL";
  snapshot: SkillEvaluationRunSnapshotV1;
  evidence: SkillEvaluationRunEvidenceV1;
  trace: Record<string, unknown>;
  assertions: SkillEvaluationAssertionResult[];
  output: WealthSkillEvaluationOutput | null;
  elapsedMs: number;
  tokenUsage: { prompt: number; completion: number; total: number };
  error: string | null;
};

export type SkillQualityPhase1Report = {
  schema: "ea.skill-quality-phase-1-diagnostic-report.v1";
  evaluationId: string;
  generatedAt: string;
  status: "DIAGNOSTIC_COMPLETE" | "DIAGNOSTIC_INCOMPLETE";
  targetHardGateStatus: "PASS" | "FAIL" | "UNVERIFIED";
  resultSemantics: "superseded_non_certifying";
  executionMode: "controlled_harness";
  skillId: string;
  targetVersion: string;
  suiteId: string;
  suiteFingerprint: string;
  expertReviewStatus: string;
  judgeStatus: "unavailable" | "calibrated";
  formalScore: null;
  formalGrade: null;
  promptfoo: {
    version: string;
    evaluationId: string | null;
    cacheEnabled: false;
    sharingEnabled: false;
    remoteRedteamGenerationEnabled: false;
  };
  execution: {
    caseCount: number;
    armCount: number;
    repeatCount: number;
    plannedRuns: number;
    completedRuns: number;
    failedRuns: number;
  };
  arms: Array<{
    executionArm: SkillEvaluationExecutionArm;
    runCount: number;
    passCount: number;
    deterministicAssertionPassRate: number;
    hardGateAssertionPassRate: number;
    hardGateRunPassRate: number | null;
    hardGateRunStatusCounts: {
      pass: number;
      fail: number;
      unavailable: number;
    };
    p95LatencyMs: number;
    tokenUsage: { prompt: number; completion: number; total: number };
  }>;
  diagnosticComparisons: Array<{
    baseline: SkillEvaluationExecutionArm;
    targetPassRateDelta: number;
  }>;
  diagnosticFailures: Array<{
    runId: string;
    caseId: string;
    executionArm: SkillEvaluationExecutionArm;
    hardGateId: string | null;
    assertionId: string;
    detail: string;
  }>;
  hardGateFailures: Array<{
    runId: string;
    caseId: string;
    executionArm: SkillEvaluationExecutionArm;
    hardGateId: string;
    assertionId: string;
    detail: string;
  }>;
  unverifiedHardGates: Array<{
    runId: string;
    caseId: string;
    executionArm: SkillEvaluationExecutionArm;
    hardGateId: string;
    assertionId: string;
    detail: string;
  }>;
  runEvidenceFingerprints: string[];
  warnings: string[];
  reportFingerprint: string;
};

function percentile95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
  ];
}

function usageOf(values: unknown[]): {
  prompt: number;
  completion: number;
  total: number;
} {
  return values.reduce<{
    prompt: number;
    completion: number;
    total: number;
  }>(
    (total, raw) => {
      const item = raw as Record<string, unknown> | null;
      const prompt = Number(item?.prompt_tokens || item?.promptTokens || 0);
      const completion = Number(
        item?.completion_tokens || item?.completionTokens || 0
      );
      const combined = Number(item?.total_tokens || item?.totalTokens || 0);
      total.prompt += Number.isFinite(prompt) ? prompt : 0;
      total.completion += Number.isFinite(completion) ? completion : 0;
      total.total += Number.isFinite(combined)
        ? combined
        : (Number.isFinite(prompt) ? prompt : 0) +
          (Number.isFinite(completion) ? completion : 0);
      return total;
    },
    { prompt: 0, completion: 0, total: 0 }
  );
}

function artifactForVersion(input: {
  pilot: Pilot;
  inventory: ReturnType<typeof loadSkillQualityPilotContracts>["inventory"];
  skillVersionId: string;
}): VersionIdentity {
  const record = input.inventory.records.find(
    item => item.skillVersionId === input.skillVersionId
  );
  if (!record)
    throw new Error(`Approved artifact is missing: ${input.skillVersionId}`);
  return {
    skillId: input.pilot.skillId,
    skillVersionId: record.skillVersionId,
    version: record.version,
    artifactSha256: record.artifactSha256,
    artifactRelativePath: record.artifactRelativePath,
  };
}

function buildArmDefinitions(input: {
  pilot: Pilot;
  inventory: ReturnType<typeof loadSkillQualityPilotContracts>["inventory"];
}): ArmDefinition[] {
  const target = artifactForVersion({
    ...input,
    skillVersionId: input.pilot.target.skillVersionId,
  });
  const arms: ArmDefinition[] = [
    { executionArm: "target_skill", baselineMode: null, version: target },
  ];
  for (const baseline of input.pilot.baselines) {
    arms.push({
      executionArm: baseline.mode,
      baselineMode: baseline.mode,
      version: baseline.skillVersionId
        ? artifactForVersion({
            ...input,
            skillVersionId: baseline.skillVersionId,
          })
        : null,
    });
  }
  return arms;
}

function materializeWorkspace(input: {
  evaluationId: string;
  runId: string;
  arm: ArmDefinition;
  target: VersionIdentity;
  skillStoreRoot: string;
}): {
  workspacePath: string;
  skillText: string | null;
  identityCheck: HarnessArtifactIdentityCheck;
} {
  const workspacePath = path.join(
    tmpdir(),
    "ea-skill-quality",
    input.evaluationId,
    input.runId
  );
  const skillsPath = path.join(workspacePath, "skills");
  mkdirSync(skillsPath, { recursive: true });
  const actual: VersionIdentity[] = [];
  let skillText: string | null = null;
  if (input.arm.version) {
    const sourcePath = path.join(
      input.skillStoreRoot,
      input.arm.version.artifactRelativePath
    );
    const destinationPath = path.join(skillsPath, input.arm.version.skillId);
    cpSync(sourcePath, destinationPath, { recursive: true });
    const digest = digestSkillSourceTree(destinationPath);
    const materialized = {
      ...input.arm.version,
      artifactSha256: digest.sha256,
    };
    actual.push(materialized);
    skillText = readFileSync(path.join(destinationPath, "SKILL.md"), "utf8");
  }
  const skillDirectories = readdirSync(skillsPath, {
    withFileTypes: true,
  }).filter(item => item.isDirectory());
  const targetArtifactPresentInBaseline =
    input.arm.executionArm !== "target_skill" &&
    actual.some(item => item.artifactSha256 === input.target.artifactSha256);
  const expected = input.arm.version;
  const identityMatches = expected
    ? actual.length === 1 &&
      actual[0]?.skillVersionId === expected.skillVersionId &&
      actual[0]?.artifactSha256 === expected.artifactSha256 &&
      skillDirectories.length === 1
    : actual.length === 0 && skillDirectories.length === 0;
  const passed = identityMatches && !targetArtifactPresentInBaseline;
  return {
    workspacePath,
    skillText,
    identityCheck: {
      status: passed ? "PASS" : "FAIL",
      expected,
      actual,
      targetArtifactPresentInBaseline,
      detail: passed
        ? "isolated workspace contains exactly the expected Skill identity"
        : "workspace Skill identity or baseline contamination check failed",
    },
  };
}

function modelEndpointFingerprint(config: EaAssistantModelConfig): string {
  const endpoint = new URL(config.baseUrl);
  return governanceFingerprint({
    protocol: endpoint.protocol,
    host: endpoint.host,
    pathname: endpoint.pathname,
  });
}

function snapshotFor(input: {
  runId: string;
  createdAt: string;
  evalCase: SkillEvalCaseV1;
  repeatIndex: number;
  arm: ArmDefinition;
  target: VersionIdentity;
  workspacePath: string;
  suite: ReturnType<typeof loadSkillQualityPilotContracts>["suite"];
  pilot: Pilot;
  scorecardFingerprint: string;
  judgeFingerprint: string | null;
  modelConfig: EaAssistantModelConfig;
  contextFingerprint: string;
}): SkillEvaluationRunSnapshotV1 {
  const baselineSkill =
    input.arm.version && input.arm.executionArm !== "target_skill"
      ? {
          skillVersionId: input.arm.version.skillVersionId,
          artifactSha256: input.arm.version.artifactSha256,
        }
      : null;
  const value: SkillEvaluationRunSnapshotV1 = {
    schemaVersion: "ea.skill-evaluation-run-snapshot.v1",
    runId: input.runId,
    createdAt: input.createdAt,
    suiteId: input.suite.suiteId,
    suiteVersion: input.suite.suiteVersion,
    suiteFingerprint: input.suite.suiteFingerprint,
    caseId: input.evalCase.caseId,
    repeatIndex: input.repeatIndex,
    executionArm: input.arm.executionArm,
    targetSkill: {
      skillVersionId: input.target.skillVersionId,
      artifactSha256: input.target.artifactSha256,
    },
    baselineMode: input.arm.baselineMode,
    baselineSkill,
    expectedRuntimeSkills: input.arm.version
      ? [
          {
            skillId: input.arm.version.skillId,
            skillVersionId: input.arm.version.skillVersionId,
            version: input.arm.version.version,
            artifactSha256: input.arm.version.artifactSha256,
          },
        ]
      : [],
    rolePackReleaseId: input.pilot.rolePackReleaseId || "not-pinned",
    rolePackReleaseFingerprint: governanceFingerprint({
      rolePackReleaseId: input.pilot.rolePackReleaseId || "not-pinned",
    }),
    systemPromptFingerprint: governanceFingerprint(
      skillEvaluationBaseSystemPrompt()
    ),
    model: {
      provider: input.modelConfig.provider,
      modelId: input.modelConfig.model,
      modelVersion: input.modelConfig.model,
      config: {
        temperature: 0,
        maxTokens: 1_200,
        disableThinking: input.modelConfig.disableThinking,
        tokenParam: input.modelConfig.tokenParam,
        endpointFingerprint: modelEndpointFingerprint(input.modelConfig),
      },
    },
    contextSnapshotId: `controlled-${input.evalCase.caseId}`,
    contextFingerprint: input.contextFingerprint,
    dataSnapshotId: `controlled-data-${input.evalCase.fixtureRefs.join("-")}`,
    dataFingerprint: input.contextFingerprint,
    principal: {
      principalId: "skill-eval-wealth-principal",
      purpose: "skill_quality_evaluation",
      permissionSnapshotId: "skill-eval-wealth-permissions-v1",
      permissionFingerprint: governanceFingerprint({
        principal: "skill-eval-wealth-principal",
        role: "wealth-manager",
        purpose: "skill_quality_evaluation",
      }),
    },
    toolPolicyFingerprint: governanceFingerprint({
      noExternalSideEffects: true,
      controlledFixtureProvidersOnly: true,
      confirmationRequired: true,
    }),
    toolVersions: {
      controlled_customer_context: "v1",
      controlled_wealth_policy: "v1",
      isolated_followup_capability: "v1",
    },
    runtime: {
      evalAdoptionId: `eval-adoption-${input.runId}`,
      sessionId: `eval-session-${input.runId}`,
      workspaceId: input.workspacePath,
      executionMode: "controlled_harness",
      runtimeIdentityStatus: "UNVERIFIED",
      cleanSession: true,
      cleanWorkspace: true,
      noSideEffectMode: true,
    },
    executionPolicy: {
      timeoutMs: 60_000,
      maxRetries: 0,
      retryBackoffMs: 0,
      concurrency: EXECUTION_CONCURRENCY,
      maxToolCalls: 20,
      tokenBudget: {
        maxPromptTokens: 16_000,
        maxCompletionTokens: 2_400,
        maxTotalTokens: 18_400,
      },
      networkEgress: {
        mode: "deny_by_default",
        allowedEndpointFingerprints: [
          modelEndpointFingerprint(input.modelConfig),
        ],
      },
    },
    scorecardProfileFingerprint: input.scorecardFingerprint,
    judgeStatus: input.judgeFingerprint ? "READY" : "NOT_CONFIGURED",
    judgeProfileFingerprint: input.judgeFingerprint,
    runnerVersion: RUNNER_VERSION,
    providerVersion: PROVIDER_VERSION,
    evaluationConfigFingerprint: "0".repeat(64),
  };
  value.evaluationConfigFingerprint = evaluationConfigFingerprint(value);
  return skillEvaluationRunSnapshotV1Schema.parse(value);
}

function identityAssertions(
  identity: HarnessArtifactIdentityCheck
): SkillEvaluationAssertionResult[] {
  return [
    {
      assertionId: "harness_artifact_identity",
      mode: "deterministic",
      status: identity.status,
      hardGateId: null,
      metricId: null,
      detail: `Harness Artifact Identity: ${identity.detail}`,
    },
    {
      assertionId: "trace_skill_runtime_identity",
      mode: "deterministic",
      status: "UNAVAILABLE",
      hardGateId: "SKILL_RUNTIME_IDENTITY",
      metricId: null,
      detail:
        "SKILL_RUNTIME_IDENTITY is unverified because this controlled harness does not install or execute the Skill through EA Runtime",
    },
  ];
}

function traceFor(input: {
  runId: string;
  startedAt: string;
  completedAt: string;
  evalCase: SkillEvalCaseV1;
  arm: ArmDefinition;
  identity: HarnessArtifactIdentityCheck;
  execution: WealthSkillEvaluationExecution | null;
  fixture: ReturnType<typeof wealthSkillEvaluationFixture>;
  assertions: SkillEvaluationAssertionResult[];
  failedModelOutput: WealthSkillModelOutputError["evidence"] | null;
  error: string | null;
}): Record<string, unknown> {
  const syntheticFixtureEvents = [
    ...input.fixture.initialToolCalls.map((call, index) => ({
      callIndex: index + 1,
      source: "synthetic_fixture",
      ...call,
    })),
    ...(input.execution?.capabilityExecutionCount
      ? [
          {
            callIndex: input.fixture.initialToolCalls.length + 1,
            source: "synthetic_fixture",
            toolName: "create_followup",
            status: "success",
            confirmationCount: input.execution.confirmationCount,
          },
        ]
      : []),
  ];
  return {
    schema: "ea.skill-quality-controlled-trace.v1",
    traceSource: "synthetic_fixture",
    traceId: `trace-${input.runId}`,
    runId: input.runId,
    caseId: input.evalCase.caseId,
    executionArm: input.arm.executionArm,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    harnessArtifactIdentity: input.identity,
    runtimeSkillIdentity: {
      status: "UNVERIFIED",
      detail:
        "no EA Adoption installation, native Skill loading event or runtime identity evidence was observed",
    },
    governedContext: {
      fixtureId: input.fixture.fixtureId,
      fingerprint: governanceFingerprint({
        context: input.fixture.governedContext,
        traceFacts: input.fixture.traceFacts,
      }),
      providedBy: "synthetic_fixture",
    },
    policy: input.fixture.traceFacts,
    syntheticFixtureEvents,
    modelExecution: input.execution
      ? {
          model: input.execution.model,
          elapsedMs: input.execution.elapsedMs,
          outputCount: input.execution.rawOutputs.length,
          rawOutputs: input.execution.rawOutputs,
          rawOutputSha256s: input.execution.rawOutputs.map(value =>
            governanceFingerprint(value)
          ),
          usage: input.execution.usage,
          initialOutput: input.execution.firstOutput,
          finalOutput: input.execution.output,
        }
      : null,
    confirmation: input.execution
      ? {
          approvalCardCount: input.execution.approvalCardCount,
          confirmationCount: input.execution.confirmationCount,
          capabilityExecutionCount: input.execution.capabilityExecutionCount,
          executedBeforeConfirmation:
            input.execution.capabilityExecutedBeforeConfirmation,
          executionReceipt: input.execution.executionReceipt,
        }
      : null,
    assertions: input.assertions,
    failedModelOutput: input.failedModelOutput
      ? {
          ...input.failedModelOutput,
          rawOutputSha256: governanceFingerprint(
            input.failedModelOutput.rawOutput
          ),
        }
      : null,
    error: input.error,
  };
}

class WealthSkillQualityProvider implements ApiProvider {
  constructor(
    private readonly input: {
      root: string;
      reportRoot: string;
      evaluationId: string;
      arm: ArmDefinition;
      target: VersionIdentity;
      contracts: ReturnType<typeof loadSkillQualityPilotContracts>;
      modelConfig: EaAssistantModelConfig;
      collector: RunRecord[];
    }
  ) {}

  id(): string {
    return `ea:skill-quality:${this.input.arm.executionArm}`;
  }

  async callApi(
    _prompt: string,
    context?: CallApiContextParams
  ): Promise<ProviderResponse> {
    const caseId = String(context?.vars?.caseId || "");
    const evalCase = this.input.contracts.suite.cases.find(
      item => item.caseId === caseId
    );
    if (!evalCase) return { error: `Unknown Eval case ${caseId}` };
    const repeatIndex = Number(context?.repeatIndex || 0) + 1;
    const runId = `${this.input.arm.executionArm}-${caseId}-${repeatIndex}-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();
    const fixture = wealthSkillEvaluationFixture(caseId);
    const contextFingerprint = governanceFingerprint({
      context: fixture.governedContext,
      traceFacts: fixture.traceFacts,
    });
    const workspace = materializeWorkspace({
      evaluationId: this.input.evaluationId,
      runId,
      arm: this.input.arm,
      target: this.input.target,
      skillStoreRoot: this.input.contracts.skillStoreRoot,
    });
    const judgeFingerprint =
      this.input.contracts.judge.status === "calibrated"
        ? this.input.contracts.judge.judgeProfileFingerprint
        : null;
    const snapshot = snapshotFor({
      runId,
      createdAt: startedAt,
      evalCase,
      repeatIndex,
      arm: this.input.arm,
      target: this.input.target,
      workspacePath: workspace.workspacePath,
      suite: this.input.contracts.suite,
      pilot: this.input.contracts.pilot,
      scorecardFingerprint: this.input.contracts.scorecard.profileFingerprint,
      judgeFingerprint,
      modelConfig: this.input.modelConfig,
      contextFingerprint,
    });
    let execution: WealthSkillEvaluationExecution | null = null;
    let output: WealthSkillEvaluationOutput | null = null;
    let failedModelOutput: WealthSkillModelOutputError["evidence"] | null =
      null;
    let error: string | null = null;
    const assertions: SkillEvaluationAssertionResult[] = identityAssertions(
      workspace.identityCheck
    );
    try {
      const result = await executeWealthSkillEvaluationCase({
        evalCase,
        skillText: workspace.skillText,
        modelConfig: this.input.modelConfig,
      });
      execution = result.execution;
      output = result.execution.output;
      assertions.push(
        ...evaluateWealthSkillAssertions({
          evalCase,
          fixture: result.fixture,
          execution: result.execution,
        })
      );
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      if (caught instanceof WealthSkillModelOutputError) {
        failedModelOutput = caught.evidence;
      }
      assertions.push(
        ...evalCase.assertions.map(assertion => ({
          assertionId: assertion.assertionId,
          mode: assertion.mode,
          status:
            assertion.mode === "judge"
              ? ("UNAVAILABLE" as const)
              : ("FAIL" as const),
          hardGateId: assertion.hardGateId,
          metricId: assertion.metricId,
          detail: `execution failed: ${error}`,
        }))
      );
    }
    const completedAt = new Date().toISOString();
    const trace = traceFor({
      runId,
      startedAt,
      completedAt,
      evalCase,
      arm: this.input.arm,
      identity: workspace.identityCheck,
      execution,
      fixture,
      assertions,
      failedModelOutput,
      error,
    });
    const traceSha256 = governanceFingerprint(trace);
    const outputSha256 = governanceFingerprint(
      output || failedModelOutput?.rawOutput || { error }
    );
    const rawOutputSha256 = governanceFingerprint(
      execution?.rawOutputs ||
        (failedModelOutput ? [failedModelOutput.rawOutput] : [])
    );
    const runtimeEventFingerprint = governanceFingerprint(
      trace.syntheticFixtureEvents
    );
    const evidence: SkillEvaluationRunEvidenceV1 = {
      schemaVersion: "ea.skill-evaluation-run-evidence.v1",
      runId,
      evaluationConfigFingerprint: snapshot.evaluationConfigFingerprint,
      traceId: `trace-${runId}`,
      traceSchemaVersion: "ea.skill-quality-controlled-trace.v1",
      traceSha256,
      outputSha256,
      rawOutputSha256,
      artifactSha256s: workspace.identityCheck.actual.map(
        item => item.artifactSha256
      ),
      actualSkillVersions: workspace.identityCheck.actual.map(item => ({
        skillVersionId: item.skillVersionId,
        artifactSha256: item.artifactSha256,
      })),
      traceSource: "synthetic_fixture",
      runtimeIdentityStatus: "UNVERIFIED",
      runtimeEventFingerprint,
      judgeStatus: "NOT_CONFIGURED",
      judgeResultFingerprint: null,
      completedAt,
      runEvidenceFingerprint: "0".repeat(64),
    };
    evidence.runEvidenceFingerprint = runEvidenceFingerprint(evidence);
    skillEvaluationRunEvidenceV1Schema.parse(evidence);
    const deterministic = assertions.filter(
      item => item.mode === "deterministic"
    );
    const status =
      !error && deterministic.every(item => item.status !== "FAIL")
        ? ("PASS" as const)
        : ("FAIL" as const);
    const runRecord: RunRecord = {
      runId,
      caseId,
      repeatIndex,
      executionArm: this.input.arm.executionArm,
      status,
      snapshot,
      evidence,
      trace,
      assertions,
      output,
      elapsedMs:
        execution?.elapsedMs ||
        failedModelOutput?.elapsedMs ||
        Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      tokenUsage: usageOf(
        execution?.usage ||
          (failedModelOutput ? [failedModelOutput.usage] : [])
      ),
      error,
    };
    this.input.collector.push(runRecord);
    const runRoot = path.join(this.input.reportRoot, "runs", runId);
    mkdirSync(runRoot, { recursive: true });
    writeFileSync(
      path.join(runRoot, "snapshot.json"),
      `${JSON.stringify(snapshot, null, 2)}\n`
    );
    writeFileSync(
      path.join(runRoot, "trace.json"),
      `${JSON.stringify(trace, null, 2)}\n`
    );
    writeFileSync(
      path.join(runRoot, "evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`
    );
    rmSync(workspace.workspacePath, { recursive: true, force: true });
    if (error) return { error, latencyMs: Date.now() - Date.parse(startedAt) };
    return {
      output: JSON.stringify(output),
      latencyMs: execution?.elapsedMs,
      tokenUsage: runRecord.tokenUsage,
      metadata: {
        runId,
        runEvidenceFingerprint: evidence.runEvidenceFingerprint,
        diagnosticStatus: status,
      },
    };
  }
}

function armSummary(
  executionArm: SkillEvaluationExecutionArm,
  runs: RunRecord[]
): SkillQualityPhase1Report["arms"][number] {
  const selected = runs.filter(run => run.executionArm === executionArm);
  const assertions = selected.flatMap(run =>
    run.assertions.filter(assertion => assertion.mode === "deterministic")
  );
  const hardGates = assertions.filter(assertion => assertion.hardGateId);
  const hardGateRuns = new Map<
    string,
    SkillEvaluationAssertionResult[]
  >();
  for (const run of selected) {
    for (const assertion of run.assertions) {
      if (!assertion.hardGateId) continue;
      const key = `${run.runId}\u0000${assertion.hardGateId}`;
      const current = hardGateRuns.get(key) || [];
      current.push(assertion);
      hardGateRuns.set(key, current);
    }
  }
  const hardGateRunStatuses = Array.from(hardGateRuns.values()).map(items =>
    items.some(item => item.status === "FAIL")
      ? "FAIL"
      : items.some(item => item.status === "UNAVAILABLE")
        ? "UNAVAILABLE"
        : "PASS"
  );
  const hardGateRunStatusCounts = {
    pass: hardGateRunStatuses.filter(status => status === "PASS").length,
    fail: hardGateRunStatuses.filter(status => status === "FAIL").length,
    unavailable: hardGateRunStatuses.filter(status => status === "UNAVAILABLE")
      .length,
  };
  const verifiedHardGateRuns =
    hardGateRunStatusCounts.pass + hardGateRunStatusCounts.fail;
  return {
    executionArm,
    runCount: selected.length,
    passCount: selected.filter(run => run.status === "PASS").length,
    deterministicAssertionPassRate: assertions.length
      ? assertions.filter(assertion => assertion.status === "PASS").length /
        assertions.length
      : 0,
    hardGateAssertionPassRate: hardGates.length
      ? hardGates.filter(assertion => assertion.status === "PASS").length /
        hardGates.length
      : 0,
    hardGateRunPassRate: verifiedHardGateRuns
      ? hardGateRunStatusCounts.pass / verifiedHardGateRuns
      : null,
    hardGateRunStatusCounts,
    p95LatencyMs: percentile95(selected.map(run => run.elapsedMs)),
    tokenUsage: selected.reduce(
      (total, run) => ({
        prompt: total.prompt + run.tokenUsage.prompt,
        completion: total.completion + run.tokenUsage.completion,
        total: total.total + run.tokenUsage.total,
      }),
      { prompt: 0, completion: 0, total: 0 }
    ),
  };
}

function markdownReport(report: SkillQualityPhase1Report): string {
  const armLines = report.arms.map(
    arm =>
      `| ${arm.executionArm} | ${arm.passCount}/${arm.runCount} | ${(arm.deterministicAssertionPassRate * 100).toFixed(1)}% | ${(arm.hardGateAssertionPassRate * 100).toFixed(1)}% | ${arm.hardGateRunPassRate === null ? "N/A" : `${(arm.hardGateRunPassRate * 100).toFixed(1)}%`} | ${arm.p95LatencyMs} |`
  );
  return [
    "# Skill Quality Phase 1 Diagnostic",
    "",
    `- Evaluation: \`${report.evaluationId}\``,
    `- Skill: \`${report.skillId}@${report.targetVersion}\``,
    `- Status: **${report.status}**`,
    `- Target hard gates: **${report.targetHardGateStatus}**`,
    "- Harness Artifact Identity: **VERIFIED where the per-run assertion passes**",
    "- Skill Runtime Identity: **UNVERIFIED**",
    `- Expert Review: \`${report.expertReviewStatus}\``,
    `- Judge: \`${report.judgeStatus}\``,
    "- Formal score / grade: **Unavailable**",
    "",
    "| Execution arm | Passed runs | Deterministic assertions | Hard-gate assertions | Verified gate runs | P95 ms |",
    "|---|---:|---:|---:|---:|---:|",
    ...armLines,
    "",
    `Deterministic assertion failures: ${report.diagnosticFailures.length}`,
    `Hard-gate failures: ${report.hardGateFailures.length}`,
    `Unverified hard-gate instances: ${report.unverifiedHardGates.length}`,
    "",
    "This controlled-harness report is superseded/non-certifying. It does not prove EA Runtime installation, Skill loading, native tool execution or confirmation behavior.",
    "",
  ].join("\n");
}

export function buildWealthSkillQualityPhase1Plan(
  input: {
    root?: string;
    skillStoreRoot?: string;
  } = {}
): {
  schema: "ea.skill-quality-phase-1-plan.v1";
  status: "READY";
  skillId: string;
  targetVersion: string;
  cases: number;
  arms: SkillEvaluationExecutionArm[];
  repeats: number;
  plannedRuns: number;
  expertReviewStatus: string;
  judgeStatus: string;
  formalScoreAvailable: false;
} {
  const contracts = loadSkillQualityPilotContracts({
    root: input.root,
    skillId: "wealth-manager-assistant",
    skillStoreRoot: input.skillStoreRoot,
  });
  const arms = buildArmDefinitions({
    pilot: contracts.pilot,
    inventory: contracts.inventory,
  });
  const repeats = Math.max(
    contracts.scorecard.repeatPolicy.minimumRuns,
    ...contracts.suite.cases.map(item => item.minimumRuns)
  );
  return {
    schema: "ea.skill-quality-phase-1-plan.v1",
    status: "READY",
    skillId: contracts.pilot.skillId,
    targetVersion: contracts.pilot.target.version,
    cases: contracts.suite.cases.length,
    arms: arms.map(arm => arm.executionArm),
    repeats,
    plannedRuns: contracts.suite.cases.length * arms.length * repeats,
    expertReviewStatus: contracts.suite.expertReview.status,
    judgeStatus: contracts.judge.status,
    formalScoreAvailable: false,
  };
}

export async function runWealthSkillQualityPhase1(
  input: {
    root?: string;
    skillStoreRoot?: string;
    outputRoot?: string;
    modelConfig?: EaAssistantModelConfig;
    onProgress?: (completed: number, total: number) => void;
  } = {}
): Promise<{ report: SkillQualityPhase1Report; outputRoot: string }> {
  const root = input.root || process.cwd();
  const contracts = loadSkillQualityPilotContracts({
    root,
    skillId: "wealth-manager-assistant",
    skillStoreRoot: input.skillStoreRoot,
  });
  const modelConfig = input.modelConfig || getEaAssistantModelConfig();
  if (!modelConfig.apiKey)
    throw new Error("EA assistant model API key is unavailable");
  const arms = buildArmDefinitions({
    pilot: contracts.pilot,
    inventory: contracts.inventory,
  });
  const target = arms.find(arm => arm.executionArm === "target_skill")?.version;
  if (!target) throw new Error("Target Skill artifact is unavailable");
  const repeats = Math.max(
    contracts.scorecard.repeatPolicy.minimumRuns,
    ...contracts.suite.cases.map(item => item.minimumRuns)
  );
  const evaluationId = `wealth-skill-v1-${new Date().toISOString().replace(/[-:.]/gu, "")}`;
  const outputRoot =
    input.outputRoot ||
    path.join(root, "reports", "skill-quality-evaluation", evaluationId);
  mkdirSync(outputRoot, { recursive: true });
  const collector: RunRecord[] = [];
  const providers = arms.map(
    arm =>
      new WealthSkillQualityProvider({
        root,
        reportRoot: outputRoot,
        evaluationId,
        arm,
        target,
        contracts,
        modelConfig,
        collector,
      })
  );
  process.env.PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION = "true";
  process.env.PROMPTFOO_DISABLE_TELEMETRY = "true";
  const total = contracts.suite.cases.length * arms.length * repeats;
  const promptfooEvaluation = await evaluate(
    {
      description: `GRACE Wealth Skill Phase 1 ${evaluationId}`,
      prompts: ["{{prompt}}"],
      providers,
      tests: contracts.suite.cases.map(evalCase => ({
        description: `${evalCase.caseId} ${evalCase.name}`,
        vars: { caseId: evalCase.caseId, prompt: evalCase.prompt },
      })),
      writeLatestResults: false,
    },
    {
      cache: false,
      generateSuggestions: false,
      maxConcurrency: EXECUTION_CONCURRENCY,
      repeat: repeats,
      showProgressBar: false,
      silent: true,
      timeoutMs: 120_000,
      progressCallback: completed => input.onProgress?.(completed, total),
    }
  );
  const armReports = arms.map(arm => armSummary(arm.executionArm, collector));
  const targetReport = armReports.find(
    arm => arm.executionArm === "target_skill"
  );
  const diagnosticFailures = collector.flatMap(run =>
    run.assertions
      .filter(
        assertion =>
          assertion.mode === "deterministic" && assertion.status === "FAIL"
      )
      .map(assertion => ({
        runId: run.runId,
        caseId: run.caseId,
        executionArm: run.executionArm,
        hardGateId: assertion.hardGateId,
        assertionId: assertion.assertionId,
        detail: assertion.detail,
      }))
  );
  const hardGateFailures = diagnosticFailures.filter(
    failure => failure.hardGateId !== null
  ) as SkillQualityPhase1Report["hardGateFailures"];
  const unverifiedHardGates = collector.flatMap(run =>
    run.assertions
      .filter(
        assertion =>
          assertion.mode === "deterministic" &&
          assertion.hardGateId !== null &&
          assertion.status === "UNAVAILABLE"
      )
      .map(assertion => ({
        runId: run.runId,
        caseId: run.caseId,
        executionArm: run.executionArm,
        hardGateId: assertion.hardGateId!,
        assertionId: assertion.assertionId,
        detail: assertion.detail,
      }))
  );
  const targetHardGateFailures = hardGateFailures.filter(
    failure => failure.executionArm === "target_skill"
  );
  const targetUnverifiedHardGates = unverifiedHardGates.filter(
    failure => failure.executionArm === "target_skill"
  );
  const reportBody = {
    schema: "ea.skill-quality-phase-1-diagnostic-report.v1" as const,
    evaluationId,
    generatedAt: new Date().toISOString(),
    status:
      collector.length === total &&
      collector.every(
        run =>
          run.snapshot.runId === run.runId &&
          run.evidence.runId === run.runId &&
          Boolean(run.evidence.runEvidenceFingerprint)
      )
        ? ("DIAGNOSTIC_COMPLETE" as const)
        : ("DIAGNOSTIC_INCOMPLETE" as const),
    targetHardGateStatus:
      targetHardGateFailures.length > 0
        ? ("FAIL" as const)
        : targetUnverifiedHardGates.length > 0
          ? ("UNVERIFIED" as const)
          : ("PASS" as const),
    resultSemantics: "superseded_non_certifying" as const,
    executionMode: "controlled_harness" as const,
    skillId: contracts.pilot.skillId,
    targetVersion: contracts.pilot.target.version,
    suiteId: contracts.suite.suiteId,
    suiteFingerprint: contracts.suite.suiteFingerprint,
    expertReviewStatus: contracts.suite.expertReview.status,
    judgeStatus:
      contracts.judge.status === "calibrated"
        ? ("calibrated" as const)
        : ("unavailable" as const),
    formalScore: null,
    formalGrade: null,
    promptfoo: {
      version: PROMPTFOO_VERSION,
      evaluationId: promptfooEvaluation.id || null,
      cacheEnabled: false as const,
      sharingEnabled: false as const,
      remoteRedteamGenerationEnabled: false as const,
    },
    execution: {
      caseCount: contracts.suite.cases.length,
      armCount: arms.length,
      repeatCount: repeats,
      plannedRuns: total,
      completedRuns: collector.length,
      failedRuns: collector.filter(run => run.status === "FAIL").length,
    },
    arms: armReports,
    diagnosticComparisons: armReports
      .filter(arm => arm.executionArm !== "target_skill")
      .map(arm => ({
        baseline: arm.executionArm,
        targetPassRateDelta:
          (targetReport?.runCount
            ? targetReport.passCount / targetReport.runCount
            : 0) - (arm.runCount ? arm.passCount / arm.runCount : 0),
      })),
    diagnosticFailures,
    hardGateFailures,
    unverifiedHardGates,
    runEvidenceFingerprints: collector.map(
      run => run.evidence.runEvidenceFingerprint
    ),
    warnings: [
      ...(contracts.suite.expertReview.status === "expert_confirmed"
        ? []
        : ["Eval Suite is not expert-confirmed"]),
      ...(contracts.judge.status === "calibrated"
        ? []
        : ["Judge Profile is unavailable; subjective metrics are unavailable"]),
      "Synthetic fixture events are used; this run does not certify native EA tool execution or live MCP availability",
      "Harness Artifact Identity does not establish SKILL_RUNTIME_IDENTITY",
    ],
  };
  const report: SkillQualityPhase1Report = {
    ...reportBody,
    reportFingerprint: governanceFingerprint(reportBody),
  };
  writeFileSync(
    path.join(outputRoot, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`
  );
  writeFileSync(path.join(outputRoot, "report.md"), markdownReport(report));
  return { report, outputRoot };
}
