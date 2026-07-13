import { WebSocket, type RawData } from "ws";

const DEFAULT_GATEWAY_WS_URL = "ws://127.0.0.1:19000/ws";
const DEFAULT_TIMEOUT_MS = 60_000;

export const JIUWEN_MODEL_PROVIDERS = [
  "OpenAI",
  "DeepSeek",
  "DashScope",
  "SiliconFlow",
  "InferenceAffinity",
  "OpenRouter",
  "Anthropic",
  "intelli_router",
] as const;

export const JIUWEN_REASONING_LEVELS = ["", "off", "low", "medium", "high"] as const;

export type JiuwenModelDraft = {
  modelName: string;
  alias: string;
  apiBase: string;
  apiKey?: string;
  provider: string;
  reasoningLevel: string;
  temperature: number;
  isDefault: boolean;
  originIndex?: number;
};

export type JiuwenModelSecret = JiuwenModelDraft & {
  apiKey: string;
  timeout: number;
  verifySsl: boolean;
  contextWindowTokens: number;
};

export type PublicJiuwenModel = Omit<JiuwenModelSecret, "apiKey" | "timeout" | "verifySsl"> & {
  id: string;
  apiKeyConfigured: boolean;
  isPrimary: boolean;
  contextWindowTokens: number;
};

type GatewayModelEntry = {
  model_name?: unknown;
  alias?: unknown;
  api_base?: unknown;
  api_key?: unknown;
  model_provider?: unknown;
  reasoning_level?: unknown;
  temperature?: unknown;
  is_default?: unknown;
  origin_index?: unknown;
  context_window_tokens?: unknown;
  timeout?: unknown;
  verify_ssl?: unknown;
};

