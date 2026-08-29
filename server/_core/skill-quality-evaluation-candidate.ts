import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  skillEvalSuiteV1Schema,
  type SkillEvalSuiteV1,
} from "../../shared/skill-quality-evaluation";
import { sha256Schema, strictSemverSchema } from "../../shared/skill-market-v2";
import type { EaAssistantModelConfig } from "./ea-assistant-model";
import { governanceFingerprint } from "./governance/contracts";
import { loadSkillQualityPilotContracts } from "./skill-quality-evaluation-contracts";
import {
  runWealthSkillQualityPhase1,
  type SkillQualityPhase1CandidateComparison,
  type SkillQualityPhase1Report,
  type SkillQualityPhase1SourceArtifact,
} from "./skill-quality-evaluation-phase1";
import { skillEvalSuiteFingerprint } from "./skill-quality-evaluation";
import { digestSkillSourceTree } from "./skills/skill-artifact-digest";

export const WEALTH_SKILL_2_1_COMPARISON_PATHS = {
  "wealth-manager-assistant-2.1.0":
    "examples/skill-quality-evaluation-v1/candidate-comparisons/wealth-manager-assistant-2.1.0.v1.json",
  "wealth-manager-assistant-2.1.1":
    "examples/skill-quality-evaluation-v1/candidate-comparisons/wealth-manager-assistant-2.1.1.v1.json",
} as const;

export type WealthSkill21ComparisonName =
  keyof typeof WEALTH_SKILL_2_1_COMPARISON_PATHS;

const DEFAULT_WEALTH_SKILL_2_1_COMPARISON: WealthSkill21ComparisonName =
  "wealth-manager-assistant-2.1.0";

const safeRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .refine(value => !path.isAbsolute(value), "path must be repository-relative")
  .refine(
    value => !value.split(/[\\/]+/u).includes(".."),
    "path must stay inside the repository"
  );

const sourceArtifactSchema = z.strictObject({
  skillId: z.literal("wealth-manager-assistant"),
  skillVersionId: z.string().trim().min(1),
  version: strictSemverSchema,
  artifactSha256: sha256Schema,
  artifactSize: z.number().int().positive(),
  artifactRelativePath: safeRelativePathSchema,
  controlledReferencePathsByCase: z.record(
    z.string().trim().min(1),
    z.array(safeRelativePathSchema)
  ),
});

const candidateComparisonSchema = z.strictObject({
  schemaVersion: z.literal("ea.skill-quality-candidate-comparison.v1"),
  comparisonId: z.string().trim().min(1),
  comparisonFingerprint: sha256Schema,
  status: z.literal("ready"),
  baseSuitePath: safeRelativePathSchema,
  baseSuiteFingerprint: sha256Schema,
  derivedSuiteId: z.string().trim().min(1),
  derivedSuiteVersion: strictSemverSchema,
  domainReview: z.strictObject({
    reviewerId: z.string().trim().min(1),
    reviewerRole: z.string().trim().min(1),
    reviewedAt: z.string().datetime({ offset: true }),
    reviewComment: z.string().trim().min(1),
    groundTruthVersion: z.string().trim().min(1),
    evidencePath: safeRelativePathSchema,
    evidenceSha256: sha256Schema,
  }),
  target: sourceArtifactSchema,
  previousVersion: sourceArtifactSchema,
  repeatCount: z.number().int().positive(),
});

type CandidateComparisonConfig = z.infer<typeof candidateComparisonSchema>;

