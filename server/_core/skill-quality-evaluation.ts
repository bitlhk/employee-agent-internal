import type {
  JudgeProfileV1,
  SkillEvaluationRunEvidenceV1,
  SkillEvaluationRunSnapshotV1,
  SkillEvalSuiteV1,
  SkillScorecardProfileV1,
} from "../../shared/skill-quality-evaluation";
import { governanceFingerprint } from "./governance/contracts";

type Fingerprinted = Record<string, unknown>;

function without<T extends Fingerprinted>(
  value: T,
  keys: readonly (keyof T)[]
): Omit<T, keyof T> & Fingerprinted {
  const result = { ...value } as Fingerprinted;
  for (const key of keys) delete result[String(key)];
  return result as Omit<T, keyof T> & Fingerprinted;
}

export function skillEvalSuiteFingerprint(suite: SkillEvalSuiteV1): string {
  return governanceFingerprint(without(suite, ["suiteFingerprint"]));
}

export function skillScorecardProfileFingerprint(
  profile: SkillScorecardProfileV1
): string {
  return governanceFingerprint(without(profile, ["profileFingerprint"]));
}

export function judgeProfileFingerprint(profile: JudgeProfileV1): string {
  return governanceFingerprint(without(profile, ["judgeProfileFingerprint"]));
}

export function evaluationConfigFingerprint(
  snapshot: SkillEvaluationRunSnapshotV1
): string {
  const runtime = without(snapshot.runtime, [
    "evalAdoptionId",
    "sessionId",
    "workspaceId",
  ]);
  return governanceFingerprint({
    ...without(snapshot, [
      "runId",
      "createdAt",
      "evaluationConfigFingerprint",
      "runtime",
    ]),
    runtime,
  });
}

export function runEvidenceFingerprint(
  evidence: SkillEvaluationRunEvidenceV1
): string {
  return governanceFingerprint(without(evidence, ["runEvidenceFingerprint"]));
}

export function assertFingerprint(input: {
  label: string;
  actual: string;
  expected: string;
}): void {
  if (input.actual !== input.expected) {
    throw new Error(
      `${input.label} fingerprint mismatch: expected ${input.expected}, received ${input.actual}`
    );
  }
}
