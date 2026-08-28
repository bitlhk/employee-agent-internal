import { z } from "zod";
import {
  sha256Schema,
  skillRuntimeIdSchema,
  strictSemverSchema,
} from "./skill-market-v2";

export const SKILL_EVAL_SUITE_V1_SCHEMA = "ea.skill-eval-suite.v1" as const;
export const SKILL_EVALUATION_RUN_SNAPSHOT_V1_SCHEMA =
  "ea.skill-evaluation-run-snapshot.v1" as const;
export const SKILL_EVALUATION_RUN_EVIDENCE_V1_SCHEMA =
  "ea.skill-evaluation-run-evidence.v1" as const;
export const SKILL_SCORECARD_PROFILE_V1_SCHEMA =
  "ea.skill-scorecard-profile.v1" as const;
export const JUDGE_PROFILE_V1_SCHEMA = "ea.skill-judge-profile.v1" as const;

const nonEmptyId = z.string().trim().min(1).max(256);
const isoTimestamp = z.string().datetime({ offset: true });

export const skillEvaluationSkillTypeSchema = z.enum([
  "governed_workflow",
  "knowledge_retrieval",
  "content_generation",
  "tool_execution",
]);
export type SkillEvaluationSkillType = z.infer<
  typeof skillEvaluationSkillTypeSchema
>;

export const skillEvaluationBaselineModeSchema = z.enum([
  "without_target_skill",
  "previous_version",
  "specified_skill",
]);
export type SkillEvaluationBaselineMode = z.infer<
  typeof skillEvaluationBaselineModeSchema
>;

export const skillEvaluationExecutionArmSchema = z.enum([
  "target_skill",
  "without_target_skill",
  "previous_version",
  "specified_skill",
]);
export type SkillEvaluationExecutionArm = z.infer<
  typeof skillEvaluationExecutionArmSchema
>;

export const skillEvalSourceReferenceV1Schema = z.strictObject({
  sourceType: z.enum([
    "repository_file",
    "benchmark",
    "golden_task",
    "expert_ground_truth",
    "approved_skill_artifact",
  ]),
  reference: z.string().trim().min(1).max(2_048),
  contentSha256: sha256Schema,
});

export const skillEvalAssertionV1Schema = z
  .strictObject({
    assertionId: nonEmptyId,
    mode: z.enum(["deterministic", "judge"]),
    hardGate: z.boolean(),
    hardGateId: nonEmptyId.nullable(),
    metricId: nonEmptyId.nullable().default(null),
  })
  .superRefine((assertion, context) => {
    if (assertion.hardGate !== Boolean(assertion.hardGateId)) {
      context.addIssue({
        code: "custom",
        path: ["hardGateId"],
        message:
          "hard-gate assertions require a hardGateId; diagnostic assertions must not declare one",
      });
    }
  });

export const skillEvalCaseV1Schema = z.strictObject({
  caseId: nonEmptyId,
  name: z.string().trim().min(1).max(512),
  importance: z.enum(["critical", "high", "normal"]),
  skillType: skillEvaluationSkillTypeSchema,
  taskId: nonEmptyId.nullable().default(null),
  prompt: z.string().trim().min(1),
  expectedOutput: z.string().trim().min(1),
  fixtureRefs: z.array(nonEmptyId).default([]),
  assertions: z.array(skillEvalAssertionV1Schema).min(1),
  requiredTrace: z.record(z.string(), z.unknown()).default({}),
  baselineModes: z.array(skillEvaluationBaselineModeSchema).min(1),
  minimumRuns: z.number().int().positive().default(1),
});
export type SkillEvalCaseV1 = z.infer<typeof skillEvalCaseV1Schema>;

