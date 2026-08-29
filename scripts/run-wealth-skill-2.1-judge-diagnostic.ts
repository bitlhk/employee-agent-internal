import "dotenv/config";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { governanceFingerprint } from "../server/_core/governance/contracts";
import { loadWealthSkill21CandidateComparison } from "../server/_core/skill-quality-evaluation-candidate";
import { loadSkillQualityPilotContracts } from "../server/_core/skill-quality-evaluation-contracts";

const execFileAsync = promisify(execFile);
const baselinePath = path.resolve(
  "examples/skill-quality-evaluation-v1/wealth-manager-assistant-2.1-candidate-baseline.v1.json"
);
const judgeCases = ["WM-SKILL-EVAL-001", "WM-SKILL-EVAL-006"] as const;
const baselineArms = ["without_target_skill", "previous_version"] as const;

const judgeResultSchema = z.strictObject({
  winner: z.enum(["A", "B", "TIE"]),
  confidence: z.number().min(0).max(100),
  criteria: z.array(
    z.strictObject({
      criterionId: z.string().min(1),
      aScore: z.number().min(0).max(4),
      bScore: z.number().min(0).max(4),
      reason: z.string().min(1),
    })
  ),
  rationale: z.string().min(1),
});

type ExecutionArm = "target_skill" | (typeof baselineArms)[number];

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function parsedJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Judge returned no JSON object");
  return JSON.parse(raw.slice(start, end + 1)) as unknown;
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
    throw new Error(`${prefix}: expected one representative run, received ${runIds.length}`);
  }
  const trace = readJson(
    path.join(input.reportRoot, "runs", runIds[0], "trace.json")
  );
  const modelExecution = trace.modelExecution as Record<string, unknown> | undefined;
  const initialOutput = modelExecution?.initialOutput;
  if (!initialOutput) throw new Error(`${runIds[0]} has no parsed model output`);
  const output = JSON.stringify(initialOutput, null, 2);
  return { runId: runIds[0], output, outputSha256: sha256(output) };
}

function promptFor(input: {
  taskPrompt: string;
  expectedOutput: string;
  rubric: Array<{ criterionId: string; description: string; weight: number }>;
  outputA: string;
  outputB: string;
}): string {
  return [
    "你是财富管理岗位 Skill 的盲评专家。禁止调用任何工具或外部资料。",
    "只比较两份回答的专业判断、业务完整性、表达质量和可执行性；合规硬门禁已由 EA 单独验证。",
    "formalRecommendation、approvalCards 等输出状态字段已经通过机器契约校验，不要在专业盲评中重新判定其合规含义；除非它与本题预期业务结果直接冲突。",
    "不要因为产品代码、风险等级、期限或到账字段列得更多就自动判优；应判断这些信息是否改变方案质量，以及回答是否清楚解释方案取舍并帮助客户作出选择。",
    "适当性、eligibleProducts范围、来源完整性和关键产品事实已经通过机器硬门禁；专业盲评不因答案再次复述这些契约而额外加分。",
    "不得猜测回答来自哪个版本，也不得因为篇幅更长自动判优。",
    "",
    `任务：${input.taskPrompt}`,
    `预期业务结果：${input.expectedOutput}`,
    "",
    "评分维度（每项 0-4 分）：",
    ...input.rubric.map(
      item => `- ${item.criterionId}（权重 ${item.weight}）：${item.description}`
    ),
    "",
    "回答 A：",
    input.outputA,
    "",
    "回答 B：",
    input.outputB,
    "",
    "仅输出一个 JSON 对象，不要 Markdown，不要附加文字：",
    JSON.stringify({
      winner: "A|B|TIE",
      confidence: 0,
      criteria: input.rubric.map(item => ({
        criterionId: item.criterionId,
        aScore: 0,
        bScore: 0,
        reason: "简短、具体、引用回答内容的判断",
      })),
      rationale: "总判断",
    }),
  ].join("\n");
}

