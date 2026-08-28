import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  skillEvalAssertionV1Schema,
  skillEvalSuiteV1Schema,
  skillEvaluationRunEvidenceV1Schema,
  skillEvaluationRunSnapshotV1Schema,
  skillScorecardProfileV1Schema,
  type SkillEvaluationRunEvidenceV1,
  type SkillEvaluationRunSnapshotV1,
  type SkillScorecardProfileV1,
} from "../../shared/skill-quality-evaluation";
import { governanceFingerprint } from "./governance/contracts";
import {
  pilotManifestSchema,
  runSkillQualityPhase0ContractChecks,
} from "./skill-quality-evaluation-contracts";
import {
  evaluationConfigFingerprint,
  runEvidenceFingerprint,
  skillEvalSuiteFingerprint,
} from "./skill-quality-evaluation";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function createPhase0FixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "skill-quality-phase0-"));
  mkdirSync(path.join(root, "examples"), { recursive: true });
  cpSync(
    path.join(process.cwd(), "examples/skill-quality-evaluation-v1"),
    path.join(root, "examples/skill-quality-evaluation-v1"),
    { recursive: true }
  );
  for (const relativePath of [
    "examples/wealth-manager-reference-role-pack/eval/wm-gt-01-cases.json",
    "examples/wealth-manager-reference-role-pack/eval/wm-gt-02-cases.json",
    "examples/wealth-manager-reference-role-pack/eval/wm-gt-05-cases.json",
    "docs/wealth-manager-skill-v2-release-record.md",
  ]) {
    const source = path.join(process.cwd(), relativePath);
    const destination = path.join(root, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination);
  }
  return root;
}

function updateManifestFingerprint(manifest: Record<string, unknown>): void {
  const body = { ...manifest };
  delete body.manifestFingerprint;
  manifest.manifestFingerprint = governanceFingerprint(body);
}

function snapshot(
  overrides: {
    runId?: string;
    createdAt?: string;
    evalAdoptionId?: string;
    sessionId?: string;
    workspaceId?: string;
    repeatIndex?: number;
    executionArm?: SkillEvaluationRunSnapshotV1["executionArm"];
    modelConfig?: Record<string, unknown>;
    timeoutMs?: number;
    maxTotalTokens?: number;
    allowedEndpointFingerprints?: string[];
    judgeStatus?: SkillEvaluationRunSnapshotV1["judgeStatus"];
    judgeProfileFingerprint?: string | null;
  } = {}
): SkillEvaluationRunSnapshotV1 {
  const executionArm = overrides.executionArm || "previous_version";
  const targetArm = executionArm === "target_skill";
  const withoutSkillArm = executionArm === "without_skill";
  const value: SkillEvaluationRunSnapshotV1 = {
    schemaVersion: "ea.skill-evaluation-run-snapshot.v1",
    runId: overrides.runId || "eval-run-1",
    createdAt: overrides.createdAt || "2026-08-28T10:00:00+08:00",
    suiteId: "wealth-manager-assistant-quality-v1",
    suiteVersion: "1.0.0",
    suiteFingerprint: SHA_A,
    caseId: "WM-SKILL-EVAL-001",
    repeatIndex: overrides.repeatIndex || 1,
    executionArm,
    targetSkill: {
      skillVersionId: "skill-version-current",
      artifactSha256: SHA_B,
    },
    baselineMode: targetArm ? null : executionArm,
    baselineSkill:
      targetArm || withoutSkillArm
        ? null
        : {
            skillVersionId: "skill-version-previous",
            artifactSha256: SHA_C,
          },
    expectedRuntimeSkills: withoutSkillArm
      ? []
      : [
          targetArm
            ? {
                skillId: "wealth-manager-assistant",
                version: "2.0.0",
                skillVersionId: "skill-version-current",
                artifactSha256: SHA_B,
              }
            : {
                skillId: "wealth-manager-assistant",
                version: "1.0.0",
                skillVersionId: "skill-version-previous",
                artifactSha256: SHA_C,
              },
        ],
    rolePackReleaseId: "wealth-role-pack-release",
    rolePackReleaseFingerprint: SHA_A,
    systemPromptFingerprint: SHA_B,
    model: {
      provider: "test-provider",
      modelId: "test-model",
      modelVersion: "1",
      config: overrides.modelConfig || { temperature: 0 },
    },
    contextSnapshotId: "context-snapshot",
    contextFingerprint: SHA_C,
    dataSnapshotId: "data-snapshot",
    dataFingerprint: SHA_A,
    principal: {
      principalId: "eval-principal",
      purpose: "skill_quality_evaluation",
      permissionSnapshotId: "permission-snapshot",
      permissionFingerprint: SHA_B,
    },
    toolPolicyFingerprint: SHA_C,
    toolVersions: { customer_context: "1" },
    runtime: {
      evalAdoptionId: overrides.evalAdoptionId || "eval-adoption-1",
      sessionId: overrides.sessionId || "session-1",
      workspaceId: overrides.workspaceId || "workspace-1",
      executionMode: "controlled_harness",
      runtimeIdentityStatus: "UNVERIFIED",
      cleanSession: true,
      cleanWorkspace: true,
      noSideEffectMode: true,
    },
    executionPolicy: {
      timeoutMs: overrides.timeoutMs || 60_000,
      maxRetries: 1,
      retryBackoffMs: 1_000,
      concurrency: 1,
      maxToolCalls: 20,
      tokenBudget: {
        maxPromptTokens: 8_000,
        maxCompletionTokens: 4_000,
        maxTotalTokens: overrides.maxTotalTokens || 12_000,
      },
      networkEgress: {
        mode: "deny_by_default",
        allowedEndpointFingerprints: overrides.allowedEndpointFingerprints || [
          SHA_A,
        ],
      },
    },
    scorecardProfileFingerprint: SHA_A,
    judgeStatus: overrides.judgeStatus || "NOT_CONFIGURED",
    judgeProfileFingerprint:
      overrides.judgeProfileFingerprint === undefined
        ? null
        : overrides.judgeProfileFingerprint,
    runnerVersion: "phase0-test",
    providerVersion: "phase0-test",
    evaluationConfigFingerprint: "0".repeat(64),
  };
  value.evaluationConfigFingerprint = evaluationConfigFingerprint(value);
  return value;
}

