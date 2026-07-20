import { randomBytes, randomUUID } from "crypto";

import { readSafeAgentResponseText, safeAgentRequest } from "./safe-agent-http";

export type A2ARequestProfile = {
  idVersion?: 4 | 7;
  textTemplate?: string;
  messageKind?: string;
  includeContextId?: boolean;
  includeTaskId?: boolean;
  messageFields?: Record<string, unknown>;
  dataPart?: Record<string, unknown>;
  dataPartMetadata?: Record<string, unknown>;
  paramsMetadata?: Record<string, unknown>;
};

export type A2AResultProfile = {
  artifactNames?: string[];
};

export type A2ARetryProfile = {
  method?: string;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export type A2AEndpointConfig = {
  path?: string;
  rpcPath?: string;
  stream?: boolean;
  method?: string;
  timeoutMs?: number;
  taskPrefix?: string;
  taskSuffix?: string;
  requestProfile?: A2ARequestProfile;
  resultProfile?: A2AResultProfile;
  retryProfile?: A2ARetryProfile;
  [key: string]: unknown;
};

export type A2AAgentConnection = {
  apiUrl: string;
  apiToken?: string | null;
  endpointConfig: A2AEndpointConfig;
};

export type A2ATaskResult = {
  text: string;
  remoteTaskId?: string;
  rawEvents: unknown[];
};

const MAX_STATIC_PROFILE_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const FORBIDDEN_PROFILE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function endpoint(baseUrl: string, pathValue?: string) {
  if (!pathValue) return baseUrl;
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const relative = String(pathValue || "").replace(/^\//, "");
  return new URL(relative, base).toString();
}

function authHeaders(token?: string | null) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function assertSafeProfileValue(value: unknown, label: string): void {
  const visit = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (FORBIDDEN_PROFILE_KEYS.has(key)) throw new Error(`${label} contains a forbidden key`);
      visit(child);
    }
  };
  visit(value);
  const serialized = JSON.stringify(value ?? null);
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATIC_PROFILE_BYTES) {
    throw new Error(`${label} exceeds ${MAX_STATIC_PROFILE_BYTES} bytes`);
  }
}

function uuidV7(): string {
  const bytes = randomBytes(16);
  const timestamp = Date.now();
  bytes[0] = Math.floor(timestamp / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function profileId(config: A2AEndpointConfig): string {
  return config.requestProfile?.idVersion === 7 ? uuidV7() : randomUUID();
}

function safeRecord(value: unknown, label: string, createId: () => string): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  assertSafeProfileValue(value, label);
  const materialize = (item: unknown): unknown => {
    if (typeof item === "string") return item.split("{{uuid}}").join(createId());
    if (Array.isArray(item)) return item.map(materialize);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).map(([key, child]) => [key, materialize(child)]),
    );
  };
  return materialize(value) as Record<string, unknown>;
}

function renderTaskText(input: string, config: A2AEndpointConfig): string {
  const prefix = String(config.taskPrefix || "").trim();
  const suffix = String(config.taskSuffix || "").trim();
  const base = [prefix, input, suffix].filter(Boolean).join("\n\n");
  const template = String(config.requestProfile?.textTemplate || "");
  if (!template) return base;
  if (!template.includes("{{prompt}}")) throw new Error("requestProfile.textTemplate must contain {{prompt}}");
  return template.split("{{prompt}}").join(base);
}

