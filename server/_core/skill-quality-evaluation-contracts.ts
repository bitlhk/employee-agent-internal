import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  judgeProfileV1Schema,
  skillEvalSuiteV1Schema,
  skillEvaluationBaselineModeSchema,
  skillScorecardProfileV1Schema,
  type JudgeProfileV1,
  type SkillEvalSuiteV1,
  type SkillScorecardProfileV1,
} from "../../shared/skill-quality-evaluation";
import { sha256Schema, strictSemverSchema } from "../../shared/skill-market-v2";
import { governanceFingerprint } from "./governance/contracts";
import {
  judgeProfileFingerprint,
  skillEvalSuiteFingerprint,
  skillScorecardProfileFingerprint,
} from "./skill-quality-evaluation";

export const SKILL_QUALITY_EVALUATION_ROOT =
  "examples/skill-quality-evaluation-v1";
export const SKILL_QUALITY_PILOT_MANIFEST_PATH = `${SKILL_QUALITY_EVALUATION_ROOT}/pilot-baselines.v1.json`;

const nullableVersionRefSchema = z.object({
  mode: skillEvaluationBaselineModeSchema,
  skillVersionId: z.string().min(1).nullable(),
  version: strictSemverSchema.nullable(),
  artifactSha256: sha256Schema.nullable(),
});

const pilotManifestSchema = z
  .object({
    schemaVersion: z.literal("ea.skill-quality-evaluation-pilots.v1"),
    manifestVersion: strictSemverSchema,
    manifestFingerprint: sha256Schema,
    status: z.literal("phase_0_frozen"),
    scorecardProfilePath: z.string().min(1),
    judgeProfilePath: z.string().min(1),
    runtimeIsolation: z.object({
      dedicatedEvalAdoption: z.literal(true),
      cleanSessionPerArm: z.literal(true),
      cleanWorkspacePerArm: z.literal(true),
      noSideEffectMode: z.literal(true),
      productionInstallMutationAllowed: z.literal(false),
    }),
    pilots: z
      .array(
        z.object({
          skillId: z.string().min(1),
          skillIdentityId: z.string().min(1),
          suitePath: z.string().min(1),
          target: z.object({
            skillVersionId: z.string().min(1),
            version: strictSemverSchema,
            artifactSha256: sha256Schema,
          }),
          baselines: z.array(nullableVersionRefSchema).min(1),
          rolePackReleaseId: z.string().min(1).nullable(),
          goldenTaskRunId: z.string().min(1).nullable(),
          releaseEvidencePath: z.string().min(1).nullable(),
          executionPlan: z.enum(["full_mvp", "expert_ground_truth_first"]),
        })
      )
      .min(1),
  })
  .superRefine((manifest, context) => {
    const skillIds = new Set<string>();
    for (const pilot of manifest.pilots) {
      if (skillIds.has(pilot.skillId)) {
        context.addIssue({
          code: "custom",
          path: ["pilots"],
          message: `duplicate Skill quality pilot ${pilot.skillId}`,
        });
      }
      skillIds.add(pilot.skillId);
      for (const baseline of pilot.baselines) {
        const requiresVersion = baseline.mode !== "without_skill";
        const hasCompleteVersion = Boolean(
          baseline.skillVersionId && baseline.version && baseline.artifactSha256
        );
        if (requiresVersion !== hasCompleteVersion) {
          context.addIssue({
            code: "custom",
            path: ["pilots"],
            message: `${pilot.skillId}: ${baseline.mode} has an invalid version reference`,
          });
        }
      }
    }
  });

type PilotManifest = z.infer<typeof pilotManifestSchema>;

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

function isSafeRepositoryPath(value: string): boolean {
  if (path.isAbsolute(value)) return false;
  return !value.split(/[\\/]+/u).includes("..");
}

function fileSha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function formatZodErrors(prefix: string, error: z.ZodError): string[] {
  return error.issues.map(issue => {
    const field = issue.path.length ? `.${issue.path.join(".")}` : "";
    return `${prefix}${field}: ${issue.message}`;
  });
}

function manifestFingerprint(manifest: PilotManifest): string {
  const { manifestFingerprint: _stored, ...body } = manifest;
  return governanceFingerprint(body);
}

