import {
  listJiuwenModelsWithSecrets,
  replaceJiuwenModels,
  type JiuwenModelDraft,
  type JiuwenModelSecret,
} from "../server/_core/jiuwenswarm-model-admin";

const VOLCENGINE_HOST = "apigateway-cn-beijing.volceapi.com";
const CORE_MODEL_NAMES = [
  "glm-5.2",
  "deepseek-v4-flash",
  "openpangu-2.0-flash",
];

const VOLCENGINE_MODELS = [
  { modelName: "deepseek-v4-pro", alias: "DeepSeek-V4-Pro", originIndex: 100 },
  { modelName: "MiniMax-M3", alias: "MiniMax M3", originIndex: 101 },
  {
    modelName: "doubao-seed-2.1-pro",
    alias: "Doubao Seed 2.1 Pro",
    originIndex: 102,
  },
  { modelName: "hy3", alias: "HY3", originIndex: 103 },
] as const;

function requireModel(
  models: Map<string, JiuwenModelSecret>,
  modelName: string
): JiuwenModelSecret {
  const model = models.get(modelName);
  if (!model) throw new Error(`Existing model missing: ${modelName}`);
  return model;
}

function volcengineModel(
  base: JiuwenModelSecret,
  existing: JiuwenModelSecret | undefined,
  target: (typeof VOLCENGINE_MODELS)[number]
): JiuwenModelDraft {
  return {
    modelName: target.modelName,
    alias: target.alias,
    apiBase: base.apiBase,
    apiKey: base.apiKey,
    provider: "OpenAI",
    reasoningLevel: "off",
    temperature: 0.1,
    isDefault: true,
    originIndex: existing?.originIndex ?? target.originIndex,
  };
}

async function main() {
  const existing = await listJiuwenModelsWithSecrets();
  const byName = new Map(existing.map(model => [model.modelName, model]));
  const base = requireModel(byName, "deepseek-v4-flash");
  if (!base.apiKey || !base.apiBase.includes(VOLCENGINE_HOST)) {
    throw new Error(
      "Configured DeepSeek V4 Flash is not using the expected Volcengine gateway"
    );
  }

  const additions = VOLCENGINE_MODELS.map(target =>
    volcengineModel(base, byName.get(target.modelName), target)
  );
  const leadingNames = new Set([
    ...CORE_MODEL_NAMES,
    ...VOLCENGINE_MODELS.map(model => model.modelName),
  ]);
  const ordered: JiuwenModelDraft[] = [
    requireModel(byName, "glm-5.2"),
    requireModel(byName, "deepseek-v4-flash"),
    ...additions,
    requireModel(byName, "openpangu-2.0-flash"),
    ...existing.filter(model => !leadingNames.has(model.modelName)),
  ];

  await replaceJiuwenModels(ordered);
  process.stdout.write(
    `${ordered.map(model => model.alias || model.modelName).join("\n")}\n`
  );
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