export function buildA2ATaskRequest(input: string, config: A2AEndpointConfig) {
  const profile = config.requestProfile || {};
  const createId = () => profileId(config);
  const messageId = createId();
  const contextId = profile.includeContextId ? createId() : undefined;
  const taskId = profile.includeTaskId ? createId() : undefined;
  const messageFields = safeRecord(profile.messageFields, "requestProfile.messageFields", createId) || {};
  const dataPart = safeRecord(profile.dataPart, "requestProfile.dataPart", createId);
  const dataPartMetadata = safeRecord(profile.dataPartMetadata, "requestProfile.dataPartMetadata", createId);
  const paramsMetadata = safeRecord(profile.paramsMetadata, "requestProfile.paramsMetadata", createId);
  const parts: Array<Record<string, unknown>> = [{ kind: "text", text: renderTaskText(input, config) }];
  if (dataPart) {
    parts.push({
      kind: "data",
      data: dataPart,
      ...(dataPartMetadata ? { metadata: dataPartMetadata } : {}),
    });
  }
  const message = {
    ...messageFields,
    role: "user",
    messageId,
    ...(profile.messageKind ? { kind: String(profile.messageKind) } : {}),
    parts,
    ...(contextId ? { contextId } : {}),
    ...(taskId ? { taskId } : {}),
  };
  const method = String(config.method || (config.stream === true ? "message/stream" : "message/send"));
  return {
    body: {
      jsonrpc: "2.0",
      id: createId(),
      method,
      params: {
        message,
        ...(paramsMetadata ? { metadata: paramsMetadata } : {}),
      },
    },
    contextId,
    taskId,
  };
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function partText(part: any): string {
  if (!part || typeof part !== "object") return "";
  if ((part.kind === "text" || part.type === "text") && typeof part.text === "string") {
    return part.text.trim();
  }
  if (part.kind === "data" || part.type === "data") {
    const payload = part.data;
    if (payload && typeof payload === "object" && "data" in payload) {
      return valueText(payload.data);
    }
    if (payload && typeof payload === "object" && "value" in payload) {
      return valueText(payload.value);
    }
    return valueText(payload);
  }
  return "";
}

function partsText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const values = parts.map(partText).filter(Boolean);
  if (values.length <= 1) return values[0] || "";
  const last = values.at(-1) || "";
  const preceding = values.slice(0, -1).join("");
  const compact = (text: string) => text.replace(/\s+/g, "");
  return last && preceding && compact(last) === compact(preceding) ? last : values.join("\n");
}

function recursiveA2AText(value: unknown): string {
  const texts: string[] = [];
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const direct = partText(node);
    if (direct) {
      texts.push(direct);
      return;
    }
    if (Array.isArray(node.parts)) {
      const combined = partsText(node.parts);
      if (combined) texts.push(combined);
      return;
    }
    if (Array.isArray(node.artifacts)) visit(node.artifacts);
    if (node.artifact) visit(node.artifact);
    if (node.message) visit(node.message);
    if (node.status?.message) visit(node.status.message);
    if (node.result) visit(node.result);
  };
  visit(value);
  return texts.join("\n").trim();
}

export function extractA2ATaskResult(events: unknown[], config: A2AEndpointConfig): { text: string; remoteTaskId?: string } {
  const preferredNames = new Set(
    (Array.isArray(config.resultProfile?.artifactNames) ? config.resultProfile?.artifactNames : [])
      .map((name) => String(name || "").trim().toLowerCase())
      .filter(Boolean),
  );
  const artifactSnapshots = new Map<string, string>();
  const responseSnapshots = new Map<string, string>();
  let remoteTaskId = "";

  for (const event of events as any[]) {
    const result = event?.result ?? event;
    if (!result || typeof result !== "object") continue;
    remoteTaskId = String(result.taskId || result.id || result.contextId || remoteTaskId || "").trim();
    const artifact = result.artifact || result.result?.artifact;
    if (!artifact || typeof artifact !== "object") continue;
    const artifactId = String(artifact.artifactId || artifact.artifact_id || artifact.name || "response");
    const artifactName = String(artifact.name || artifactId).trim().toLowerCase();
    const text = partsText(artifact.parts) || recursiveA2AText(artifact);
    if (!text) continue;
    if (preferredNames.size > 0 && preferredNames.has(artifactName)) {
      artifactSnapshots.set(artifactId, text);
    }
    if (artifactName === "response" || artifactId.includes("_response")) {
      responseSnapshots.set(artifactId, text);
    }
  }

  const preferred = Array.from(artifactSnapshots.values()).at(-1)?.trim();
  if (preferred) return { text: preferred, remoteTaskId: remoteTaskId || undefined };
  if (preferredNames.size > 0) {
    return { text: "", remoteTaskId: remoteTaskId || undefined };
  }
  const response = Array.from(responseSnapshots.values()).at(-1)?.trim();
  if (response) return { text: response, remoteTaskId: remoteTaskId || undefined };

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as any;
    const text = recursiveA2AText(event?.result ?? event);
    if (text) return { text, remoteTaskId: remoteTaskId || undefined };
  }
  const last = (events.at(-1) as any)?.result ?? events.at(-1) ?? {};
  return { text: valueText(last), remoteTaskId: remoteTaskId || undefined };
}

function parseA2ADataBlock(block: string): unknown[] {
  const data = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .join("\n");
  if (!data) return [];
  try {
    return [JSON.parse(data)];
  } catch {
    return [];
  }
}

function parseA2AResponse(raw: string): unknown[] {
  const blocks = raw.includes("\n\n") ? raw.split(/\r?\n\r?\n+/) : [raw];
  const events = blocks.flatMap(parseA2ADataBlock);
  if (events.length > 0) return events;
  try {
    return [JSON.parse(raw || "{}")];
  } catch {
    return [];
  }
}