export const skillEvalExpertReviewV1Schema = z
  .strictObject({
    status: z.enum([
      "proposed",
      "expert_reviewing",
      "expert_confirmed",
      "needs_resolution",
    ]),
    reviewerId: nonEmptyId.nullable().default(null),
    reviewerRole: z.string().trim().min(1).max(256).nullable().default(null),
    reviewedAt: isoTimestamp.nullable().default(null),
    reviewComment: z.string().trim().min(1).max(8_000).nullable().default(null),
    groundTruthVersion: nonEmptyId.nullable().default(null),
  })
  .superRefine((review, context) => {
    if (
      review.status === "expert_confirmed" &&
      (!review.reviewerId ||
        !review.reviewerRole ||
        !review.reviewedAt ||
        !review.reviewComment ||
        !review.groundTruthVersion)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "expert-confirmed Eval Suites require reviewer identity, role, timestamp, comment and Ground Truth version",
      });
    }
  });

export const skillEvalSuiteV1Schema = z
  .strictObject({
    schemaVersion: z.literal(SKILL_EVAL_SUITE_V1_SCHEMA),
    suiteId: nonEmptyId,
    skillIdentityId: nonEmptyId,
    skillId: skillRuntimeIdSchema,
    targetVersionId: nonEmptyId,
    targetVersion: strictSemverSchema,
    targetArtifactSha256: sha256Schema,
    suiteVersion: strictSemverSchema,
    suiteFingerprint: sha256Schema,
    sourceReferences: z.array(skillEvalSourceReferenceV1Schema).min(1),
    cases: z.array(skillEvalCaseV1Schema).min(1),
    requiredHardGateIds: z.array(nonEmptyId).min(1),
    dataSnapshotRequirements: z.array(nonEmptyId).default([]),
    expertReview: skillEvalExpertReviewV1Schema,
    status: z.enum(["draft", "frozen", "retired"]),
  })
  .superRefine((suite, context) => {
    const caseIds = new Set<string>();
    const sourceRefs = new Set<string>();
    for (const source of suite.sourceReferences) {
      const key = `${source.sourceType}:${source.reference}`;
      if (sourceRefs.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["sourceReferences"],
          message: `duplicate Eval source ${key}`,
        });
      }
      sourceRefs.add(key);
    }
    for (const item of suite.cases) {
      if (caseIds.has(item.caseId)) {
        context.addIssue({
          code: "custom",
          path: ["cases"],
          message: `duplicate Eval case ${item.caseId}`,
        });
      }
      caseIds.add(item.caseId);
      const assertionIds = new Set<string>();
      for (const assertion of item.assertions) {
        if (assertionIds.has(assertion.assertionId)) {
          context.addIssue({
            code: "custom",
            path: ["cases"],
            message: `${item.caseId}: duplicate assertion ${assertion.assertionId}`,
          });
        }
        assertionIds.add(assertion.assertionId);
      }
    }
    if (
      new Set(suite.requiredHardGateIds).size !==
      suite.requiredHardGateIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["requiredHardGateIds"],
        message: "required hard gates must be unique",
      });
    }
  });
export type SkillEvalSuiteV1 = z.infer<typeof skillEvalSuiteV1Schema>;

const skillVersionRefSchema = z.strictObject({
  skillVersionId: nonEmptyId,
  artifactSha256: sha256Schema,
});

const skillRuntimeExpectationSchema = skillVersionRefSchema.extend({
  skillId: skillRuntimeIdSchema,
  version: strictSemverSchema,
});

