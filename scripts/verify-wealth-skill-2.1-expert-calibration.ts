import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { governanceFingerprint } from "../server/_core/governance/contracts";

const calibrationVersion =
  process.env.EA_SKILL_EVAL_CALIBRATION_VERSION || "v2";
const calibrationRoot = path.resolve(
  `reports/skill-quality-expert-calibration/wealth-manager-assistant-2.1-${calibrationVersion}`
);
const labelsPath = path.join(
  calibrationRoot,
  "reviewer/feedback/labels.completed.json"
);
const manifestPath = path.join(calibrationRoot, "manifest.json");
const sealedKeyPath = path.join(calibrationRoot, "custodian/sealed-key.json");
const baselinePath = path.resolve(
  "examples/skill-quality-evaluation-v1/wealth-manager-assistant-2.1-candidate-baseline.v1.json"
);

const scoreSchema = z.number().int().min(0).max(4);
const labelsSchema = z.strictObject({
  schema: z.literal("ea.skill-quality-expert-calibration-labels.v1"),
  datasetId: z.string().min(1),
  packetFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  reviewer: z.strictObject({
    reviewerId: z.string().min(1),
    reviewerRole: z.string().min(1),
    reviewedAt: z.string().datetime({ offset: true }),
  }),
  labels: z.array(
    z.strictObject({
      pairId: z.string().min(1),
      winner: z.enum(["A", "B", "TIE"]),
      criteria: z.array(
        z.strictObject({
          criterionId: z.string().min(1),
          aScore: scoreSchema,
          bScore: scoreSchema,
          evidenceComment: z.string().min(1),
        })
      ),
      rationale: z.string().min(1),
    })
  ),
});

type AnonymousWinner = "A" | "B" | "TIE";
type ExecutionArm =
  | "target_skill"
  | "without_target_skill"
  | "previous_version";

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function findJudgeReport(reportFingerprint: string): Record<string, unknown> {
  const root = path.resolve("reports/skill-quality-evaluation-judge");
  const candidates = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(root, entry.name, "report.json"))
    .filter(existsSync);
  const reportPath = candidates.find(candidate => {
    const report = readJson(candidate);
    return report.reportFingerprint === reportFingerprint;
  });
  if (!reportPath) {
    throw new Error(`Judge report not found: ${reportFingerprint}`);
  }
  const report = readJson(reportPath);
  const { reportFingerprint: observed, ...body } = report;
  if (governanceFingerprint(body) !== observed) {
    throw new Error("Judge report fingerprint drifted");
  }
  return { ...report, reportPath };
}

function mappedWinner(input: {
  winner: AnonymousWinner;
  answerAArm: ExecutionArm;
  answerBArm: ExecutionArm;
}): ExecutionArm | "tie" {
  if (input.winner === "TIE") return "tie";
  return input.winner === "A" ? input.answerAArm : input.answerBArm;
}