function fileSha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function comparisonFingerprint(config: CandidateComparisonConfig): string {
  return governanceFingerprint({
    ...config,
    comparisonFingerprint: undefined,
  });
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

function verifySourceArtifact(input: {
  root: string;
  artifact: z.infer<typeof sourceArtifactSchema>;
  caseIds: Set<string>;
}): SkillQualityPhase1SourceArtifact {
  const artifactPath = path.join(
    input.root,
    input.artifact.artifactRelativePath
  );
  const digest = digestSkillSourceTree(artifactPath);
  if (
    digest.sha256 !== input.artifact.artifactSha256 ||
    digest.size !== input.artifact.artifactSize
  ) {
    throw new Error(
      `${input.artifact.skillId}@${input.artifact.version}: repository source identity drifted`
    );
  }
  for (const [caseId, references] of Object.entries(
    input.artifact.controlledReferencePathsByCase
  )) {
    if (!input.caseIds.has(caseId)) {
      throw new Error(`Controlled reference map uses unknown case ${caseId}`);
    }
    for (const reference of references) {
      if (!existsSync(path.join(artifactPath, reference))) {
        throw new Error(
          `${input.artifact.skillId}@${input.artifact.version}: controlled reference is missing: ${reference}`
        );
      }
    }
  }
  for (const caseId of input.caseIds) {
    if (!(caseId in input.artifact.controlledReferencePathsByCase)) {
      throw new Error(
        `${input.artifact.skillId}@${input.artifact.version}: controlled reference decision is missing for ${caseId}`
      );
    }
  }
  return {
    skillId: input.artifact.skillId,
    skillVersionId: input.artifact.skillVersionId,
    version: input.artifact.version,
    artifactSha256: input.artifact.artifactSha256,
    artifactRelativePath: input.artifact.artifactRelativePath,
    controlledReferencePathsByCase:
      input.artifact.controlledReferencePathsByCase,
  };
}

function derivedSuite(input: {
  baseSuite: SkillEvalSuiteV1;
  config: CandidateComparisonConfig;
}): SkillEvalSuiteV1 {
  const reviewReference = {
    sourceType: "expert_ground_truth" as const,
    reference: input.config.domainReview.evidencePath,
    contentSha256: input.config.domainReview.evidenceSha256,
  };
  const candidate: SkillEvalSuiteV1 = {
    ...input.baseSuite,
    suiteId: input.config.derivedSuiteId,
    suiteVersion: input.config.derivedSuiteVersion,
    targetVersionId: input.config.target.skillVersionId,
    targetVersion: input.config.target.version,
    targetArtifactSha256: input.config.target.artifactSha256,
    sourceReferences: [
      ...input.baseSuite.sourceReferences.filter(
        source => source.reference !== reviewReference.reference
      ),
      reviewReference,
    ],
    expertReview: {
      status: "expert_confirmed",
      reviewerId: input.config.domainReview.reviewerId,
      reviewerRole: input.config.domainReview.reviewerRole,
      reviewedAt: input.config.domainReview.reviewedAt,
      reviewComment: input.config.domainReview.reviewComment,
      groundTruthVersion: input.config.domainReview.groundTruthVersion,
    },
    status: "frozen",
    suiteFingerprint: "0".repeat(64),
  };
  candidate.suiteFingerprint = skillEvalSuiteFingerprint(candidate);
  return skillEvalSuiteV1Schema.parse(candidate);
}

export function loadWealthSkill21CandidateComparison(
  root = process.cwd(),
  requestedComparison = String(
    process.env.EA_SKILL_EVAL_CANDIDATE_COMPARISON ||
      DEFAULT_WEALTH_SKILL_2_1_COMPARISON
  ).trim()
): SkillQualityPhase1CandidateComparison & { repeatCount: number } {
  if (!(requestedComparison in WEALTH_SKILL_2_1_COMPARISON_PATHS)) {
    throw new Error(
      `Unsupported Skill evaluation candidate comparison: ${requestedComparison}`
    );
  }
  const comparisonPath =
    WEALTH_SKILL_2_1_COMPARISON_PATHS[
      requestedComparison as WealthSkill21ComparisonName
    ];
  const config = candidateComparisonSchema.parse(
    readJson(path.join(root, comparisonPath))
  );
  const actualComparisonFingerprint = comparisonFingerprint(config);
  if (actualComparisonFingerprint !== config.comparisonFingerprint) {
    throw new Error(
      `Candidate comparison fingerprint mismatch: expected ${config.comparisonFingerprint}, received ${actualComparisonFingerprint}`
    );
  }
  const baseSuite = skillEvalSuiteV1Schema.parse(
    readJson(path.join(root, config.baseSuitePath))
  );
  if (
    baseSuite.suiteFingerprint !== config.baseSuiteFingerprint ||
    skillEvalSuiteFingerprint(baseSuite) !== config.baseSuiteFingerprint
  ) {
    throw new Error("Candidate comparison base Eval Suite fingerprint drifted");
  }
  const reviewPath = path.join(root, config.domainReview.evidencePath);
  if (fileSha256(reviewPath) !== config.domainReview.evidenceSha256) {
    throw new Error("Candidate domain review evidence fingerprint drifted");
  }
  const caseIds = new Set(baseSuite.cases.map(item => item.caseId));
  const target = verifySourceArtifact({
    root,
    artifact: config.target,
    caseIds,
  });
  const previousVersion = verifySourceArtifact({
    root,
    artifact: config.previousVersion,
    caseIds,
  });
  return {
    comparisonId: config.comparisonId,
    comparisonFingerprint: config.comparisonFingerprint,
    suite: derivedSuite({ baseSuite, config }),
    target,
    previousVersion,
    skillStoreRoot: root,
    repeatCount: config.repeatCount,
  };
}

export function buildWealthSkill21CandidateComparisonPlan(
  root = process.cwd()
): {
  schema: "ea.skill-quality-candidate-comparison-plan.v1";
  status: "READY";
  comparisonId: string;
  comparisonFingerprint: string;
  sourceIdentityMode: "candidate_repository";
  targetVersion: string;
  previousVersion: string;
  cases: number;
  arms: ["target_skill", "without_target_skill", "previous_version"];
  repeats: number;
  plannedRuns: number;
  nativeRuntimeIdentity: "UNVERIFIED";
} {
  const comparison = loadWealthSkill21CandidateComparison(root);
  return {
    schema: "ea.skill-quality-candidate-comparison-plan.v1",
    status: "READY",
    comparisonId: comparison.comparisonId,
    comparisonFingerprint: comparison.comparisonFingerprint,
    sourceIdentityMode: "candidate_repository",
    targetVersion: comparison.target.version,
    previousVersion: comparison.previousVersion.version,
    cases: comparison.suite.cases.length,
    arms: ["target_skill", "without_target_skill", "previous_version"],
    repeats: comparison.repeatCount,
    plannedRuns: comparison.suite.cases.length * 3 * comparison.repeatCount,
    nativeRuntimeIdentity: "UNVERIFIED",
  };
}

export async function runWealthSkill21CandidateComparison(
  input: {
    root?: string;
    outputRoot?: string;
    modelConfig?: EaAssistantModelConfig;
    onProgress?: (completed: number, total: number) => void;
  } = {}
): Promise<{ report: SkillQualityPhase1Report; outputRoot: string }> {
  const root = input.root || process.cwd();
  const comparison = loadWealthSkill21CandidateComparison(root);
  const contracts = loadSkillQualityPilotContracts({
    root,
    skillId: "wealth-manager-assistant",
  });
  const requiredRepeats = Math.max(
    contracts.scorecard.repeatPolicy.minimumRuns,
    ...comparison.suite.cases.map(item => item.minimumRuns)
  );
  if (comparison.repeatCount !== requiredRepeats) {
    throw new Error(
      `Candidate comparison repeat count must equal the frozen requirement ${requiredRepeats}`
    );
  }
  return runWealthSkillQualityPhase1({
    root,
    outputRoot: input.outputRoot,
    modelConfig: input.modelConfig,
    onProgress: input.onProgress,
    candidateComparison: comparison,
  });
}
