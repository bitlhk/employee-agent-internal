import { existsSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import { getSystemConfig, upsertSystemConfig } from "../db";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "./secret-protection";

const EA_MODEL_CONFIG_KEY = "ea_assistant_model_config_v1";

type EaAssistantMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type EaAssistantModelConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
  provider: string;
  timeoutMs: number;
  disableThinking: boolean;
  tokenParam: "max_completion_tokens" | "max_tokens";
};

export type EaAssistantModelDraft = {
  apiBase: string;
  modelName: string;
  apiKey?: string;
  provider: string;
  timeoutMs: number;
  disableThinking: boolean;
};

export type EaAssistantCallOptions = {
  messages: EaAssistantMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
};

function stripQuotes(value: string) {
  return value.trim().replace(/^["']|["']$/g, "");
}

function expandHome(input: string) {
  if (!input.startsWith("~")) return input;
  return path.join(os.homedir(), input.slice(1));
}

function readEnvFile(filePath: string): Record<string, string> {
  const resolved = expandHome(filePath);
  if (!existsSync(resolved)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(resolved, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    env[key.trim()] = stripQuotes(rest.join("="));
  }
  return env;
}

function normalizeBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

function tokenParamFor(model: string): "max_completion_tokens" | "max_tokens" {
  return /^openpangu-/i.test(model) ? "max_tokens" : "max_completion_tokens";
}

export function getEaAssistantModelConfig(): EaAssistantModelConfig {
  const fallbackEnvPath =
    process.env.EA_ASSISTANT_MODEL_ENV_PATH
    || process.env.JIUWENCLAW_ENV_PATH
    || path.join(os.homedir(), ".jiuwenswarm/config/.env");
  const fallbackEnv = readEnvFile(fallbackEnvPath);
  const baseUrl =
    process.env.EA_ASSISTANT_MODEL_BASE_URL
    || fallbackEnv.EA_ASSISTANT_MODEL_BASE_URL
    || "https://api.modelarts-maas.com/openai/v1";
  const model =
    process.env.EA_ASSISTANT_MODEL_NAME
    || fallbackEnv.EA_ASSISTANT_MODEL_NAME
    || "openpangu-2.0-flash";
  const apiKey =
    process.env.EA_ASSISTANT_MODEL_API_KEY
    || process.env.HUAWEI_MAAS_API_KEY
    || fallbackEnv.EA_ASSISTANT_MODEL_API_KEY
    || fallbackEnv.HUAWEI_MAAS_API_KEY
    || fallbackEnv.API_KEY
    || "";
  const provider = process.env.EA_ASSISTANT_MODEL_PROVIDER || fallbackEnv.EA_ASSISTANT_MODEL_PROVIDER || "OpenAI";
  const timeoutMs = Number(process.env.EA_ASSISTANT_MODEL_TIMEOUT_MS || fallbackEnv.EA_ASSISTANT_MODEL_TIMEOUT_MS || 8000) || 8000;
  const disableThinking = String(
    process.env.EA_ASSISTANT_MODEL_DISABLE_THINKING
    || fallbackEnv.EA_ASSISTANT_MODEL_DISABLE_THINKING
    || "true",
  ).toLowerCase() !== "false";
  const configuredTokenParam = String(
    process.env.EA_ASSISTANT_MODEL_TOKEN_PARAM
    || fallbackEnv.EA_ASSISTANT_MODEL_TOKEN_PARAM
    || "",
  ).trim();
  const tokenParam =
    configuredTokenParam === "max_tokens" || configuredTokenParam === "max_completion_tokens"
      ? configuredTokenParam
      : /^openpangu-/i.test(model)
        ? "max_tokens"
        : "max_completion_tokens";

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    model,
    apiKey,
    provider,
    timeoutMs,
    disableThinking,
    tokenParam,
  };
}

function parseStoredEaModel(value: string): EaAssistantModelConfig | null {
  try {
    const plaintext = isEncryptedSecret(value) ? decryptSecret(value) : value;
    const parsed = JSON.parse(plaintext) as Partial<EaAssistantModelDraft>;
    const apiBase = String(parsed.apiBase || "").trim();
    const modelName = String(parsed.modelName || "").trim();
    const apiKey = String(parsed.apiKey || "");
    if (!apiBase || !modelName || !apiKey) return null;
    return {
      baseUrl: normalizeBaseUrl(apiBase),
      model: modelName,
      apiKey,
      provider: String(parsed.provider || "OpenAI").trim() || "OpenAI",
      timeoutMs: Math.max(1000, Number(parsed.timeoutMs || 8000) || 8000),
      disableThinking: parsed.disableThinking !== false,
      tokenParam: tokenParamFor(modelName),
    };
  } catch {
    return null;
  }
}

export async function resolveEaAssistantModelConfig(): Promise<EaAssistantModelConfig> {
  const fallback = getEaAssistantModelConfig();
  const stored = await getSystemConfig(EA_MODEL_CONFIG_KEY);
  return stored ? parseStoredEaModel(stored.value) || fallback : fallback;
}

export async function getEaAssistantModelAdminConfig() {
  const config = await resolveEaAssistantModelConfig();
  return {
    apiBase: config.baseUrl.replace(/\/chat\/completions\/?$/i, ""),
    modelName: config.model,
    provider: config.provider,
    timeoutMs: config.timeoutMs,
    disableThinking: config.disableThinking,
    apiKeyConfigured: Boolean(config.apiKey),
  };
}

async function mergeEaModelDraft(draft: EaAssistantModelDraft): Promise<EaAssistantModelConfig> {
  const existing = await resolveEaAssistantModelConfig();
  const apiKey = String(draft.apiKey || existing.apiKey || "");
  if (!apiKey) throw new Error("EA 平台模型缺少 API Key");
  return {
    baseUrl: normalizeBaseUrl(draft.apiBase),
    model: draft.modelName.trim(),
    apiKey,
    provider: draft.provider.trim() || "OpenAI",
    timeoutMs: draft.timeoutMs,
    disableThinking: draft.disableThinking,
    tokenParam: tokenParamFor(draft.modelName),
  };
}

export async function saveEaAssistantModelConfig(draft: EaAssistantModelDraft, updatedBy: number): Promise<void> {
  const config = await mergeEaModelDraft(draft);
  const stored: EaAssistantModelDraft = {
    apiBase: config.baseUrl.replace(/\/chat\/completions\/?$/i, ""),
    modelName: config.model,
    apiKey: config.apiKey,
    provider: config.provider,
    timeoutMs: config.timeoutMs,
    disableThinking: config.disableThinking,
  };
  await upsertSystemConfig({
    key: EA_MODEL_CONFIG_KEY,
    value: encryptSecret(JSON.stringify(stored), { maxStoredLength: null }),
    description: "EA 平台轻量模型配置（AES-GCM 加密）",
  }, updatedBy);
}

export async function validateEaAssistantModel(draft: EaAssistantModelDraft): Promise<number> {
  const config = await mergeEaModelDraft(draft);
  const result = await callEaAssistantModelWithConfig(config, {
    messages: [{ role: "user", content: "只回复 OK" }],
    maxTokens: 8,
    temperature: 0,
    timeoutMs: Math.min(config.timeoutMs, 60_000),
  });
  if (!result.content) throw new Error("EA 平台模型返回空响应");
  return result.elapsedMs;
}

export async function callEaAssistantModel(opts: EaAssistantCallOptions): Promise<{
  content: string;
  model: string;
  elapsedMs: number;
  usage?: unknown;
  raw?: unknown;
}> {
  const config = await resolveEaAssistantModelConfig();
  return callEaAssistantModelWithConfig(config, opts);
}

async function callEaAssistantModelWithConfig(config: EaAssistantModelConfig, opts: EaAssistantCallOptions): Promise<{
  content: string;
  model: string;
  elapsedMs: number;
  usage?: unknown;
  raw?: unknown;
}> {
  if (!config.apiKey) {
    throw new Error("[EA assistant model] API key is not configured");
  }

  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs || config.timeoutMs);
  try {
    const body: Record<string, unknown> = {
      model: config.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.1,
      stream: false,
    };
    body[config.tokenParam] = opts.maxTokens ?? 64;
    if (config.disableThinking) {
      body.chat_template_kwargs = { thinking: false };
    }

    const response = await fetch(config.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {}
    if (!response.ok) {
      throw new Error(`[EA assistant model] ${response.status}: ${text.slice(0, 300)}`);
    }
    const content = String(data?.choices?.[0]?.message?.content || "").trim();
    return {
      content,
      model: config.model,
      elapsedMs: Date.now() - started,
      usage: data?.usage,
      raw: data,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateEaSessionTitle(input: string): Promise<{
  title: string;
  elapsedMs: number;
  model: string;
  usage?: unknown;
}> {
  const result = await callEaAssistantModel({
    maxTokens: 48,
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: "你是企业智能体平台的会话标题生成器。只输出一个 6 到 18 个汉字的中文标题，不要解释，不要标点。",
      },
      { role: "user", content: input.slice(0, 2000) },
    ],
  });
  return {
    title: result.content.replace(/[。！？!?，,；;：:]+$/g, "").slice(0, 36) || "新对话",
    elapsedMs: result.elapsedMs,
    model: result.model,
    usage: result.usage,
  };
}