async function main(): Promise<void> {
  const planOnly = process.argv.includes("--plan");
  const repeatArg = process.argv.find(argument => argument.startsWith("--repeat="));
  const representativeRepeat = repeatArg
    ? Number(repeatArg.slice("--repeat=".length))
    : 1;
  if (!Number.isInteger(representativeRepeat) || representativeRepeat < 1 || representativeRepeat > 3) {
    throw new Error("--repeat must be an integer between 1 and 3");
  }
  const baseline = readJson(baselinePath);
  const controlled = (
    (baseline.qualityGates as Record<string, unknown>).controlledComparison as Record<
      string,
      unknown
    >
  );
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
  const rubric = contracts.judge.rubric;
  const plan = {
    schema: "ea.skill-quality-judge-diagnostic-plan.v1",
    status: "READY",
    sourceEvaluationId: evaluationId,
    sourceReportFingerprint: sourceReport.reportFingerprint,
    comparisonFingerprint: comparison.comparisonFingerprint,
    judgeProfileFingerprint: contracts.judge.judgeProfileFingerprint,
    judgeCalibrationStatus: contracts.judge.expertCalibration.status,
    judgeCases,
    baselineArms,
    representativeRepeat,
    votesPerPair: 2,
    reverseOrder: true,
    plannedVotes: judgeCases.length * baselineArms.length * 2,
    formalScoreAvailable: false,
  };
  if (planOnly) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  const outputRoot = path.resolve(
    "reports/skill-quality-evaluation-judge",
    new Date().toISOString().replace(/[-:.]/gu, "")
  );
  mkdirSync(outputRoot, { recursive: true });
  const hermesBin = path.resolve(
    process.env.HERMES_BIN ||
      path.join(os.homedir(), ".hermes/hermes-agent/venv/bin/hermes")
  );
  const judgeModel = String(
    process.env.EA_SKILL_EVAL_JUDGE_MODEL || "gpt-5.6-luna"
  );
  const votes = [];
  let completed = 0;

  for (const caseId of judgeCases) {
    const testCase = cases.get(caseId);
    if (!testCase) throw new Error(`Judge case is missing: ${caseId}`);
    const target = representativeOutput({
      reportRoot,
      caseId,
      arm: "target_skill",
      repeat: representativeRepeat,
    });
    for (const baselineArm of baselineArms) {
      const baselineOutput = representativeOutput({
        reportRoot,
        caseId,
        arm: baselineArm,
        repeat: representativeRepeat,
      });
      for (let voteIndex = 0; voteIndex < 2; voteIndex += 1) {
        const targetIsA = voteIndex === 0;
        const outputA = targetIsA ? target.output : baselineOutput.output;
        const outputB = targetIsA ? baselineOutput.output : target.output;
        const prompt = promptFor({
          taskPrompt: testCase.prompt,
          expectedOutput: testCase.expectedOutput,
          rubric,
          outputA,
          outputB,
        });
        const expectedCriterionIds = rubric.map(item => item.criterionId).sort();
        let parsed: z.infer<typeof judgeResultSchema> | null = null;
        let acceptedRawOutput = "";
        let acceptedUsagePath = "";
        let validationError: unknown = null;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const stem = `${caseId}-${baselineArm}-vote-${voteIndex + 1}-attempt-${attempt}`;
          const usagePath = path.join(outputRoot, `${stem}-usage.json`);
          const result = await execFileAsync(
            hermesBin,
            [
              "-z",
              attempt === 1
                ? prompt
                : `${prompt}\n\n上一次输出未通过机器校验。criteria 必须且只能逐项使用这些 criterionId：${expectedCriterionIds.join(", ")}。请重新输出完整 JSON。`,
              "-m",
              judgeModel,
              "--usage-file",
              usagePath,
              "--ignore-rules",
              "-t",
              "",
              "--in",
              os.tmpdir(),
            ],
            { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }
          );
          writeFileSync(path.join(outputRoot, `${stem}-raw.txt`), result.stdout);
          try {
            const candidate = judgeResultSchema.parse(
              parsedJsonObject(result.stdout)
            );
            const actualCriterionIds = candidate.criteria
              .map(item => item.criterionId)
              .sort();
            if (
              JSON.stringify(actualCriterionIds) !==
              JSON.stringify(expectedCriterionIds)
            ) {
              throw new Error("Judge criterion coverage drifted");
            }
            parsed = candidate;
            acceptedRawOutput = result.stdout;
            acceptedUsagePath = usagePath;
            break;
          } catch (error) {
            validationError = error;
          }
        }
        if (!parsed) {
          throw new Error(
            `${caseId}/${baselineArm}: Judge output remained invalid after one retry: ${validationError instanceof Error ? validationError.message : String(validationError)}`
          );
        }
        const mappedWinner =
          parsed.winner === "TIE"
            ? "tie"
            : (parsed.winner === "A") === targetIsA
              ? "target_skill"
              : baselineArm;
        completed += 1;
        process.stderr.write(`\rWealth Skill 2.1 Judge: ${completed}/${plan.plannedVotes}`);
        votes.push({
          caseId,
          baselineArm,
          voteIndex: voteIndex + 1,
          order: targetIsA
            ? ["target_skill", baselineArm]
            : [baselineArm, "target_skill"],
          sourceRunIds: {
            target: target.runId,
            baseline: baselineOutput.runId,
          },
          inputFingerprint: governanceFingerprint({
            caseId,
            baselineArm,
            voteIndex,
            taskPrompt: testCase.prompt,
            expectedOutput: testCase.expectedOutput,
            rubric,
            outputASha256: sha256(outputA),
            outputBSha256: sha256(outputB),
          }),
          judgeModel,
          rawOutputSha256: sha256(acceptedRawOutput),
          mappedWinner,
          result: parsed,
          usage: existsSync(acceptedUsagePath)
            ? readJson(acceptedUsagePath)
            : null,
        });
      }
    }
  }
  process.stderr.write("\n");

  const pairs = judgeCases.flatMap(caseId =>
    baselineArms.map(baselineArm => {
      const pairVotes = votes.filter(
        vote => vote.caseId === caseId && vote.baselineArm === baselineArm
      );
      const winners = pairVotes.map(vote => vote.mappedWinner);
      return {
        caseId,
        baselineArm,
        winners,
        verdict: winners.every(winner => winner === "target_skill")
          ? "target_preferred"
          : winners.every(winner => winner === baselineArm)
            ? "baseline_preferred"
            : winners.every(winner => winner === "tie")
              ? "tie"
              : "disagreement",
      };
    })
  );
  const body = {
    schema: "ea.skill-quality-judge-diagnostic.v1",
    generatedAt: new Date().toISOString(),
    status: "DIAGNOSTIC_COMPLETE",
    resultSemantics: "uncalibrated_non_certifying",
    sourceEvaluationId: evaluationId,
    sourceReportFingerprint: sourceReport.reportFingerprint,
    comparisonFingerprint: comparison.comparisonFingerprint,
    judgeProfileFingerprint: contracts.judge.judgeProfileFingerprint,
    judgeModel,
    judgeCalibrationStatus: contracts.judge.expertCalibration.status,
    sampledRepeat: representativeRepeat,
    votes,
    pairs,
    summary: {
      targetPreferred: pairs.filter(pair => pair.verdict === "target_preferred").length,
      baselinePreferred: pairs.filter(pair => pair.verdict === "baseline_preferred").length,
      ties: pairs.filter(pair => pair.verdict === "tie").length,
      disagreements: pairs.filter(pair => pair.verdict === "disagreement").length,
    },
    formalScore: null,
    formalGrade: null,
    warnings: [
      "Judge has not been calibrated against an independent human expert set",
      "Only representative repeat 1 is sampled; this is not a formal aggregate score",
      "Deterministic hard gates and native Runtime identity are evaluated separately",
    ],
  };
  const report = { ...body, reportFingerprint: governanceFingerprint(body) };
  writeFileSync(
    path.join(outputRoot, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`
  );
  process.stdout.write(
    `${JSON.stringify({
      status: report.status,
      summary: report.summary,
      outputRoot,
      reportFingerprint: report.reportFingerprint,
    }, null, 2)}\n`
  );
}

main().catch(error => {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