export const skillEvaluationRunSnapshotV1Schema = z
  .strictObject({
    schemaVersion: z.literal(SKILL_EVALUATION_RUN_SNAPSHOT_V1_SCHEMA),
    runId: nonEmptyId,
    createdAt: isoTimestamp,
    suiteId: nonEmptyId,
    suiteVersion: strictSemverSchema,
    suiteFingerprint: sha256Schema,
    caseId: nonEmptyId,
    repeatIndex: z.number().int().positive(),
    executionArm: skillEvaluationExecutionArmSchema,
    targetSkill: skillVersionRefSchema,
    baselineMode: skillEvaluationBaselineModeSchema.nullable(),
    baselineSkill: skillVersionRefSchema.nullable(),
    expectedRuntimeSkills: z.array(skillRuntimeExpectationSchema).max(1),
    rolePackReleaseId: nonEmptyId,
    rolePackReleaseFingerprint: sha256Schema,
    systemPromptFingerprint: sha256Schema,
    model: z.strictObject({
      provider: nonEmptyId,
      modelId: nonEmptyId,
      modelVersion: nonEmptyId,
      config: z.record(z.string(), z.unknown()),
    }),
    contextSnapshotId: nonEmptyId,
    contextFingerprint: sha256Schema,
    dataSnapshotId: nonEmptyId,
    dataFingerprint: sha256Schema,
    principal: z.strictObject({
      principalId: nonEmptyId,
      purpose: nonEmptyId,
      permissionSnapshotId: nonEmptyId,
      permissionFingerprint: sha256Schema,
    }),
    toolPolicyFingerprint: sha256Schema,
    toolVersions: z.record(z.string(), nonEmptyId),
    runtime: z.strictObject({
      evalAdoptionId: nonEmptyId,
      sessionId: nonEmptyId,
      workspaceId: nonEmptyId,
      executionMode: z.enum(["controlled_harness", "ea_runtime"]),
      runtimeIdentityStatus: z.enum(["UNVERIFIED", "VERIFIED"]),
      cleanSession: z.literal(true),
      cleanWorkspace: z.literal(true),
      noSideEffectMode: z.literal(true),
    }),
    executionPolicy: z
      .strictObject({
        timeoutMs: z.number().int().positive(),
        maxRetries: z.number().int().nonnegative(),
        retryBackoffMs: z.number().int().nonnegative(),
        concurrency: z.number().int().positive(),
        maxToolCalls: z.number().int().positive(),
        tokenBudget: z.strictObject({
          maxPromptTokens: z.number().int().positive(),
          maxCompletionTokens: z.number().int().positive(),
          maxTotalTokens: z.number().int().positive(),
        }),
        networkEgress: z.strictObject({
          mode: z.literal("deny_by_default"),
          allowedEndpointFingerprints: z.array(sha256Schema),
        }),
      })
      .superRefine((policy, context) => {
        if (
          policy.tokenBudget.maxTotalTokens <
          Math.max(
            policy.tokenBudget.maxPromptTokens,
            policy.tokenBudget.maxCompletionTokens
          )
        ) {
          context.addIssue({
            code: "custom",
            path: ["tokenBudget", "maxTotalTokens"],
            message:
              "the total token budget must cover both prompt and completion limits",
          });
        }
        if (
          new Set(policy.networkEgress.allowedEndpointFingerprints).size !==
          policy.networkEgress.allowedEndpointFingerprints.length
        ) {
          context.addIssue({
            code: "custom",
            path: ["networkEgress", "allowedEndpointFingerprints"],
            message: "network endpoint fingerprints must be unique",
          });
        }
      }),
    scorecardProfileFingerprint: sha256Schema,
    judgeStatus: z.enum(["NOT_CONFIGURED", "READY"]),
    judgeProfileFingerprint: sha256Schema.nullable(),
    runnerVersion: nonEmptyId,
    providerVersion: nonEmptyId,
    evaluationConfigFingerprint: sha256Schema,
  })
  .superRefine((snapshot, context) => {
    const targetArm = snapshot.executionArm === "target_skill";
    const withoutTargetSkillArm = snapshot.executionArm === "without_target_skill";
    const versionBaselineArm =
      snapshot.executionArm === "previous_version" ||
      snapshot.executionArm === "specified_skill";
    const validBaselineIdentity = targetArm
      ? snapshot.baselineMode === null && snapshot.baselineSkill === null
      : withoutTargetSkillArm
        ? snapshot.baselineMode === "without_target_skill" &&
          snapshot.baselineSkill === null
        : snapshot.baselineMode === snapshot.executionArm &&
          snapshot.baselineSkill !== null;
    if (!validBaselineIdentity) {
      context.addIssue({
        code: "custom",
        path: ["executionArm"],
        message:
          "execution arm, baseline mode and baseline Skill identity are inconsistent",
      });
    }
    const expected = snapshot.expectedRuntimeSkills;
    const expectedSkillIdentity = targetArm
      ? expected.length === 1 &&
        expected[0]?.skillVersionId === snapshot.targetSkill.skillVersionId &&
        expected[0]?.artifactSha256 === snapshot.targetSkill.artifactSha256
      : withoutTargetSkillArm
        ? expected.length === 0
        : versionBaselineArm &&
          expected.length === 1 &&
          expected[0]?.skillVersionId ===
            snapshot.baselineSkill?.skillVersionId &&
          expected[0]?.artifactSha256 ===
            snapshot.baselineSkill?.artifactSha256;
    if (!expectedSkillIdentity) {
      context.addIssue({
        code: "custom",
        path: ["expectedRuntimeSkills"],
        message: "runtime Skill expectation does not match the execution arm",
      });
    }
    if (
      snapshot.judgeStatus === "NOT_CONFIGURED" &&
      snapshot.judgeProfileFingerprint !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["judgeProfileFingerprint"],
        message: "an unconfigured Judge must not carry a Profile fingerprint",
      });
    }
    if (
      snapshot.judgeStatus !== "NOT_CONFIGURED" &&
      snapshot.judgeProfileFingerprint === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["judgeProfileFingerprint"],
        message: "a configured Judge requires a Profile fingerprint",
      });
    }
  });