describe("Skill Quality Evaluation Phase 0", () => {
  it("validates the frozen contracts and pilot baselines", () => {
    const report = runSkillQualityPhase0ContractChecks();
    expect(report.status, report.errors.join("\n")).toBe("PASS");
    expect(report.pilotCount).toBe(2);
    expect(report.inventoryRecordCount).toBe(3);
    expect(report.approvedSkillInventoryFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.judgeAvailability).toBe("unavailable");
    expect(report.pilots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skillId: "wealth-manager-assistant",
          targetVersion: "2.0.1",
          caseCount: 5,
          baselineModes: ["without_skill", "previous_version"],
        }),
        expect.objectContaining({
          skillId: "goldencoach-stage-evaluation",
          targetVersion: "1.0.1",
          caseCount: 1,
          baselineModes: ["without_skill"],
        }),
      ])
    );
  });

  it("keeps the evaluation configuration stable across run identities", () => {
    const first = snapshot();
    const repeated = snapshot({
      runId: "eval-run-2",
      createdAt: "2026-08-28T11:00:00+08:00",
      evalAdoptionId: "eval-adoption-2",
      sessionId: "session-2",
      workspaceId: "workspace-2",
      repeatIndex: 2,
    });
    expect(repeated.evaluationConfigFingerprint).toBe(
      first.evaluationConfigFingerprint
    );
    expect(
      snapshot({ modelConfig: { temperature: 0.2 } })
        .evaluationConfigFingerprint
    ).not.toBe(first.evaluationConfigFingerprint);
    expect(
      snapshot({ executionArm: "target_skill" }).evaluationConfigFingerprint
    ).not.toBe(first.evaluationConfigFingerprint);
    expect(
      snapshot({ timeoutMs: 30_000 }).evaluationConfigFingerprint
    ).not.toBe(first.evaluationConfigFingerprint);
    expect(
      snapshot({ maxTotalTokens: 16_000 }).evaluationConfigFingerprint
    ).not.toBe(first.evaluationConfigFingerprint);
    expect(
      snapshot({ allowedEndpointFingerprints: [SHA_B] })
        .evaluationConfigFingerprint
    ).not.toBe(first.evaluationConfigFingerprint);
  });

  it("separates deterministic-only runs from configured Judge runs", () => {
    expect(
      skillEvaluationRunSnapshotV1Schema.safeParse(snapshot()).success
    ).toBe(true);
    expect(
      skillEvaluationRunSnapshotV1Schema.safeParse(
        snapshot({ judgeProfileFingerprint: SHA_A })
      ).success
    ).toBe(false);
    expect(
      skillEvaluationRunSnapshotV1Schema.safeParse(
        snapshot({
          judgeStatus: "READY",
          judgeProfileFingerprint: SHA_A,
        })
      ).success
    ).toBe(true);
  });

  it("creates distinct evidence fingerprints for distinct executions", () => {
    const base: SkillEvaluationRunEvidenceV1 = {
      schemaVersion: "ea.skill-evaluation-run-evidence.v1",
      runId: "eval-run-1",
      evaluationConfigFingerprint: SHA_A,
      traceId: "trace-1",
      traceSchemaVersion: "ea-trace-v1",
      traceSha256: SHA_A,
      outputSha256: SHA_B,
      rawOutputSha256: SHA_C,
      artifactSha256s: [SHA_C],
      actualSkillVersions: [
        { skillVersionId: "skill-version-current", artifactSha256: SHA_B },
      ],
      traceSource: "synthetic_fixture",
      runtimeIdentityStatus: "UNVERIFIED",
      runtimeEventFingerprint: SHA_C,
      judgeStatus: "NOT_CONFIGURED",
      judgeResultFingerprint: null,
      completedAt: "2026-08-28T10:01:00+08:00",
      runEvidenceFingerprint: "0".repeat(64),
    };
    base.runEvidenceFingerprint = runEvidenceFingerprint(base);
    const repeated = {
      ...base,
      runId: "eval-run-2",
      traceId: "trace-2",
      completedAt: "2026-08-28T10:02:00+08:00",
      runEvidenceFingerprint: "0".repeat(64),
    };
    repeated.runEvidenceFingerprint = runEvidenceFingerprint(repeated);
    expect(repeated.runEvidenceFingerprint).not.toBe(
      base.runEvidenceFingerprint
    );
    expect(repeated.evaluationConfigFingerprint).toBe(
      base.evaluationConfigFingerprint
    );
    expect(skillEvaluationRunEvidenceV1Schema.safeParse(base).success).toBe(
      true
    );
    expect(
      skillEvaluationRunEvidenceV1Schema.safeParse({
        ...base,
        judgeStatus: "EXECUTED",
        judgeResultFingerprint: null,
      }).success
    ).toBe(false);
  });

  it("rejects unknown fields instead of silently excluding them from fingerprints", () => {
    const suitePath = path.join(
      process.cwd(),
      "examples/skill-quality-evaluation-v1/suites/wealth-manager-assistant.v1.json"
    );
    const suite = JSON.parse(readFileSync(suitePath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(
      skillEvalSuiteV1Schema.safeParse({ ...suite, unreviewedPolicy: true })
        .success
    ).toBe(false);
    const cases = suite.cases as Array<Record<string, unknown>>;
    expect(
      skillEvalSuiteV1Schema.safeParse({
        ...suite,
        cases: [{ ...cases[0], unreviewedPolicy: true }, ...cases.slice(1)],
      }).success
    ).toBe(false);
    expect(
      skillEvaluationRunSnapshotV1Schema.safeParse({
        ...snapshot(),
        executionPolicy: {
          ...snapshot().executionPolicy,
          hiddenRetryOverride: 5,
        },
      }).success
    ).toBe(false);
  });

  it("requires baseline modes to be unique and version baselines to differ from the target", () => {
    const manifestPath = path.join(
      process.cwd(),
      "examples/skill-quality-evaluation-v1/pilot-baselines.v1.json"
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      pilots: Array<{
        skillId: string;
        target: {
          skillVersionId: string;
          version: string;
          artifactSha256: string;
        };
        baselines: Array<{
          mode: string;
          skillVersionId: string | null;
          version: string | null;
          artifactSha256: string | null;
        }>;
      }>;
    } & Record<string, unknown>;
    const wealth = manifest.pilots.find(
      pilot => pilot.skillId === "wealth-manager-assistant"
    );
    if (!wealth) throw new Error("wealth pilot fixture is missing");
    const previous = wealth.baselines.find(
      baseline => baseline.mode === "previous_version"
    );
    if (!previous) throw new Error("previous version fixture is missing");

    const samePrevious = structuredClone(manifest);
    const sameWealth = samePrevious.pilots.find(
      pilot => pilot.skillId === "wealth-manager-assistant"
    )!;
    const sameBaseline = sameWealth.baselines.find(
      baseline => baseline.mode === "previous_version"
    )!;
    Object.assign(sameBaseline, sameWealth.target);
    expect(pilotManifestSchema.safeParse(samePrevious).success).toBe(false);

    const reusedTargetId = structuredClone(manifest);
    const reusedTargetIdWealth = reusedTargetId.pilots.find(
      pilot => pilot.skillId === "wealth-manager-assistant"
    )!;
    reusedTargetIdWealth.baselines.find(
      baseline => baseline.mode === "previous_version"
    )!.skillVersionId = reusedTargetIdWealth.target.skillVersionId;
    expect(pilotManifestSchema.safeParse(reusedTargetId).success).toBe(false);

    const reusedTargetArtifact = structuredClone(manifest);
    const reusedTargetArtifactWealth = reusedTargetArtifact.pilots.find(
      pilot => pilot.skillId === "wealth-manager-assistant"
    )!;
    reusedTargetArtifactWealth.baselines.find(
      baseline => baseline.mode === "previous_version"
    )!.artifactSha256 = reusedTargetArtifactWealth.target.artifactSha256;
    expect(pilotManifestSchema.safeParse(reusedTargetArtifact).success).toBe(
      false
    );

    const laterPrevious = structuredClone(manifest);
    const laterWealth = laterPrevious.pilots.find(
      pilot => pilot.skillId === "wealth-manager-assistant"
    )!;
    const laterBaseline = laterWealth.baselines.find(
      baseline => baseline.mode === "previous_version"
    )!;
    laterBaseline.version = "3.0.0";
    expect(pilotManifestSchema.safeParse(laterPrevious).success).toBe(false);

    const duplicateMode = structuredClone(manifest);
    const duplicateWealth = duplicateMode.pilots.find(
      pilot => pilot.skillId === "wealth-manager-assistant"
    )!;
    duplicateWealth.baselines.push(structuredClone(previous));
    expect(pilotManifestSchema.safeParse(duplicateMode).success).toBe(false);

    const specifiedTarget = structuredClone(manifest);
    const specifiedWealth = specifiedTarget.pilots.find(
      pilot => pilot.skillId === "wealth-manager-assistant"
    )!;
    specifiedWealth.baselines.push({
      mode: "specified_skill",
      ...specifiedWealth.target,
    });
    expect(pilotManifestSchema.safeParse(specifiedTarget).success).toBe(false);
  });

  it("binds hard-gate assertions to declared Profile gates", () => {
    expect(
      skillEvalAssertionV1Schema.safeParse({
        assertionId: "unbound-hard-gate",
        mode: "deterministic",
        hardGate: true,
        hardGateId: null,
        metricId: "task_success",
      }).success
    ).toBe(false);

    const root = createPhase0FixtureRoot();
    try {
      const suitePath = path.join(
        root,
        "examples/skill-quality-evaluation-v1/suites/wealth-manager-assistant.v1.json"
      );
      const suite = skillEvalSuiteV1Schema.parse(
        JSON.parse(readFileSync(suitePath, "utf8")) as unknown
      );
      const withoutPromptInjectionCoverage = {
        ...suite,
        cases: suite.cases.map(item => ({
          ...item,
          assertions: item.assertions.map(assertion =>
            assertion.hardGateId === "PROMPT_INJECTION_CONTAINMENT"
              ? { ...assertion, hardGate: false as const, hardGateId: null }
              : assertion
          ),
        })),
      };
      withoutPromptInjectionCoverage.suiteFingerprint =
        skillEvalSuiteFingerprint(withoutPromptInjectionCoverage);
      writeFileSync(
        suitePath,
        JSON.stringify(withoutPromptInjectionCoverage, null, 2)
      );

      const report = runSkillQualityPhase0ContractChecks(root);
      expect(report.status).toBe("FAIL");
      expect(report.errors.join("\n")).toMatch(
        /PROMPT_INJECTION_CONTAINMENT does not satisfy/u
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects Scorecards whose dimension weights do not sum to 100", () => {
    const profilePath = path.join(
      process.cwd(),
      "examples/skill-quality-evaluation-v1/profiles/governed-workflow-scorecard.v1.json"
    );
    const profile = JSON.parse(
      readFileSync(profilePath, "utf8")
    ) as SkillScorecardProfileV1;
    const invalid = {
      ...profile,
      dimensions: profile.dimensions.map((dimension, index) => ({
        ...dimension,
        weight: index === 0 ? 29 : dimension.weight,
      })),
    };
    expect(skillScorecardProfileV1Schema.safeParse(invalid).success).toBe(
      false
    );
  });

  it("requires unambiguous metric aggregation, calibration and grade coverage", () => {
    const profilePath = path.join(
      process.cwd(),
      "examples/skill-quality-evaluation-v1/profiles/governed-workflow-scorecard.v1.json"
    );
    const profile = JSON.parse(
      readFileSync(profilePath, "utf8")
    ) as SkillScorecardProfileV1;
    const badContributions = {
      ...profile,
      dimensions: profile.dimensions.map((dimension, index) => ({
        ...dimension,
        metricContributions:
          index === 0
            ? dimension.metricContributions.map(
                (contribution, contributionIndex) => ({
                  ...contribution,
                  weight: contributionIndex === 0 ? 35 : contribution.weight,
                })
              )
            : dimension.metricContributions,
      })),
    };
    expect(
      skillScorecardProfileV1Schema.safeParse(badContributions).success
    ).toBe(false);

    expect(
      skillScorecardProfileV1Schema.safeParse({
        ...profile,
        calibrationStatus: "calibrated",
        calibrationEvidence: [],
        formalGradesEnabled: true,
      }).success
    ).toBe(false);

    expect(
      skillScorecardProfileV1Schema.safeParse({
        ...profile,
        gradeThresholds: profile.gradeThresholds.map(item =>
          item.grade === "C" ? { ...item, maximumExclusive: 75 } : item
        ),
      }).success
    ).toBe(false);
  });

  it("rejects pilot versions that are not independently present in the inventory", () => {
    const root = createPhase0FixtureRoot();
    try {
      const manifestPath = path.join(
        root,
        "examples/skill-quality-evaluation-v1/pilot-baselines.v1.json"
      );
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        pilots: Array<{
          skillId: string;
          target: { skillVersionId: string };
        }>;
      } & Record<string, unknown>;
      const wealth = manifest.pilots.find(
        pilot => pilot.skillId === "wealth-manager-assistant"
      );
      if (!wealth) throw new Error("wealth pilot fixture is missing");
      wealth.target.skillVersionId = "skill-version-not-in-inventory";
      updateManifestFingerprint(manifest);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const report = runSkillQualityPhase0ContractChecks(root);
      expect(report.status).toBe("FAIL");
      expect(report.errors.join("\n")).toMatch(
        /not independently confirmed by the approved Skill inventory/u
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops before loading quality assets when a configured path escapes the repository", () => {
    const root = createPhase0FixtureRoot();
    try {
      const manifestPath = path.join(
        root,
        "examples/skill-quality-evaluation-v1/pilot-baselines.v1.json"
      );
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
        string,
        unknown
      >;
      manifest.scorecardProfilePath = "../outside-scorecard.json";
      updateManifestFingerprint(manifest);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const report = runSkillQualityPhase0ContractChecks(root);
      expect(report.status).toBe("FAIL");
      expect(report.pilotCount).toBe(0);
      expect(report.errors).toContain(
        "Skill quality asset path escapes the repository: ../outside-scorecard.json"
      );
      expect(report.errors.join("\n")).not.toMatch(
        /cannot be read|is missing/u
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails the strict gate when approved artifacts are not mounted", () => {
    const emptySkillStore = mkdtempSync(
      path.join(tmpdir(), "skill-quality-empty-store-")
    );
    try {
      const report = runSkillQualityPhase0ContractChecks(process.cwd(), {
        requireLocalArtifacts: true,
        skillStoreRoot: emptySkillStore,
      });
      expect(report.status).toBe("FAIL");
      expect(report.locallyVerifiedArtifactCount).toBe(0);
      expect(report.errors.join("\n")).toMatch(
        /local approved artifact is unavailable/u
      );
    } finally {
      rmSync(emptySkillStore, { recursive: true, force: true });
    }
  });
});
