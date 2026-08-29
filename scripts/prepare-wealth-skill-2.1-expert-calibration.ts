import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { governanceFingerprint } from "../server/_core/governance/contracts";
import { loadWealthSkill21CandidateComparison } from "../server/_core/skill-quality-evaluation-candidate";
import { loadSkillQualityPilotContracts } from "../server/_core/skill-quality-evaluation-contracts";

const baselinePath = path.resolve(
  "examples/skill-quality-evaluation-v1/wealth-manager-assistant-2.1-candidate-baseline.v1.json"
);
const calibrationVersion =
  process.env.EA_SKILL_EVAL_CALIBRATION_VERSION || "v2";
const calibrationRepeat = Number(
  process.env.EA_SKILL_EVAL_CALIBRATION_REPEAT || "1"
);
const outputRoot = path.resolve(
  `reports/skill-quality-expert-calibration/wealth-manager-assistant-2.1-${calibrationVersion}`
);

type ExecutionArm =
  | "target_skill"
  | "without_target_skill"
  | "previous_version";

interface PairPlan {
  pairId: string;
  caseId: "WM-SKILL-EVAL-001" | "WM-SKILL-EVAL-006";
  armA: ExecutionArm;
  armB: ExecutionArm;
}

const pairPlans: PairPlan[] = [
  {
    pairId: "CAL-001",
    caseId: "WM-SKILL-EVAL-001",
    armA: "target_skill",
    armB: "without_target_skill",
  },
  {
    pairId: "CAL-002",
    caseId: "WM-SKILL-EVAL-001",
    armA: "previous_version",
    armB: "target_skill",
  },
  {
    pairId: "CAL-003",
    caseId: "WM-SKILL-EVAL-006",
    armA: "without_target_skill",
    armB: "target_skill",
  },
  {
    pairId: "CAL-004",
    caseId: "WM-SKILL-EVAL-006",
    armA: "target_skill",
    armB: "previous_version",
  },
];

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function representativeOutput(input: {
  reportRoot: string;
  caseId: string;
  arm: ExecutionArm;
  repeat: number;
}): { runId: string; output: string; outputSha256: string } {
  const prefix = `${input.arm}-${input.caseId}-${input.repeat}-`;
  const runIds = readdirSync(path.join(input.reportRoot, "runs"))
    .filter(name => name.startsWith(prefix))
    .sort();
  if (runIds.length !== 1) {
    throw new Error(
      `${prefix}: expected one representative run, received ${runIds.length}`
    );
  }
  const trace = readJson(
    path.join(input.reportRoot, "runs", runIds[0], "trace.json")
  );
  const modelExecution = trace.modelExecution as
    | Record<string, unknown>
    | undefined;
  const initialOutput = modelExecution?.initialOutput;
  if (!initialOutput) throw new Error(`${runIds[0]} has no model output`);
  const output = JSON.stringify(initialOutput, null, 2);
  return { runId: runIds[0], output, outputSha256: sha256(output) };
}