export type SkillEvaluationRunSnapshotV1 = z.infer<
  typeof skillEvaluationRunSnapshotV1Schema
>;

export const skillEvaluationRunEvidenceV1Schema = z
  .strictObject({
    schemaVersion: z.literal(SKILL_EVALUATION_RUN_EVIDENCE_V1_SCHEMA),
    runId: nonEmptyId,
    evaluationConfigFingerprint: sha256Schema,
    traceId: nonEmptyId,
    traceSchemaVersion: nonEmptyId,
    traceSha256: sha256Schema,
    outputSha256: sha256Schema,
    rawOutputSha256: sha256Schema,
    artifactSha256s: z.array(sha256Schema),
    actualSkillVersions: z.array(skillVersionRefSchema),
    traceSource: z.enum(["synthetic_fixture", "ea_runtime"]),
    runtimeIdentityStatus: z.enum(["UNVERIFIED", "VERIFIED"]),
    runtimeEventFingerprint: sha256Schema,
    judgeStatus: z.enum(["NOT_CONFIGURED", "EXECUTED", "PENDING_REVIEW"]),
    judgeResultFingerprint: sha256Schema.nullable(),
    completedAt: isoTimestamp,
    runEvidenceFingerprint: sha256Schema,
  })
  .superRefine((evidence, context) => {
    const requiresJudgeResult = evidence.judgeStatus !== "NOT_CONFIGURED";
    if (requiresJudgeResult !== Boolean(evidence.judgeResultFingerprint)) {
      context.addIssue({
        code: "custom",
        path: ["judgeResultFingerprint"],
        message:
          "executed or pending-review Judge evidence requires a result fingerprint; non-Judge runs must not carry one",
      });
    }
  });
export type SkillEvaluationRunEvidenceV1 = z.infer<
  typeof skillEvaluationRunEvidenceV1Schema
>;

export const scorecardMetricDefinitionV1Schema = z
  .strictObject({
    metricId: nonEmptyId,
    displayName: z.string().trim().min(1).max(256),
    normalization: z.enum(["ratio", "pairwise", "bounded_high", "bounded_low"]),
    floor: z.number().finite().nullable().default(null),
    cap: z.number().finite().nullable().default(null),
  })
  .superRefine((metric, context) => {
    const bounded = metric.normalization.startsWith("bounded_");
    if (
      bounded &&
      (metric.floor === null ||
        metric.cap === null ||
        metric.floor >= metric.cap)
    ) {
      context.addIssue({
        code: "custom",
        message: "bounded metrics require floor < cap",
      });
    }
  });

