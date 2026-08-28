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
  skillEvalSuiteV1Schema,
  skillEvaluationRunEvidenceV1Schema,
  skillEvaluationRunSnapshotV1Schema,
  skillScorecardProfileV1Schema,
  type SkillEvaluationRunEvidenceV1,
  type SkillEvaluationRunSnapshotV1,
  type SkillScorecardProfileV1,
} from "../../shared/skill-quality-evaluation";
import { runSkillQualityPhase0ContractChecks } from "./skill-quality-evaluation-contracts";
import {
  evaluationConfigFingerprint,
  runEvidenceFingerprint,
} from "./skill-quality-evaluation";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function snapshot(
  overrides: {
    runId?: string;
    createdAt?: string;
    evalAdoptionId?: string;
    sessionId?: string;
    workspaceId?: string;
    modelConfig?: Record<string, unknown>;
    timeoutMs?: number;
    maxTotalTokens?: number;
    allowedEndpointFingerprints?: string[];
    judgeStatus?: SkillEvaluationRunSnapshotV1["judgeStatus"];
    judgeProfileFingerprint?: string | null;
  } = {}
): SkillEvaluationRunSnapshotV1 {
  const value: SkillEvaluationRunSnapshotV1 = {
    schemaVersion: "ea.skill-evaluation-run-snapshot.v1",
    runId: overrides.runId || "eval-run-1",
    createdAt: overrides.createdAt || "2026-08-28T10:00:00+08:00",
    suiteId: "wealth-manager-assistant-quality-v1",
    suiteVersion: "1.0.0",
    suiteFingerprint: SHA_A,
    targetSkill: {
      skillVersionId: "skill-version-current",
      artifactSha256: SHA_B,
    },
    baselineMode: "previous_version",
    baselineSkill: {
      skillVersionId: "skill-version-previous",
      artifactSha256: SHA_C,
    },
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
    });
    expect(repeated.evaluationConfigFingerprint).toBe(
      first.evaluationConfigFingerprint
    );
    expect(
      snapshot({ modelConfig: { temperature: 0.2 } })
        .evaluationConfigFingerprint
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
      artifactSha256s: [SHA_C],
      actualSkillVersions: [
        { skillVersionId: "skill-version-current", artifactSha256: SHA_B },
      ],
      toolCallFingerprint: SHA_C,
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
    const root = mkdtempSync(path.join(tmpdir(), "skill-quality-phase0-"));
    try {
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
      const manifestPath = path.join(
        root,
        "examples/skill-quality-evaluation-v1/pilot-baselines.v1.json"
      );
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        pilots: Array<{
          skillId: string;
          target: { skillVersionId: string };
        }>;
      };
      const wealth = manifest.pilots.find(
        pilot => pilot.skillId === "wealth-manager-assistant"
      );
      if (!wealth) throw new Error("wealth pilot fixture is missing");
      wealth.target.skillVersionId = "skill-version-not-in-inventory";
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
});
