import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import semver from "semver";
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
import { digestSkillSourceTree } from "./skills/skill-artifact-digest";

export const SKILL_QUALITY_EVALUATION_ROOT =
  "examples/skill-quality-evaluation-v1";
export const SKILL_QUALITY_PILOT_MANIFEST_PATH = `${SKILL_QUALITY_EVALUATION_ROOT}/pilot-baselines.v1.json`;

const nullableVersionRefSchema = z.strictObject({
  mode: skillEvaluationBaselineModeSchema,
  skillVersionId: z.string().min(1).nullable(),
  version: strictSemverSchema.nullable(),
  artifactSha256: sha256Schema.nullable(),
});

export const pilotManifestSchema = z
  .strictObject({
    schemaVersion: z.literal("ea.skill-quality-evaluation-pilots.v1"),
    manifestVersion: strictSemverSchema,
    manifestFingerprint: sha256Schema,
    status: z.literal("phase_0_frozen"),
    scorecardProfilePath: z.string().min(1),
    judgeProfilePath: z.string().min(1),
    approvedSkillInventoryPath: z.string().min(1),
    runtimeIsolation: z.strictObject({
      dedicatedEvalAdoption: z.literal(true),
      cleanSessionPerArm: z.literal(true),
      cleanWorkspacePerArm: z.literal(true),
      noSideEffectMode: z.literal(true),
      productionInstallMutationAllowed: z.literal(false),
    }),
    pilots: z
      .array(
        z.strictObject({
          skillId: z.string().min(1),
          skillIdentityId: z.string().min(1),
          suitePath: z.string().min(1),
          target: z.strictObject({
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
      const baselineModes = new Set<string>();
      for (const baseline of pilot.baselines) {
        if (baselineModes.has(baseline.mode)) {
          context.addIssue({
            code: "custom",
            path: ["pilots"],
            message: `${pilot.skillId}: baseline mode ${baseline.mode} is duplicated`,
          });
        }
        baselineModes.add(baseline.mode);
        const requiresVersion = baseline.mode !== "without_target_skill";
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
        if (!requiresVersion || !hasCompleteVersion) continue;
        const reusesTarget =
          baseline.skillVersionId === pilot.target.skillVersionId ||
          baseline.artifactSha256 === pilot.target.artifactSha256;
        if (reusesTarget) {
          context.addIssue({
            code: "custom",
            path: ["pilots"],
            message: `${pilot.skillId}: ${baseline.mode} must not reuse the target version identity or artifact`,
          });
        }
        if (
          baseline.mode === "previous_version" &&
          !semver.lt(baseline.version!, pilot.target.version)
        ) {
          context.addIssue({
            code: "custom",
            path: ["pilots"],
            message: `${pilot.skillId}: previous_version must be lower than target ${pilot.target.version}`,
          });
        }
      }
    }
  });

type PilotManifest = z.infer<typeof pilotManifestSchema>;

const approvedSkillInventorySchema = z
  .strictObject({
    schemaVersion: z.literal("ea.approved-skill-inventory.v1"),
    snapshotId: z.string().min(1),
    capturedAt: z.string().datetime({ offset: true }),
    source: z.literal("local_skill_market_v2_readonly_snapshot"),
    inventoryFingerprint: sha256Schema,
    records: z
      .array(
        z.strictObject({
          skillId: z.string().min(1),
          skillIdentityId: z.string().min(1),
          skillVersionId: z.string().min(1),
          version: strictSemverSchema,
          artifactSha256: sha256Schema,
          artifactSize: z.number().int().nonnegative(),
          artifactRelativePath: z.string().min(1),
          status: z.literal("approved"),
        })
      )
      .min(1),
  })
  .superRefine((inventory, context) => {
    const versions = new Set<string>();
    for (const [index, record] of inventory.records.entries()) {
      if (versions.has(record.skillVersionId)) {
        context.addIssue({
          code: "custom",
          path: ["records", index, "skillVersionId"],
          message: `duplicate approved Skill version ${record.skillVersionId}`,
        });
      }
      versions.add(record.skillVersionId);
      if (
        path.isAbsolute(record.artifactRelativePath) ||
        record.artifactRelativePath.split(/[\\/]+/u).includes("..")
      ) {
        context.addIssue({
          code: "custom",
          path: ["records", index, "artifactRelativePath"],
          message: "approved Skill artifact path must stay inside SKILL_STORE",
        });
      }
      const expectedPath = path.join(
        "marketplace",
        "artifacts",
        record.skillId,
        record.version,
        record.artifactSha256
      );
      if (path.normalize(record.artifactRelativePath) !== expectedPath) {
        context.addIssue({
          code: "custom",
          path: ["records", index, "artifactRelativePath"],
          message:
            "approved Skill artifact path must match its Skill, version and digest",
        });
      }
    }
  });
type ApprovedSkillInventory = z.infer<typeof approvedSkillInventorySchema>;

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

export function approvedSkillInventoryFingerprint(
  inventory: ApprovedSkillInventory
): string {
  const { inventoryFingerprint: _stored, ...body } = inventory;
  return governanceFingerprint(body);
}

export function resolveSkillStoreRoot(): string {
  const configured = process.env.SKILL_STORE?.trim();
  if (!configured) return path.join(homedir(), "skill-store");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) {
    return path.join(homedir(), configured.slice(2));
  }
  return path.resolve(configured);
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
  approvedInventory: ApprovedSkillInventory | null;
  errors: string[];
}): void {
  const metricIds = new Set(
    input.scorecard.metrics.map(metric => metric.metricId)
  );
  const hardGates = new Map(
    input.scorecard.hardGates.map(hardGate => [hardGate.hardGateId, hardGate])
  );
  const requiredHardGates = new Set(input.suite.requiredHardGateIds);
  const assertionCoverage = new Map<string, Set<string>>();
  for (const source of input.suite.sourceReferences) {
    if (source.sourceType === "approved_skill_artifact") {
      const match = /^skill-store:\/\/([^/]+)\/([^/]+)\/([a-f0-9]{64})$/u.exec(
        source.reference
      );
      if (!match) {
        input.errors.push(
          `${input.suite.suiteId}: approved Skill source reference is malformed`
        );
        continue;
      }
      const [, skillId, version, artifactSha256] = match;
      const inventoryMatch = input.approvedInventory?.records.find(
        record =>
          record.skillId === skillId &&
          record.version === version &&
          record.artifactSha256 === artifactSha256
      );
      if (
        !inventoryMatch ||
        source.contentSha256 !== inventoryMatch.artifactSha256
      ) {
        input.errors.push(
          `${input.suite.suiteId}: approved Skill source is absent from the frozen inventory`
        );
      }
      continue;
    }
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
      if (!assertion.hardGateId) continue;
      const hardGate = hardGates.get(assertion.hardGateId);
      if (!hardGate) {
        input.errors.push(
          `${item.caseId}: assertion references unknown hard gate ${assertion.hardGateId}`
        );
        continue;
      }
      if (!requiredHardGates.has(assertion.hardGateId)) {
        input.errors.push(
          `${item.caseId}: assertion covers undeclared suite hard gate ${assertion.hardGateId}`
        );
      }
      if (hardGate.executionSource !== "assertion") {
        input.errors.push(
          `${item.caseId}: runner hard gate ${assertion.hardGateId} cannot be satisfied by a case assertion`
        );
      }
      const coveredCases =
        assertionCoverage.get(assertion.hardGateId) || new Set();
      coveredCases.add(item.caseId);
      assertionCoverage.set(assertion.hardGateId, coveredCases);
    }
  }
  for (const hardGateId of input.suite.requiredHardGateIds) {
    const hardGate = hardGates.get(hardGateId);
    if (!hardGate) {
      input.errors.push(
        `${input.suite.suiteId}: required hard gate ${hardGateId} is absent from the Scorecard Profile`
      );
      continue;
    }
    if (hardGate.executionSource === "runner") continue;
    const coveredCases = assertionCoverage.get(hardGateId) || new Set();
    const hasRequiredCoverage =
      hardGate.coverageRequirement ===
      "at_least_one_assertion_per_declaring_suite"
        ? coveredCases.size >= 1
        : hardGate.coverageRequirement === "every_case_in_declaring_suite"
          ? coveredCases.size === input.suite.cases.length
          : false;
    if (!hasRequiredCoverage) {
      input.errors.push(
        `${input.suite.suiteId}: hard gate ${hardGateId} does not satisfy ${hardGate.coverageRequirement}`
      );
    }
  }
}

function validatePilotInventory(input: {
  pilot: PilotManifest["pilots"][number];
  inventory: ApprovedSkillInventory;
  errors: string[];
}): void {
  const expectedVersions = [
    input.pilot.target,
    ...input.pilot.baselines.flatMap(baseline =>
      baseline.mode === "without_target_skill"
        ? []
        : [
            {
              skillVersionId: baseline.skillVersionId!,
              version: baseline.version!,
              artifactSha256: baseline.artifactSha256!,
            },
          ]
    ),
  ];
  for (const expected of expectedVersions) {
    const record = input.inventory.records.find(
      item => item.skillVersionId === expected.skillVersionId
    );
    if (
      !record ||
      record.skillId !== input.pilot.skillId ||
      record.skillIdentityId !== input.pilot.skillIdentityId ||
      record.version !== expected.version ||
      record.artifactSha256 !== expected.artifactSha256
    ) {
      input.errors.push(
        `${input.pilot.skillId}@${expected.version}: version identity is not independently confirmed by the approved Skill inventory`
      );
    }
  }
}

function verifyLocalInventoryArtifacts(input: {
  inventory: ApprovedSkillInventory;
  skillStoreRoot: string;
  requireLocalArtifacts: boolean;
  warnings: string[];
  errors: string[];
}): number {
  let verified = 0;
  for (const record of input.inventory.records) {
    const artifactPath = path.join(
      input.skillStoreRoot,
      record.artifactRelativePath
    );
    if (!existsSync(artifactPath)) {
      const message = `${record.skillId}@${record.version}: local approved artifact is unavailable at ${record.artifactRelativePath}`;
      if (input.requireLocalArtifacts) input.errors.push(message);
      else input.warnings.push(message);
      continue;
    }
    try {
      const digest = digestSkillSourceTree(artifactPath);
      if (
        digest.sha256 !== record.artifactSha256 ||
        digest.size !== record.artifactSize
      ) {
        input.errors.push(
          `${record.skillId}@${record.version}: local artifact differs from the approved Skill inventory`
        );
        continue;
      }
      verified += 1;
    } catch (error) {
      input.errors.push(
        `${record.skillId}@${record.version}: local artifact cannot be verified: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return verified;
}

export type SkillQualityPhase0Report = {
  schema: "ea.skill-quality-phase-0-report.v1";
  status: "PASS" | "FAIL";
  phase: "phase_0";
  manifestFingerprint: string | null;
  approvedSkillInventoryFingerprint: string | null;
  inventoryRecordCount: number;
  locallyVerifiedArtifactCount: number;
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
  root = process.cwd(),
  options: {
    requireLocalArtifacts?: boolean;
    skillStoreRoot?: string;
  } = {}
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
      approvedSkillInventoryFingerprint: null,
      inventoryRecordCount: 0,
      locallyVerifiedArtifactCount: 0,
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
  const repositoryPaths = [
    manifest.scorecardProfilePath,
    manifest.judgeProfilePath,
    manifest.approvedSkillInventoryPath,
    ...manifest.pilots.flatMap(pilot => [
      pilot.suitePath,
      ...(pilot.releaseEvidencePath ? [pilot.releaseEvidencePath] : []),
    ]),
  ];
  const unsafePaths = repositoryPaths.filter(
    repositoryPath => !isSafeRepositoryPath(repositoryPath)
  );
  if (unsafePaths.length > 0) {
    errors.push(
      ...unsafePaths.map(
        repositoryPath =>
          `Skill quality asset path escapes the repository: ${repositoryPath}`
      )
    );
    return {
      schema: "ea.skill-quality-phase-0-report.v1",
      status: "FAIL",
      phase: "phase_0",
      manifestFingerprint: calculatedManifestFingerprint,
      approvedSkillInventoryFingerprint: null,
      inventoryRecordCount: 0,
      locallyVerifiedArtifactCount: 0,
      scorecardProfileFingerprint: null,
      judgeProfileFingerprint: null,
      judgeAvailability: "unavailable",
      pilotCount: 0,
      pilots: [],
      warnings,
      errors,
    };
  }
  const approvedInventory = loadContract({
    root,
    relativePath: manifest.approvedSkillInventoryPath,
    schema: approvedSkillInventorySchema,
    label: "Approved Skill Inventory",
    errors,
  });
  let calculatedInventoryFingerprint: string | null = null;
  let locallyVerifiedArtifactCount = 0;
  if (approvedInventory) {
    calculatedInventoryFingerprint =
      approvedSkillInventoryFingerprint(approvedInventory);
    if (
      approvedInventory.inventoryFingerprint !== calculatedInventoryFingerprint
    ) {
      errors.push("Approved Skill Inventory fingerprint is inconsistent");
    }
    locallyVerifiedArtifactCount = verifyLocalInventoryArtifacts({
      inventory: approvedInventory,
      skillStoreRoot: options.skillStoreRoot || resolveSkillStoreRoot(),
      requireLocalArtifacts: options.requireLocalArtifacts === true,
      warnings,
      errors,
    });
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
    if (approvedInventory) {
      validatePilotInventory({ pilot, inventory: approvedInventory, errors });
    }
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
      validateSuiteSources({
        root,
        suite,
        scorecard,
        approvedInventory,
        errors,
      });
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
    approvedSkillInventoryFingerprint: calculatedInventoryFingerprint,
    inventoryRecordCount: approvedInventory?.records.length || 0,
    locallyVerifiedArtifactCount,
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

export type { ApprovedSkillInventory, JudgeProfileV1, PilotManifest };

export function loadSkillQualityPilotContracts(input: {
  root?: string;
  skillId: string;
  skillStoreRoot?: string;
}): {
  manifest: PilotManifest;
  pilot: PilotManifest["pilots"][number];
  suite: SkillEvalSuiteV1;
  scorecard: SkillScorecardProfileV1;
  judge: JudgeProfileV1;
  inventory: ApprovedSkillInventory;
  skillStoreRoot: string;
} {
  const root = input.root || process.cwd();
  const skillStoreRoot = input.skillStoreRoot || resolveSkillStoreRoot();
  const phase0 = runSkillQualityPhase0ContractChecks(root, {
    requireLocalArtifacts: true,
    skillStoreRoot,
  });
  if (phase0.status !== "PASS") {
    throw new Error(`Phase 0 strict gate failed:\n${phase0.errors.join("\n")}`);
  }
  const manifest = pilotManifestSchema.parse(
    readJson(path.join(root, SKILL_QUALITY_PILOT_MANIFEST_PATH))
  );
  const pilot = manifest.pilots.find(item => item.skillId === input.skillId);
  if (!pilot)
    throw new Error(`Skill quality pilot is not frozen: ${input.skillId}`);
  const suite = skillEvalSuiteV1Schema.parse(
    readJson(path.join(root, pilot.suitePath))
  );
  const scorecard = skillScorecardProfileV1Schema.parse(
    readJson(path.join(root, manifest.scorecardProfilePath))
  );
  const judge = judgeProfileV1Schema.parse(
    readJson(path.join(root, manifest.judgeProfilePath))
  );
  const inventory = approvedSkillInventorySchema.parse(
    readJson(path.join(root, manifest.approvedSkillInventoryPath))
  );
  return {
    manifest,
    pilot,
    suite,
    scorecard,
    judge,
    inventory,
    skillStoreRoot,
  };
}
