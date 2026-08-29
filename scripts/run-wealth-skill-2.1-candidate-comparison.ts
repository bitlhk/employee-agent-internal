import "dotenv/config";
import type { EaAssistantModelConfig } from "../server/_core/ea-assistant-model";
import { listJiuwenModelsWithSecrets } from "../server/_core/jiuwenswarm-model-admin";
import {
  buildWealthSkill21CandidateComparisonPlan,
  runWealthSkill21CandidateComparison,
} from "../server/_core/skill-quality-evaluation-candidate";

const planOnly = process.argv.includes("--plan");

function requestedModelName(): string {
  const argument = process.argv.find(value => value.startsWith("--model="));
  return (
    argument?.slice("--model=".length).trim() ||
    process.env.EA_SKILL_EVAL_MODEL_NAME?.trim() ||
    "doubao-seed-2.1-pro"
  );
}

async function evaluationModelConfig(): Promise<EaAssistantModelConfig> {
  const modelName = requestedModelName();
  const model = (await listJiuwenModelsWithSecrets()).find(
    item => item.modelName === modelName
  );
  if (!model?.apiKey) {
    throw new Error(`评测模型未配置或缺少凭据：${modelName}`);
  }
  const apiBase = model.apiBase.replace(/\/$/u, "");
  if (!apiBase.includes("volceapi.com")) {
    throw new Error(`${modelName} 评测必须使用已登记的火山模型网关`);
  }
  return {
    baseUrl: apiBase.endsWith("/chat/completions")
      ? apiBase
      : `${apiBase}/chat/completions`,
    model: model.modelName,
    apiKey: model.apiKey,
    provider: apiBase.includes("volceapi.com")
      ? "Volcengine/OpenAI-compatible"
      : model.provider || "OpenAI",
    timeoutMs: 60_000,
    disableThinking: true,
    tokenParam: "max_tokens",
    thinkingControl: apiBase.includes("volceapi.com")
      ? "thinking"
      : "chat_template_kwargs",
    structuredOutputMode: apiBase.includes("volceapi.com")
      ? "json_schema"
      : "none",
  };
}

async function main(): Promise<void> {
  if (planOnly) {
    process.stdout.write(
      `${JSON.stringify(buildWealthSkill21CandidateComparisonPlan(), null, 2)}\n`
    );
    return;
  }
  let lastCompleted = 0;
  const modelConfig = await evaluationModelConfig();
  const result = await runWealthSkill21CandidateComparison({
    modelConfig,
    onProgress: (completed, total) => {
      if (completed === lastCompleted) return;
      lastCompleted = completed;
      process.stderr.write(
        `\rWealth Skill 2.1 comparison: ${completed}/${total}`
      );
    },
  });
  if (lastCompleted) process.stderr.write("\n");
  process.stdout.write(
    `${JSON.stringify({ ...result.report, outputRoot: result.outputRoot }, null, 2)}\n`
  );
  if (
    result.report.status !== "DIAGNOSTIC_COMPLETE" ||
    result.report.targetHardGateStatus === "FAIL"
  ) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