function loadContract<T>(input: {
  root: string;
  relativePath: string;
  schema: z.ZodType<T>;
  label: string;
  errors: string[];
}): T | null {
  const absolutePath = path.join(input.root, input.relativePath);
  if (!existsSync(absolutePath)) {
    input.errors.push(`${input.label} is missing: ${input.relativePath}`);
    return null;
  }
  try {
    const parsed = input.schema.safeParse(readJson(absolutePath));
    if (!parsed.success) {
      input.errors.push(...formatZodErrors(input.label, parsed.error));
      return null;
    }
    return parsed.data;
  } catch (error) {
    input.errors.push(
      `${input.label} cannot be read: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

function validateSuiteSources(input: {
  root: string;
  suite: SkillEvalSuiteV1;
  scorecard: SkillScorecardProfileV1;
  errors: string[];
}): void {
  const metricIds = new Set(
    input.scorecard.metrics.map(metric => metric.metricId)
  );
  for (const source of input.suite.sourceReferences) {
    if (source.sourceType === "approved_skill_artifact") continue;
    if (!isSafeRepositoryPath(source.reference)) {
      input.errors.push(
        `${input.suite.suiteId}: source path escapes the repository: ${source.reference}`
      );
      continue;
    }
    const sourcePath = path.join(input.root, source.reference);
    if (!existsSync(sourcePath)) {
      input.errors.push(
        `${input.suite.suiteId}: source is missing: ${source.reference}`
      );
      continue;
    }
    const actual = fileSha256(sourcePath);
    if (actual !== source.contentSha256) {
      input.errors.push(
        `${input.suite.suiteId}: source fingerprint drifted: ${source.reference}`
      );
    }
  }
  for (const item of input.suite.cases) {
    for (const assertion of item.assertions) {
      if (assertion.metricId && !metricIds.has(assertion.metricId)) {
        input.errors.push(
          `${item.caseId}: assertion references unknown Scorecard metric ${assertion.metricId}`
        );
      }
    }
  }
}

export type SkillQualityPhase0Report = {
  schema: "ea.skill-quality-phase-0-report.v1";
  status: "PASS" | "FAIL";
  phase: "phase_0";
  manifestFingerprint: string | null;
  scorecardProfileFingerprint: string | null;
  judgeProfileFingerprint: string | null;
  judgeAvailability: "unavailable" | "configured";
  pilotCount: number;
  pilots: Array<{
    skillId: string;
    targetVersion: string;
    targetArtifactSha256: string;
    suiteId: string;
    suiteFingerprint: string;
    caseCount: number;
    executionPlan: string;
    baselineModes: string[];
    expertReviewStatus: string;
  }>;
  warnings: string[];
  errors: string[];
};

export function runSkillQualityPhase0ContractChecks(
  root = process.cwd()
): SkillQualityPhase0Report {
  const errors: string[] = [];
  const warnings: string[] = [];
  const manifest = loadContract({
    root,
    relativePath: SKILL_QUALITY_PILOT_MANIFEST_PATH,
    schema: pilotManifestSchema,
    label: "Skill quality pilot manifest",
    errors,
  });
  if (!manifest) {
    return {
      schema: "ea.skill-quality-phase-0-report.v1",
      status: "FAIL",
      phase: "phase_0",
      manifestFingerprint: null,
      scorecardProfileFingerprint: null,
      judgeProfileFingerprint: null,
      judgeAvailability: "unavailable",
      pilotCount: 0,
      pilots: [],
      warnings,
      errors,
    };
  }

  const calculatedManifestFingerprint = manifestFingerprint(manifest);
  if (manifest.manifestFingerprint !== calculatedManifestFingerprint) {
    errors.push("Skill quality pilot manifest fingerprint is inconsistent");
  }
  for (const repositoryPath of [
    manifest.scorecardProfilePath,
    manifest.judgeProfilePath,
    ...manifest.pilots.flatMap(pilot => [
      pilot.suitePath,
      ...(pilot.releaseEvidencePath ? [pilot.releaseEvidencePath] : []),
    ]),
  ]) {
    if (!isSafeRepositoryPath(repositoryPath)) {
      errors.push(
        `Skill quality asset path escapes the repository: ${repositoryPath}`
      );
    }
  }
  const scorecard = loadContract({
    root,
    relativePath: manifest.scorecardProfilePath,
    schema: skillScorecardProfileV1Schema,
    label: "Skill Scorecard Profile",
    errors,
  });
  const judge = loadContract({
    root,
    relativePath: manifest.judgeProfilePath,
    schema: judgeProfileV1Schema,
    label: "Judge Profile",
    errors,
  });
  if (scorecard) {
    const calculated = skillScorecardProfileFingerprint(scorecard);
    if (scorecard.profileFingerprint !== calculated) {
      errors.push("Skill Scorecard Profile fingerprint is inconsistent");
    }
    if (scorecard.calibrationStatus !== "calibrated") {
      warnings.push(
        "Scorecard Profile is a pilot; formal scores and grades remain unavailable"
      );
    }
  }
  if (judge) {
    const calculated = judgeProfileFingerprint(judge);
    if (judge.judgeProfileFingerprint !== calculated) {
      errors.push("Judge Profile fingerprint is inconsistent");
    }
    if (judge.status !== "calibrated") {
      warnings.push(
        "Judge Profile is unavailable; subjective scores and formal grades remain unavailable"
      );
    }
  }

  const pilotReports: SkillQualityPhase0Report["pilots"] = [];
  for (const pilot of manifest.pilots) {
    const suite = loadContract({
      root,
      relativePath: pilot.suitePath,
      schema: skillEvalSuiteV1Schema,
      label: `Eval Suite ${pilot.skillId}`,
      errors,
    });
    if (!suite) continue;
    const calculated = skillEvalSuiteFingerprint(suite);
    if (suite.suiteFingerprint !== calculated) {
      errors.push(`${pilot.skillId}: Eval Suite fingerprint is inconsistent`);
    }
    if (
      suite.skillId !== pilot.skillId ||
      suite.skillIdentityId !== pilot.skillIdentityId ||
      suite.targetVersionId !== pilot.target.skillVersionId ||
      suite.targetVersion !== pilot.target.version ||
      suite.targetArtifactSha256 !== pilot.target.artifactSha256
    ) {
      errors.push(
        `${pilot.skillId}: pilot baseline and Eval Suite target differ`
      );
    }
    const declaredModes = new Set(pilot.baselines.map(item => item.mode));
    for (const item of suite.cases) {
      for (const mode of item.baselineModes) {
        if (!declaredModes.has(mode)) {
          errors.push(
            `${item.caseId}: baseline ${mode} is not frozen by the pilot manifest`
          );
        }
      }
    }
    if (pilot.releaseEvidencePath) {
      const evidencePath = path.join(root, pilot.releaseEvidencePath);
      if (!existsSync(evidencePath)) {
        errors.push(
          `${pilot.skillId}: release evidence is missing: ${pilot.releaseEvidencePath}`
        );
      }
    }
    if (scorecard) {
      validateSuiteSources({ root, suite, scorecard, errors });
    }
    if (suite.expertReview.status !== "expert_confirmed") {
      warnings.push(
        `${pilot.skillId}: Eval Suite is ${suite.expertReview.status}; it cannot support a formal grade`
      );
    }
    pilotReports.push({
      skillId: pilot.skillId,
      targetVersion: pilot.target.version,
      targetArtifactSha256: pilot.target.artifactSha256,
      suiteId: suite.suiteId,
      suiteFingerprint: suite.suiteFingerprint,
      caseCount: suite.cases.length,
      executionPlan: pilot.executionPlan,
      baselineModes: pilot.baselines.map(item => item.mode),
      expertReviewStatus: suite.expertReview.status,
    });
  }

  return {
    schema: "ea.skill-quality-phase-0-report.v1",
    status: errors.length ? "FAIL" : "PASS",
    phase: "phase_0",
    manifestFingerprint: calculatedManifestFingerprint,
    scorecardProfileFingerprint: scorecard?.profileFingerprint || null,
    judgeProfileFingerprint: judge?.judgeProfileFingerprint || null,
    judgeAvailability:
      judge?.status === "calibrated" ? "configured" : "unavailable",
    pilotCount: pilotReports.length,
    pilots: pilotReports,
    warnings,
    errors,
  };
}

export type { JudgeProfileV1, PilotManifest };