function main(): void {
  const labels = labelsSchema.parse(readJson(labelsPath));
  const manifest = readJson(manifestPath);
  const sealedKey = readJson(sealedKeyPath);
  const baseline = readJson(baselinePath);

  const {
    packetFingerprint: observedPacketFingerprint,
    reviewRules: _reviewRules,
    ...anonymousPacketBody
  } = manifest;
  if (governanceFingerprint(anonymousPacketBody) !== observedPacketFingerprint) {
    throw new Error("Calibration packet fingerprint drifted");
  }
  const {
    sealedKeyFingerprint: observedSealedKeyFingerprint,
    ...sealedKeyBody
  } = sealedKey;
  if (governanceFingerprint(sealedKeyBody) !== observedSealedKeyFingerprint) {
    throw new Error("Calibration sealed key fingerprint drifted");
  }
  if (
    labels.packetFingerprint !== observedPacketFingerprint ||
    sealedKey.packetFingerprint !== observedPacketFingerprint ||
    labels.datasetId !== manifest.datasetId ||
    sealedKey.datasetId !== manifest.datasetId
  ) {
    throw new Error("Calibration dataset identity mismatch");
  }

  const rubric = manifest.rubric as Array<{
    criterionId: string;
    description: string;
    weight: number;
  }>;
  const rubricIds = rubric.map(item => item.criterionId).sort();
  const manifestPairs = manifest.pairs as Array<{
    pairId: string;
    caseId: string;
    answerASha256: string;
    answerBSha256: string;
  }>;
  const keyPairs = sealedKey.pairs as Array<{
    pairId: string;
    caseId: string;
    answerA: {
      executionArm: ExecutionArm;
      runId: string;
      outputSha256: string;
    };
    answerB: {
      executionArm: ExecutionArm;
      runId: string;
      outputSha256: string;
    };
  }>;
  if (
    new Set(labels.labels.map(item => item.pairId)).size !== labels.labels.length ||
    labels.labels.length !== manifestPairs.length
  ) {
    throw new Error("Calibration labels must cover each pair exactly once");
  }

  const professionalBlindReview = (
    (baseline.qualityGates as Record<string, unknown>)
      .professionalBlindReview as Record<string, unknown>
  );
  const holdoutCalibration = professionalBlindReview.holdoutCalibration as
    | Record<string, unknown>
    | undefined;
  const diagnosticReportFingerprint =
    calibrationVersion === "v3"
      ? String(holdoutCalibration?.judgeDiagnosticReportFingerprint || "")
      : String(professionalBlindReview.diagnosticReportFingerprint || "");
  const judgeReport = findJudgeReport(
    diagnosticReportFingerprint
  );
  const judgeVotes = judgeReport.votes as Array<{
    caseId: string;
    baselineArm: ExecutionArm;
    order: [ExecutionArm, ExecutionArm];
    mappedWinner: ExecutionArm | "tie";
    result: {
      criteria: Array<{
        criterionId: string;
        aScore: number;
        bScore: number;
      }>;
    };
  }>;

  let winnerAgreementCount = 0;
  const scoreDeltas: number[] = [];
  const scoreCalibrationFlags: Array<Record<string, unknown>> = [];
  const pairResults = labels.labels.map(label => {
    const manifestPair = manifestPairs.find(item => item.pairId === label.pairId);
    const keyPair = keyPairs.find(item => item.pairId === label.pairId);
    if (!manifestPair || !keyPair || manifestPair.caseId !== keyPair.caseId) {
      throw new Error(`${label.pairId}: calibration pair identity mismatch`);
    }
    if (
      manifestPair.answerASha256 !== keyPair.answerA.outputSha256 ||
      manifestPair.answerBSha256 !== keyPair.answerB.outputSha256
    ) {
      throw new Error(`${label.pairId}: anonymous output fingerprint mismatch`);
    }
    const actualCriterionIds = label.criteria
      .map(item => item.criterionId)
      .sort();
    if (JSON.stringify(actualCriterionIds) !== JSON.stringify(rubricIds)) {
      throw new Error(`${label.pairId}: rubric coverage mismatch`);
    }
    const baselineArm = [
      keyPair.answerA.executionArm,
      keyPair.answerB.executionArm,
    ].find(arm => arm !== "target_skill");
    if (!baselineArm) throw new Error(`${label.pairId}: baseline arm is missing`);
    const votes = judgeVotes.filter(
      vote =>
        vote.caseId === keyPair.caseId && vote.baselineArm === baselineArm
    );
    if (votes.length !== 2) {
      throw new Error(`${label.pairId}: expected two reverse-order Judge votes`);
    }
    const humanMappedWinner = mappedWinner({
      winner: label.winner,
      answerAArm: keyPair.answerA.executionArm,
      answerBArm: keyPair.answerB.executionArm,
    });
    const winnerAgreement = votes.every(
      vote => vote.mappedWinner === humanMappedWinner
    );
    if (winnerAgreement) winnerAgreementCount += 1;

    const criterionResults = label.criteria.map(humanCriterion => {
      const judgeScores = votes.map(vote => {
        const score = vote.result.criteria.find(
          item => item.criterionId === humanCriterion.criterionId
        );
        if (!score) {
          throw new Error(
            `${label.pairId}: Judge criterion missing: ${humanCriterion.criterionId}`
          );
        }
        const directOrder = vote.order[0] === keyPair.answerA.executionArm;
        return {
          aScore: directOrder ? score.aScore : score.bScore,
          bScore: directOrder ? score.bScore : score.aScore,
        };
      });
      const judgeAverageA =
        judgeScores.reduce((total, item) => total + item.aScore, 0) /
        judgeScores.length;
      const judgeAverageB =
        judgeScores.reduce((total, item) => total + item.bScore, 0) /
        judgeScores.length;
      const deltaA = Math.abs(humanCriterion.aScore - judgeAverageA);
      const deltaB = Math.abs(humanCriterion.bScore - judgeAverageB);
      scoreDeltas.push(deltaA, deltaB);
      for (const [answer, humanScore, judgeScore, delta] of [
        ["A", humanCriterion.aScore, judgeAverageA, deltaA],
        ["B", humanCriterion.bScore, judgeAverageB, deltaB],
      ] as const) {
        if (delta > 1) {
          scoreCalibrationFlags.push({
            pairId: label.pairId,
            criterionId: humanCriterion.criterionId,
            answer,
            humanScore,
            judgeScore,
            absoluteDelta: delta,
            expertEvidence: humanCriterion.evidenceComment,
          });
        }
      }
      return {
        criterionId: humanCriterion.criterionId,
        human: {
          aScore: humanCriterion.aScore,
          bScore: humanCriterion.bScore,
        },
        judgeAverage: { aScore: judgeAverageA, bScore: judgeAverageB },
        absoluteDelta: { aScore: deltaA, bScore: deltaB },
      };
    });

    return {
      pairId: label.pairId,
      caseId: keyPair.caseId,
      humanAnonymousWinner: label.winner,
      humanMappedWinner,
      judgeMappedWinners: votes.map(vote => vote.mappedWinner),
      winnerAgreement,
      criterionResults,
    };
  });

  const winnerAgreementRate = winnerAgreementCount / pairResults.length;
  const scoreMeanAbsoluteError =
    scoreDeltas.reduce((total, delta) => total + delta, 0) /
    scoreDeltas.length;
  const maxScoreAbsoluteDelta = Math.max(...scoreDeltas);
  const expertTargetPreferenceCount = pairResults.filter(
    result => result.humanMappedWinner === "target_skill"
  ).length;
  const body = {
    schema: "ea.skill-quality-expert-calibration-result.v1",
    generatedAt: labels.reviewer.reviewedAt,
    status: "AI_EXPERT_CALIBRATION_COMPLETE",
    resultSemantics: "ai_expert_non_certifying",
    datasetId: labels.datasetId,
    packetFingerprint: labels.packetFingerprint,
    sealedKeyFingerprint: observedSealedKeyFingerprint,
    labelsSha256: sha256File(labelsPath),
    reviewer: labels.reviewer,
    judge: {
      model: judgeReport.judgeModel,
      profileFingerprint: judgeReport.judgeProfileFingerprint,
      diagnosticReportFingerprint: judgeReport.reportFingerprint,
    },
    pairResults,
    summary: {
      pairCount: pairResults.length,
      winnerAgreementCount,
      winnerAgreementRate,
      reverseOrderJudgeDisagreementCount: pairResults.filter(result =>
        result.judgeMappedWinners.some(
          winner => winner !== result.judgeMappedWinners[0]
        )
      ).length,
      scoreMeanAbsoluteError,
      maxScoreAbsoluteDelta,
      scoreCalibrationFlags,
    },
    decision: {
      aiExpertBlindPreference: {
        targetPreferredCount: expertTargetPreferenceCount,
        pairCount: pairResults.length,
        status:
          expertTargetPreferenceCount === pairResults.length
            ? "TARGET_PREFERRED_ALL_PAIRS"
            : "MIXED",
      },
      judgeDirectionCalibrationAgainstAiExpert:
        winnerAgreementRate >= 0.75 ? "PASS" : "FAIL",
      independentHumanExpertCalibration: "PENDING",
      judgeCalibrationStatus: "pending",
      formalScoreAvailable: false,
      formalGradeAvailable: false,
      allowedUse: "diagnostic_and_pilot_tuning_only",
    },
    warnings: [
      "Reviewer is an AI wealth-management expert, not an independent human expert",
      "Direction agreement does not remove criterion-level calibration differences",
      "Reverse-order disagreement or criterion drift must be resolved before Judge calibration",
    ],
  };
  const result = {
    ...body,
    calibrationResultFingerprint: governanceFingerprint(body),
  };
  const resultPath = path.join(calibrationRoot, "calibration-result.json");
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify(
      {
        status: result.status,
        resultSemantics: result.resultSemantics,
        summary: result.summary,
        decision: result.decision,
        calibrationResultFingerprint: result.calibrationResultFingerprint,
        resultPath,
      },
      null,
      2
    )}\n`
  );
}

main();
