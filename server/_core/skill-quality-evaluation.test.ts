import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
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
          judgeStatus: "CONFIGURED",
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
      outputSha256: SHA_B,
      artifactSha256s: [SHA_C],
      actualSkillVersions: [
        { skillVersionId: "skill-version-current", artifactSha256: SHA_B },
      ],
      toolCallFingerprint: SHA_C,
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
});