export const skillScorecardProfileV1Schema = z
  .strictObject({
    schemaVersion: z.literal(SKILL_SCORECARD_PROFILE_V1_SCHEMA),
    profileId: nonEmptyId,
    profileVersion: strictSemverSchema,
    profileFingerprint: sha256Schema,
    applicableSkillTypes: z.array(skillEvaluationSkillTypeSchema).min(1),
    dimensions: z
      .array(
        z.strictObject({
          dimensionId: nonEmptyId,
          displayName: z.string().trim().min(1).max(256),
          weight: z.number().positive().max(100),
          metricContributions: z
            .array(
              z.strictObject({
                metricId: nonEmptyId,
                weight: z.number().positive().max(100),
              })
            )
            .min(1),
        })
      )
      .min(1),
    metrics: z.array(scorecardMetricDefinitionV1Schema).min(1),
    requiredMetrics: z.array(nonEmptyId).min(1),
    optionalMetrics: z.array(nonEmptyId).default([]),
    caseImportanceWeights: z.strictObject({
      critical: z.number().positive(),
      high: z.number().positive(),
      normal: z.number().positive(),
    }),
    repeatPolicy: z.strictObject({
      minimumRuns: z.number().int().positive(),
      reportMean: z.boolean(),
      reportStandardDeviation: z.boolean(),
      reportMinimum: z.boolean(),
      reportFailureCount: z.boolean(),
    }),
    missingMetricPolicy: z.literal("invalidate_case"),
    judgeDisagreementPolicy: z.literal("expert_review"),
    hardGates: z
      .array(
        z.strictObject({
          hardGateId: nonEmptyId,
          displayName: z.string().trim().min(1).max(256),
          executionSource: z.enum(["assertion", "runner"]),
          coverageRequirement: z.enum([
            "at_least_one_assertion_per_declaring_suite",
            "every_case_in_declaring_suite",
            "every_run",
          ]),
          runnerCheckId: nonEmptyId.nullable(),
        })
      )
      .min(1),
    gradeThresholds: z.array(
      z.strictObject({
        grade: z.enum(["A", "B", "C", "D"]),
        minimumInclusive: z.number().min(0).max(100),
        maximumExclusive: z.number().positive().max(100).nullable(),
      })
    ),
    calibrationStatus: z.enum(["pilot", "calibrated"]),
    calibrationEvidence: z.array(nonEmptyId).default([]),
    formalGradesEnabled: z.boolean(),
    status: z.enum(["active", "retired"]),
  })
  .superRefine((profile, context) => {
    const dimensionWeight = profile.dimensions.reduce(
      (total, dimension) => total + dimension.weight,
      0
    );
    if (Math.abs(dimensionWeight - 100) > 0.000001) {
      context.addIssue({
        code: "custom",
        path: ["dimensions"],
        message: "Scorecard dimension weights must sum to 100",
      });
    }
    const metricIds = new Set(profile.metrics.map(metric => metric.metricId));
    if (metricIds.size !== profile.metrics.length) {
      context.addIssue({
        code: "custom",
        path: ["metrics"],
        message: "Scorecard metric IDs must be unique",
      });
    }
    const dimensionIds = new Set(
      profile.dimensions.map(dimension => dimension.dimensionId)
    );
    if (dimensionIds.size !== profile.dimensions.length) {
      context.addIssue({
        code: "custom",
        path: ["dimensions"],
        message: "Scorecard dimension IDs must be unique",
      });
    }
    const referenced = [
      ...profile.requiredMetrics,
      ...profile.optionalMetrics,
      ...profile.dimensions.flatMap(dimension =>
        dimension.metricContributions.map(contribution => contribution.metricId)
      ),
    ];
    for (const metricId of referenced) {
      if (!metricIds.has(metricId)) {
        context.addIssue({
          code: "custom",
          message: `Scorecard references unknown metric ${metricId}`,
        });
      }
    }
    const optional = new Set(profile.optionalMetrics);
    if (
      new Set(profile.requiredMetrics).size !== profile.requiredMetrics.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["requiredMetrics"],
        message: "required Scorecard metrics must be unique",
      });
    }
    if (optional.size !== profile.optionalMetrics.length) {
      context.addIssue({
        code: "custom",
        path: ["optionalMetrics"],
        message: "optional Scorecard metrics must be unique",
      });
    }
    for (const metricId of profile.requiredMetrics) {
      if (optional.has(metricId)) {
        context.addIssue({
          code: "custom",
          message: `metric ${metricId} cannot be both required and optional`,
        });
      }
    }
    const classifiedMetrics = new Set([
      ...profile.requiredMetrics,
      ...profile.optionalMetrics,
    ]);
    for (const metricId of metricIds) {
      if (!classifiedMetrics.has(metricId)) {
        context.addIssue({
          code: "custom",
          path: ["requiredMetrics"],
          message: `metric ${metricId} must be classified as required or optional`,
        });
      }
    }
    for (const dimension of profile.dimensions) {
      const contributionIds = new Set(
        dimension.metricContributions.map(contribution => contribution.metricId)
      );
      if (contributionIds.size !== dimension.metricContributions.length) {
        context.addIssue({
          code: "custom",
          path: ["dimensions"],
          message: `${dimension.dimensionId}: metric contributions must be unique`,
        });
      }
      const contributionWeight = dimension.metricContributions.reduce(
        (total, contribution) => total + contribution.weight,
        0
      );
      if (Math.abs(contributionWeight - 100) > 0.000001) {
        context.addIssue({
          code: "custom",
          path: ["dimensions"],
          message: `${dimension.dimensionId}: metric contribution weights must sum to 100`,
        });
      }
    }
    const contributedMetricIds = profile.dimensions.flatMap(dimension =>
      dimension.metricContributions.map(contribution => contribution.metricId)
    );
    const contributedMetrics = new Set(contributedMetricIds);
    if (
      contributedMetrics.size !== contributedMetricIds.length ||
      contributedMetrics.size !== metricIds.size ||
      [...metricIds].some(metricId => !contributedMetrics.has(metricId))
    ) {
      context.addIssue({
        code: "custom",
        path: ["dimensions"],
        message:
          "every Scorecard metric must contribute to exactly one dimension",
      });
    }
    if (
      profile.calibrationStatus === "calibrated" &&
      profile.calibrationEvidence.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["calibrationEvidence"],
        message: "calibrated Scorecards require calibration evidence",
      });
    }
    if (
      new Set(profile.calibrationEvidence).size !==
      profile.calibrationEvidence.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["calibrationEvidence"],
        message: "Scorecard calibration evidence must be unique",
      });
    }
    const hardGateIds = new Set(
      profile.hardGates.map(hardGate => hardGate.hardGateId)
    );
    if (hardGateIds.size !== profile.hardGates.length) {
      context.addIssue({
        code: "custom",
        path: ["hardGates"],
        message: "Scorecard hard gates must be unique",
      });
    }
    for (const hardGate of profile.hardGates) {
      const runnerGate = hardGate.executionSource === "runner";
      const validRunnerGate =
        runnerGate &&
        hardGate.coverageRequirement === "every_run" &&
        Boolean(hardGate.runnerCheckId);
      const validAssertionGate =
        !runnerGate &&
        hardGate.coverageRequirement !== "every_run" &&
        hardGate.runnerCheckId === null;
      if (!validRunnerGate && !validAssertionGate) {
        context.addIssue({
          code: "custom",
          path: ["hardGates"],
          message: `${hardGate.hardGateId}: runner gates require every_run coverage and runnerCheckId; assertion gates require assertion coverage without a runnerCheckId`,
        });
      }
    }
    if (
      profile.formalGradesEnabled !==
      (profile.calibrationStatus === "calibrated")
    ) {
      context.addIssue({
        code: "custom",
        path: ["formalGradesEnabled"],
        message: "formal grades are enabled only for calibrated Scorecards",
      });
    }
    const sortedGrades = [...profile.gradeThresholds].sort(
      (left, right) => left.minimumInclusive - right.minimumInclusive
    );
    const expectedGrades = ["D", "C", "B", "A"] as const;
    const completeGradeCoverage =
      sortedGrades.length === expectedGrades.length &&
      sortedGrades.every(
        (item, index) => item.grade === expectedGrades[index]
      ) &&
      sortedGrades[0]?.minimumInclusive === 0 &&
      sortedGrades.at(-1)?.maximumExclusive === null &&
      sortedGrades.every((item, index) => {
        if (index === sortedGrades.length - 1) return true;
        const next = sortedGrades[index + 1];
        return (
          item.maximumExclusive !== null &&
          item.maximumExclusive > item.minimumInclusive &&
          item.maximumExclusive === next.minimumInclusive
        );
      });
    if (!completeGradeCoverage) {
      context.addIssue({
        code: "custom",
        path: ["gradeThresholds"],
        message:
          "Scorecard grades must continuously and uniquely cover [0,100] as D, C, B and A half-open ranges",
      });
    }
  });
