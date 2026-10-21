import type { SkillEvalSuiteV1, SkillEvaluationBaselineMode, SkillEvaluationExecutionArm, SkillEvaluationRunEvidenceV1, SkillEvaluationRunSnapshotV1 } from "../../shared/skill-quality-evaluation";
import { type PilotManifest } from "./skill-quality-evaluation-contracts";
import { type SkillEvaluationAssertionResult, type WealthSkillEvaluationOutput } from "./skill-quality-wealth-pilot";

export type Pilot = PilotManifest["pilots"][number];

export type SkillQualityPhase1SourceArtifact = {
  skillId: string;
  skillVersionId: string;
  version: string;
  artifactSha256: string;
  artifactRelativePath: string;
  controlledReferencePathsByCase?: Record<string, string[]>;
};

export type VersionIdentity = SkillQualityPhase1SourceArtifact;

export type ArmDefinition = {
  executionArm: SkillEvaluationExecutionArm;
  baselineMode: SkillEvaluationBaselineMode | null;
  version: VersionIdentity | null;
};

export type HarnessArtifactIdentityCheck = {
  status: "PASS" | "FAIL";
  expected: VersionIdentity | null;
  actual: VersionIdentity[];
  targetArtifactPresentInBaseline: boolean;
  detail: string;
};

export type RunRecord = {
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
  sourceIdentityMode: "approved_inventory" | "candidate_repository";
  comparisonFingerprint: string | null;
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

export type SkillQualityPhase1CandidateComparison = {
  comparisonId: string;
  comparisonFingerprint: string;
  suite: SkillEvalSuiteV1;
  target: SkillQualityPhase1SourceArtifact;
  previousVersion: SkillQualityPhase1SourceArtifact;
  skillStoreRoot: string;
};