function isA2ACompleteEvent(event: any): boolean {
  const result = event?.result ?? event;
  if (!result || typeof result !== "object") return false;
  const state = String(result.status?.state || result.state || "").toLowerCase();
  if (["completed", "succeeded", "failed", "canceled", "cancelled"].includes(state)) return true;
  if (result.final === true || result.done === true || result.completed === true) return true;
  const kind = String(result.kind || result.type || "").toLowerCase();
  return kind.includes("complete") || kind.includes("completed");
}

function retryDelay(config: A2ARetryProfile, attempt: number) {
  const base = Math.max(100, Math.min(10_000, Number(config.baseDelayMs || 1_000)));
  const max = Math.max(base, Math.min(30_000, Number(config.maxDelayMs || 10_000)));
  return Math.min(base * attempt, max);
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function runA2AExpertTask(connection: A2AAgentConnection, input: string): Promise<A2ATaskResult> {
  const config = connection.endpointConfig || {};
  const rpcUrl = endpoint(String(connection.apiUrl || ""), String(config.rpcPath ?? config.path ?? ""));
  const timeoutMs = Math.max(5_000, Math.min(30 * 60_000, Number(config.timeoutMs || 10 * 60_000)));
  const retry = config.retryProfile || {};
  const maxRetries = Math.max(0, Math.min(10, Number(retry.maxRetries || 0)));
  const request = buildA2ATaskRequest(input, config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const events: unknown[] = [];
  let lastError: unknown;

  try {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) await wait(retryDelay(retry, attempt));
      const body = attempt === 0
        ? request.body
        : {
            jsonrpc: "2.0",
            id: profileId(config),
            method: String(retry.method || "tasks/resubscribe"),
            params: {
              id: request.taskId,
              contextId: request.contextId,
            },
          };
      try {
        const response = await safeAgentRequest(rpcUrl, {
          method: "POST",
          headers: {
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            ...authHeaders(connection.apiToken),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
          timeoutMs,
        });
        if (response.status < 200 || response.status >= 300) {
          const raw = await readSafeAgentResponseText(response).catch(() => "");
          const error = new Error(`A2A HTTP ${response.status}: ${raw.slice(0, 300)}`);
          if (response.status >= 500 && attempt < maxRetries) {
            lastError = error;
            continue;
          }
          throw error;
        }
        const contentType = String(response.headers["content-type"] || "").toLowerCase();
        if (!contentType.includes("text/event-stream")) {
          const raw = await readSafeAgentResponseText(response);
          events.push(...parseA2AResponse(raw));
          const result = extractA2ATaskResult(events, config);
          return { ...result, rawEvents: events.slice(-20) };
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let responseBytes = 0;
        for await (const chunk of response.body) {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          responseBytes += value.length;
          if (responseBytes > MAX_RESPONSE_BYTES) {
            response.body.destroy(new Error("Agent endpoint response is too large"));
            throw new Error("Agent endpoint response is too large");
          }
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() || "";
          for (const block of blocks) {
            const parsed = parseA2ADataBlock(block);
            events.push(...parsed);
            const partial = extractA2ATaskResult(events, config);
            if (parsed.some(isA2ACompleteEvent) && partial.text) {
              response.body.destroy();
              return { ...partial, rawEvents: events.slice(-20) };
            }
          }
        }
        if (buffer.trim()) events.push(...parseA2ADataBlock(buffer));
        const result = extractA2ATaskResult(events, config);
        return { ...result, rawEvents: events.slice(-20) };
      } catch (error) {
        if (controller.signal.aborted) throw error;
        lastError = error;
        if (attempt >= maxRetries) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("A2A task failed");
  } finally {
    clearTimeout(timeout);
  }
}

export function summarizeA2AEvents(events: unknown[], config: A2AEndpointConfig, maxBytes = 40_000) {
  const compact = (events as any[]).slice(-20).map((event) => {
    const result = event?.result ?? event;
    if (!result || typeof result !== "object") return event;
    const artifact = result.artifact;
    return {
      id: event?.id,
      kind: result.kind,
      taskId: result.taskId || result.id,
      contextId: result.contextId,
      final: result.final,
      state: result.status?.state,
      artifact: artifact ? {
        artifactId: artifact.artifactId || artifact.artifact_id,
        name: artifact.name,
        resultBytes: Buffer.byteLength(partsText(artifact.parts), "utf8"),
      } : undefined,
    };
  });
  const serialized = JSON.stringify(compact);
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return serialized;
  return Buffer.from(serialized, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/g, "");
}