function main(): void {
  if (
    !Number.isInteger(calibrationRepeat) ||
    calibrationRepeat < 1 ||
    calibrationRepeat > 3
  ) {
    throw new Error(
      "EA_SKILL_EVAL_CALIBRATION_REPEAT must be an integer between 1 and 3"
    );
  }
  const baseline = readJson(baselinePath);
  const qualityGates = baseline.qualityGates as Record<string, unknown>;
  const controlled = qualityGates.controlledComparison as Record<
    string,
    unknown
  >;
  const evaluationId = String(controlled.evaluationId || "");
  const reportRoot = path.resolve("reports/skill-quality-evaluation", evaluationId);
  const sourceReportPath = path.join(reportRoot, "report.json");
  if (!existsSync(sourceReportPath)) {
    throw new Error(`Controlled comparison report is missing: ${sourceReportPath}`);
  }
  const sourceReport = readJson(sourceReportPath);
  if (sourceReport.reportFingerprint !== controlled.reportFingerprint) {
    throw new Error("Controlled comparison report fingerprint drifted");
  }

  const comparison = loadWealthSkill21CandidateComparison();
  const contracts = loadSkillQualityPilotContracts({
    skillId: "wealth-manager-assistant",
  });
  const cases = new Map(comparison.suite.cases.map(item => [item.caseId, item]));
  const pairs = pairPlans.map(plan => {
    const testCase = cases.get(plan.caseId);
    if (!testCase) throw new Error(`Calibration case is missing: ${plan.caseId}`);
    const answerA = representativeOutput({
      reportRoot,
      caseId: plan.caseId,
      arm: plan.armA,
      repeat: calibrationRepeat,
    });
    const answerB = representativeOutput({
      reportRoot,
      caseId: plan.caseId,
      arm: plan.armB,
      repeat: calibrationRepeat,
    });
    return {
      ...plan,
      taskPrompt: testCase.prompt,
      expectedOutput: testCase.expectedOutput,
      answerA,
      answerB,
    };
  });

  const reviewerRoot = path.join(outputRoot, "reviewer");
  const custodianRoot = path.join(outputRoot, "custodian");
  const completedLabelsPath = path.join(
    reviewerRoot,
    "feedback/labels.completed.json"
  );
  const anonymousPacketBody = {
    schema: "ea.skill-quality-expert-calibration-packet.v1",
    datasetId: `wealth-manager-assistant-2.1-expert-calibration-${calibrationVersion}`,
    status: "READY_FOR_BLIND_REVIEW",
    sourceEvaluationId: evaluationId,
    sourceReportFingerprint: sourceReport.reportFingerprint,
    comparisonFingerprint: comparison.comparisonFingerprint,
    judgeProfileFingerprint: contracts.judge.judgeProfileFingerprint,
    representativeRepeat: calibrationRepeat,
    rubric: contracts.judge.rubric,
    pairs: pairs.map(pair => ({
      pairId: pair.pairId,
      caseId: pair.caseId,
      taskPrompt: pair.taskPrompt,
      expectedOutput: pair.expectedOutput,
      answerASha256: pair.answerA.outputSha256,
      answerBSha256: pair.answerB.outputSha256,
    })),
  };
  const packetFingerprint = governanceFingerprint(anonymousPacketBody);
  if (existsSync(completedLabelsPath)) {
    const completedLabels = readJson(completedLabelsPath);
    if (completedLabels.packetFingerprint !== packetFingerprint) {
      throw new Error(
        "Completed calibration labels belong to a different packet; archive them before regenerating"
      );
    }
  }
  mkdirSync(reviewerRoot, { recursive: true });
  mkdirSync(custodianRoot, { recursive: true });
  const manifest = {
    ...anonymousPacketBody,
    packetFingerprint,
    reviewRules: {
      reviewerMustNotOpen: "custodian/sealed-key.json",
      winnerValues: ["A", "B", "TIE"],
      scoreScale: [0, 1, 2, 3, 4],
      requiredReviewerRole: "财富管理业务专家",
      resultSemantics: "pilot_judge_calibration",
    },
  };

  const labelsTemplate = {
    schema: "ea.skill-quality-expert-calibration-labels.v1",
    datasetId: manifest.datasetId,
    packetFingerprint,
    reviewer: {
      reviewerId: null,
      reviewerRole: "财富管理业务专家",
      reviewedAt: null,
    },
    labels: pairs.map(pair => ({
      pairId: pair.pairId,
      winner: null,
      criteria: contracts.judge.rubric.map(criterion => ({
        criterionId: criterion.criterionId,
        aScore: null,
        bScore: null,
        evidenceComment: null,
      })),
      rationale: null,
    })),
  };

  const sealedKeyBody = {
    schema: "ea.skill-quality-expert-calibration-key.v1",
    datasetId: manifest.datasetId,
    packetFingerprint,
    handling: "CUSTODIAN_ONLY_DO_NOT_SHARE_WITH_REVIEWER",
    pairs: pairs.map(pair => ({
      pairId: pair.pairId,
      caseId: pair.caseId,
      answerA: {
        executionArm: pair.armA,
        runId: pair.answerA.runId,
        outputSha256: pair.answerA.outputSha256,
      },
      answerB: {
        executionArm: pair.armB,
        runId: pair.answerB.runId,
        outputSha256: pair.answerB.outputSha256,
      },
    })),
  };
  const sealedKey = {
    ...sealedKeyBody,
    sealedKeyFingerprint: governanceFingerprint(sealedKeyBody),
  };

  const reviewMarkdown = [
    "# 财富经理 Skill 2.1 专家盲评校准包",
    "",
    `- 数据集：\`${manifest.datasetId}\``,
    `- 校准包指纹：\`${packetFingerprint}\``,
    "- 专家角色：财富管理业务专家",
    "- 样本数：4 组匿名 A/B",
    "",
    "## 评审规则",
    "",
    "1. 不要打开 `../custodian/sealed-key.json`，也不要猜测版本来源。",
    "2. 每组只比较专业判断、业务完整性、表达质量和可执行性；平台硬门禁另行验证。",
    "3. 不因篇幅更长自动判优。选择 `A`、`B` 或 `TIE`。",
    "4. 四个维度分别给 A/B 打 0-4 分，并写一条能够指向具体内容的理由。",
    "5. 完成后填写 `labels.template.json`，另存为 `labels.completed.json`。",
    "",
    "## 评分维度",
    "",
    ...contracts.judge.rubric.map(
      item =>
        `- \`${item.criterionId}\`（${item.weight}%）：${item.description}`
    ),
    "",
    ...pairs.flatMap(pair => [
      `## ${pair.pairId}`,
      "",
      `**任务：** ${pair.taskPrompt}`,
      "",
      `**预期业务结果：** ${pair.expectedOutput}`,
      "",
      "### 回答 A",
      "",
      "```json",
      pair.answerA.output,
      "```",
      "",
      "### 回答 B",
      "",
      "```json",
      pair.answerB.output,
      "```",
      "",
      "---",
      "",
    ]),
  ].join("\n");

  writeFileSync(
    path.join(outputRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  writeFileSync(path.join(reviewerRoot, "expert-review.md"), reviewMarkdown);
  writeFileSync(
    path.join(reviewerRoot, "labels.template.json"),
    `${JSON.stringify(labelsTemplate, null, 2)}\n`
  );
  const sealedKeyPath = path.join(custodianRoot, "sealed-key.json");
  writeFileSync(sealedKeyPath, `${JSON.stringify(sealedKey, null, 2)}\n`);
  chmodSync(sealedKeyPath, 0o600);

  process.stdout.write(
    `${JSON.stringify(
      {
        status: manifest.status,
        packetFingerprint,
        expertReviewPath: path.join(reviewerRoot, "expert-review.md"),
        labelsTemplatePath: path.join(reviewerRoot, "labels.template.json"),
        sealedKeyPath,
      },
      null,
      2
    )}\n`
  );
}

main();