export type SkillScorecardProfileV1 = z.infer<
  typeof skillScorecardProfileV1Schema
>;

export const judgeProfileV1Schema = z
  .strictObject({
    schemaVersion: z.literal(JUDGE_PROFILE_V1_SCHEMA),
    judgeProfileId: nonEmptyId,
    profileVersion: strictSemverSchema,
    judgeProfileFingerprint: sha256Schema,
    provider: nonEmptyId.nullable(),
    modelId: nonEmptyId.nullable(),
    modelVersion: nonEmptyId.nullable(),
    modelConfig: z.record(z.string(), z.unknown()),
    rubricVersion: strictSemverSchema,
    rubric: z
      .array(
        z.strictObject({
          criterionId: nonEmptyId,
          description: z.string().trim().min(1),
          weight: z.number().positive().max(100),
        })
      )
      .min(1),
    outputSchemaVersion: nonEmptyId,
    blindOrderSeedPolicy: z.literal("run_seed_with_reverse_order"),
    repeatPolicy: z.strictObject({
      minimumVotes: z.number().int().positive(),
      reverseOrder: z.literal(true),
    }),
    disagreementThreshold: z.number().min(0).max(1),
    expertCalibration: z.strictObject({
      status: z.enum(["unavailable", "pending", "calibrated"]),
      datasetId: nonEmptyId.nullable(),
      calibrationFingerprint: sha256Schema.nullable(),
    }),
    approvedDataClassifications: z.array(nonEmptyId),
    status: z.enum(["unavailable", "draft", "calibrated", "suspended"]),
  })
  .superRefine((profile, context) => {
    const rubricWeight = profile.rubric.reduce(
      (total, criterion) => total + criterion.weight,
      0
    );
    if (Math.abs(rubricWeight - 100) > 0.000001) {
      context.addIssue({
        code: "custom",
        path: ["rubric"],
        message: "Judge rubric weights must sum to 100",
      });
    }
    const criterionIds = new Set(
      profile.rubric.map(criterion => criterion.criterionId)
    );
    if (criterionIds.size !== profile.rubric.length) {
      context.addIssue({
        code: "custom",
        path: ["rubric"],
        message: "Judge rubric criterion IDs must be unique",
      });
    }
    if (
      profile.status === "calibrated" &&
      (!profile.provider ||
        !profile.modelId ||
        !profile.modelVersion ||
        profile.expertCalibration.status !== "calibrated" ||
        !profile.expertCalibration.datasetId ||
        !profile.expertCalibration.calibrationFingerprint)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "calibrated Judge Profiles require a pinned model and expert calibration evidence",
      });
    }
  });
export type JudgeProfileV1 = z.infer<typeof judgeProfileV1Schema>;