function parseFrame(raw: RawData): any | null {
  try {
    if (Array.isArray(raw)) return JSON.parse(Buffer.concat(raw).toString("utf8"));
    if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString("utf8"));
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

export async function callJiuwenGatewayAdmin<T>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const wsUrl = String(process.env.JIUWENCLAW_GATEWAY_WS_URL || DEFAULT_GATEWAY_WS_URL).trim();
  if (!/^wss?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(wsUrl)) {
    throw new Error("JiuwenSwarm admin RPC must use a loopback WebSocket URL");
  }
  const requestId = `ea-model-admin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

  return await new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    const finish = (error?: Error, payload?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(1000, "complete"); } catch {}
      if (error) reject(error);
      else resolve(payload as T);
    };
    const timer = setTimeout(() => finish(new Error(`JiuwenSwarm ${method} timed out`)), Math.max(1000, timeoutMs));
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "req", id: requestId, method, params }));
    });
    ws.on("message", (raw) => {
      const frame = parseFrame(raw);
      if (!frame || frame.type !== "res" || frame.id !== requestId) return;
      if (frame.ok === false) {
        finish(new Error(String(frame.error || frame.code || `${method} failed`)));
        return;
      }
      finish(undefined, (frame.payload || {}) as T);
    });
    ws.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    ws.on("close", () => {
      if (!settled) finish(new Error(`JiuwenSwarm ${method} connection closed before response`));
    });
  });
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

export function sanitizeModelAdminError(error: unknown): string {
  return String(error instanceof Error ? error.message : error || "模型操作失败")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, "[REDACTED]")
    .slice(0, 500);
}

function number(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function modelIdentity(model: Pick<JiuwenModelDraft, "alias" | "modelName">): string {
  return text(model.alias) || text(model.modelName);
}

function normalizeSecretModel(entry: GatewayModelEntry, index: number): JiuwenModelSecret {
  return {
    modelName: text(entry.model_name),
    alias: text(entry.alias),
    apiBase: text(entry.api_base),
    apiKey: String(entry.api_key ?? ""),
    provider: text(entry.model_provider),
    reasoningLevel: text(entry.reasoning_level),
    temperature: number(entry.temperature, 0.95),
    isDefault: entry.is_default !== false,
    originIndex: Number.isInteger(entry.origin_index) ? Number(entry.origin_index) : index,
    timeout: number(entry.timeout, 1800),
    verifySsl: entry.verify_ssl === true,
    contextWindowTokens: number(entry.context_window_tokens, 0),
  };
}

export async function listJiuwenModelsWithSecrets(): Promise<JiuwenModelSecret[]> {
  const payload = await callJiuwenGatewayAdmin<{ models?: GatewayModelEntry[] }>("models.list");
  const entries = Array.isArray(payload.models) ? payload.models : [];
  return entries.map(normalizeSecretModel);
}

export function toPublicJiuwenModels(models: JiuwenModelSecret[]): PublicJiuwenModel[] {
  return models.map((model, index) => ({
    id: modelIdentity(model),
    modelName: model.modelName,
    alias: model.alias,
    apiBase: model.apiBase,
    provider: model.provider,
    reasoningLevel: model.reasoningLevel,
    temperature: model.temperature,
    isDefault: model.isDefault,
    originIndex: model.originIndex,
    apiKeyConfigured: Boolean(model.apiKey),
    isPrimary: index === 0,
    contextWindowTokens: model.contextWindowTokens,
  }));
}

function assertUniqueModelIds(models: Array<Pick<JiuwenModelDraft, "alias" | "modelName">>): void {
  const seen = new Set<string>();
  for (const model of models) {
    const id = modelIdentity(model);
    if (!id) throw new Error("Model name is required");
    if (seen.has(id)) throw new Error(`Model alias or name must be unique: ${id}`);
    seen.add(id);
  }
}

export function mergeJiuwenModelDrafts(
  drafts: JiuwenModelDraft[],
  existing: JiuwenModelSecret[],
): JiuwenModelSecret[] {
  if (drafts.length === 0) throw new Error("At least one Agent model is required");
  assertUniqueModelIds(drafts);
  return drafts.map((draft, index) => {
    const origin = Number.isInteger(draft.originIndex)
      ? existing.find((item) => item.originIndex === draft.originIndex)
      : undefined;
    const apiKey = String(draft.apiKey || origin?.apiKey || "");
    if (!apiKey) throw new Error(`API key is required for ${modelIdentity(draft) || `model ${index + 1}`}`);
    return {
      ...draft,
      apiKey,
      timeout: origin?.timeout || 1800,
      verifySsl: origin?.verifySsl ?? false,
      contextWindowTokens: origin?.contextWindowTokens || 0,
    };
  });
}

function toGatewayModel(model: JiuwenModelSecret) {
  return {
    model_name: model.modelName,
    alias: model.alias,
    api_base: model.apiBase,
    api_key: model.apiKey,
    model_provider: model.provider,
    reasoning_level: model.reasoningLevel,
    temperature: model.temperature,
    is_default: model.isDefault,
    origin_index: model.originIndex,
    timeout: model.timeout,
    verify_ssl: model.verifySsl,
  };
}

export async function replaceJiuwenModels(drafts: JiuwenModelDraft[]): Promise<JiuwenModelSecret[]> {
  const existing = await listJiuwenModelsWithSecrets();
  const merged = mergeJiuwenModelDrafts(drafts, existing);
  await callJiuwenGatewayAdmin("models.replace_all", { models: merged.map(toGatewayModel) });
  return merged;
}

export async function validateJiuwenModel(draft: JiuwenModelDraft): Promise<void> {
  const existing = await listJiuwenModelsWithSecrets();
  const [model] = mergeJiuwenModelDrafts([draft], existing);
  await callJiuwenGatewayAdmin("models.validate", {
    api_base: model.apiBase,
    api_key: model.apiKey,
    model: model.modelName,
    model_provider: model.provider,
    ...(model.reasoningLevel ? { reasoning_level: model.reasoningLevel } : {}),
  });
}

export async function findJiuwenModelById(id: string): Promise<JiuwenModelSecret | null> {
  const selected = text(id);
  if (!selected) return null;
  const models = await listJiuwenModelsWithSecrets();
  return models.find((model) => modelIdentity(model) === selected) || null;
}
