import { createHash } from "crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import path from "path";
import {
  addAgentMemoryEvidence,
  claimNextAgentMemoryJob,
  createAgentMemory,
  enqueueAgentMemoryJob,
  failAgentMemoryJob,
  failAgentMemorySynthesis,
  findAgentMemoryByKey,
  finishAgentMemoryJob,
  confirmAgentMemoryRecord,
  forgetAgentMemoryRecord,
  getClawByAdoptId,
  getAgentMemoryById,
  getAgentMemoryCursor,
  getAgentMemoryMode,
  getAgentMemorySynthesisState,
  listAgentMemories,
  listAgentMemoryEvidence,
  listAgentMemorySyntheses,
  listClawAdoptionsAdmin,
  promoteConversationMemoryCandidates,
  pruneAgentMemoryJobs,
  rejectConversationMemoryCandidates,
  rejectAgentMemoryRecord,
  recoverStaleAgentMemoryJobs,
  resolveEffectiveRoleAssets,
  markAgentMemorySynthesisPending,
  markAgentMemorySynthesisRunning,
  replaceAgentMemorySyntheses,
  setAgentMemoryMode,
  setAgentMemoryStatus,
  updateAgentMemoryContent,
  updateAgentMemoryObservation,
  upsertAgentMemoryCursor,
  type AgentMemoryKind,
  type AgentMemoryMode,
  type AgentMemoryRecord,
  type AgentMemorySource,
  type AgentMemoryStatus,
  type AgentMemorySynthesisRecord,
  type AgentMemorySynthesisSlot,
} from "../db";
import { callEaAssistantModel } from "./ea-assistant-model";
import { detectSensitiveData, type SensitiveDataType } from "./data-guardrail";
import { stripEaInternalRuntimeContext } from "@shared/ea-runtime-context";
import { decryptSecret, encryptSecret } from "./secret-protection";
import { JIUWENCLAW_HOME, appendLogAsync, jiuwenClawWorkspaceDir } from "./helpers";
import { memoryPolicyMarkdown } from "./agent-memory-policy";
import { resolveAgentRoleTemplate } from "./role-templates";
import {
  writeJiuwenSwarmIdentityFilesIfMissing,
  writeJiuwenSwarmUserFileIfMissing,
} from "./jiuwenswarm-role-scope";

const MANAGED_BLOCK_START = "<!-- EA_MANAGED_MEMORY_START -->";
const MANAGED_BLOCK_END = "<!-- EA_MANAGED_MEMORY_END -->";
const POLICY_BLOCK_START = "<!-- EA_MEMORY_POLICY_START -->";
const POLICY_BLOCK_END = "<!-- EA_MEMORY_POLICY_END -->";
const MAX_MEMORY_CONTENT_CHARS = 800;
const MAX_PROJECTED_MEMORY_CHARS = 4800;
const MAX_PROJECTED_SYNTHESIS_CHARS = 1800;
const MEMORY_WORKER_INTERVAL_MS = 3000;
const CHANNEL_SCAN_INTERVAL_MS = 15_000;
const MEMORY_SYNTHESIS_DELAY_MS = 750;

export type AgentMemoryTurn = {
  userId: number;
  adoptId: string;
  roleTemplate: string;
  channel: string;
  sessionId?: string;
  requestId?: string;
  conversationId?: string;
  messageId?: string;
  userMessage: string;
  assistantMessage: string;
  selectedSkillIds?: string[];
  toolNames?: string[];
};

export type MemoryCandidate = {
  key: string;
  kind: AgentMemoryKind;
  content: string;
  confidence: number;
  expiresDays?: number | null;
};

export type MemorySynthesisCandidate = {
  key: string;
  slot: AgentMemorySynthesisSlot;
  content: string;
  memoryIds: number[];
  confidence: number;
};

type MemoryJobPayload = Pick<
  AgentMemoryTurn,
  "userMessage" | "assistantMessage" | "selectedSkillIds" | "toolNames" | "messageId"
>;

type MemoryEvidenceInput = {
  sourceType: "explicit" | "conversation" | "feedback" | "legacy";
  channel: string;
  sessionId?: string;
  requestId?: string;
  conversationId?: string;
  messageId?: string;
  sourceText: string;
  metadata?: Record<string, unknown>;
};

const MEMORY_KINDS = new Set<AgentMemoryKind>(["preference", "instruction", "entity", "procedure"]);
const MEMORY_SYNTHESIS_SLOTS = new Set<AgentMemorySynthesisSlot>(["profile", "recent", "playbook"]);
const HIGH_RISK_PATTERNS: Array<[RegExp, string]> = [
  [/ignore\s+(?:all|previous|prior|above)\s+instructions/i, "prompt_injection"],
  [/忽略(?:以上|之前|所有).{0,10}(?:指令|规则|要求)/i, "prompt_injection"],
  [/system\s+prompt|系统提示词/i, "prompt_injection"],
];

const MEMORY_RISK_BY_SENSITIVE_TYPE: Record<SensitiveDataType, string> = {
  private_key: "private_key",
  credential: "credential",
  cn_id_card: "identity_number",
  cn_phone: "phone_number",
  bank_card: "payment_number",
};

function featureEnabled(): boolean {
  return !/^(0|false|no|off)$/i.test(String(process.env.EA_MANAGED_MEMORY_ENABLED || "true"));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeMemoryContent(value: unknown): string {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MEMORY_CONTENT_CHARS);
}

export function memoryContentRisk(value: string): string | null {
  const content = normalizeMemoryContent(value);
  if (!content) return "empty";
  if (content.length < 4) return "too_short";
  const sensitive = detectSensitiveData(content, { requireBankCardContext: false })[0];
  if (sensitive) return MEMORY_RISK_BY_SENSITIVE_TYPE[sensitive.type];
  for (const [pattern, code] of HIGH_RISK_PATTERNS) {
    if (pattern.test(content)) return code;
  }
  return null;
}

export function normalizeMemoryKey(value: unknown, content: string): string {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, ".")
    .replace(/\.{2,}/g, ".")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 150);
  return raw || `memory.${sha256(normalizeMemoryContent(content).toLowerCase()).slice(0, 24)}`;
}

export function sanitizeMemoryTurnText(value: unknown, maxChars: number): string {
  return stripEaInternalRuntimeContext(value)
    .replace(/<selected_skill>[\s\S]*?<\/selected_skill>/gi, "")
    .replace(/\[已上传附件\][\s\S]*?(?=\n\n|$)/g, "")
    .replace(/workspace path\s*:[^\n]+/gi, "")
    .replace(/\/(?:home|root|Users|var|tmp)\/[^\s)\]}>]+/g, "[本机路径]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, maxChars);
}

export function isLowSignalMemoryTurn(userMessage: string, assistantMessage: string): boolean {
  const user = sanitizeMemoryTurnText(userMessage, 5000);
  const assistant = sanitizeMemoryTurnText(assistantMessage, 8000);
  if (!user || !assistant) return true;
  if (/^\/(?:new|reset|help|status|tools|model|context|usage|tasks)\b/i.test(user)) return true;
  if (/^(?:你好|您好|嗨|hello|hi|在吗|谢谢|收到|好的|ok|test|测试)[！!。.，,？?\s]*$/i.test(user)) return true;
  return user.length < 6 && assistant.length < 30;
}

function parseJsonObject(text: string): any | null {
  const trimmed = String(text || "").trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseMemoryCandidates(text: string): MemoryCandidate[] {
  const parsed = parseJsonObject(text);
  const rows = Array.isArray(parsed?.memories) ? parsed.memories : [];
  const result: MemoryCandidate[] = [];
  for (const row of rows.slice(0, 3)) {
    const content = normalizeMemoryContent(row?.content);
    const kind = MEMORY_KINDS.has(row?.kind) ? row.kind as AgentMemoryKind : "preference";
    const confidence = Math.max(0, Math.min(100, Number(row?.confidence || 0) || 0));
    const risk = memoryContentRisk(content);
    if (risk || confidence < 65) continue;
    const expiresDaysRaw = row?.expires_days ?? row?.expiresDays;
    const expiresDays = expiresDaysRaw == null
      ? null
      : Math.max(1, Math.min(kind === "entity" ? 30 : 365, Number(expiresDaysRaw) || 1));
    result.push({
      key: normalizeMemoryKey(row?.key, content),
      kind,
      content,
      confidence,
      expiresDays,
    });
  }
  return result;
}

export function parseMemorySyntheses(text: string, validMemoryIds: Set<number>): MemorySynthesisCandidate[] {
  const parsed = parseJsonObject(text);
  const rows = Array.isArray(parsed?.syntheses) ? parsed.syntheses : [];
  const result: MemorySynthesisCandidate[] = [];
  const seenKeys = new Set<string>();
  for (const row of rows.slice(0, 8)) {
    const content = normalizeMemoryContent(row?.content);
    const slot = MEMORY_SYNTHESIS_SLOTS.has(row?.slot)
      ? row.slot as AgentMemorySynthesisSlot
      : "profile";
    const confidence = Math.max(0, Math.min(100, Number(row?.confidence || 0) || 0));
    const rawMemoryIds = Array.isArray(row?.memory_ids)
      ? row.memory_ids
      : Array.isArray(row?.memoryIds)
        ? row.memoryIds
        : [];
    const memoryIds = Array.from(new Set(
      rawMemoryIds
        .map(Number)
        .filter((id: number) => Number.isInteger(id) && validMemoryIds.has(id)),
    )).slice(0, 12) as number[];
    const key = normalizeMemoryKey(row?.key, `${slot}.${content}`);
    if (memoryIds.length < 2 || confidence < 65 || memoryContentRisk(content) || seenKeys.has(key)) continue;
    seenKeys.add(key);
    result.push({ key, slot, content, memoryIds, confidence });
  }
  return result;
}

export function memorySynthesisSignature(memories: AgentMemoryRecord[]): string {
  return sha256([
    "ea-memory-synthesis-v2",
    ...memories
      .filter((item) => item.status === "active")
      .sort((a, b) => a.id - b.id)
      .map((item) => [item.id, item.version, item.kind, item.content].join(":")),
  ].join("\n"));
}

function fallbackMemorySyntheses(memories: AgentMemoryRecord[]): MemorySynthesisCandidate[] {
  const make = (
    slot: AgentMemorySynthesisSlot,
    key: string,
    prefix: string,
    rows: AgentMemoryRecord[],
  ): MemorySynthesisCandidate | null => {
    const selected = rows.slice(0, 4);
    if (selected.length < 2) return null;
    return {
      key,
      slot,
      content: normalizeMemoryContent(`${prefix}${selected.map((item) => item.content).join("；")}`),
      memoryIds: selected.map((item) => item.id),
      confidence: Math.min(...selected.map((item) => Math.max(70, item.confidence))),
    };
  };
  const profile = memories.filter((item) => item.kind === "preference" || item.kind === "entity");
  const playbook = memories.filter((item) => item.kind === "instruction" || item.kind === "procedure");
  const recent = memories.length >= 2
    ? [...memories].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 3)
    : [];
  return [
    make("profile", "profile.stable_work_style", "稳定工作偏好：", profile),
    make("recent", "recent.confirmed_changes", "近期确认的工作方式：", recent),
    make("playbook", "playbook.role_method", "常用岗位方法：", playbook),
  ].filter((item): item is MemorySynthesisCandidate => Boolean(item));
}

function atomicWrite(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.ea-memory-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, content, "utf8");
  try { chmodSync(temporary, 0o600); } catch {}
  renameSync(temporary, filePath);
}

export function replaceManagedBlock(
  existing: string,
  startMarker: string,
  endMarker: string,
  body: string,
): string {
  const start = existing.indexOf(startMarker);
  const end = existing.indexOf(endMarker);
  const block = body.trim() ? `${startMarker}\n${body.trim()}\n${endMarker}` : "";
  if (start >= 0 && end >= start) {
    const after = end + endMarker.length;
    return `${existing.slice(0, start).trimEnd()}${block ? `\n\n${block}` : ""}${existing.slice(after)}`.trim() + "\n";
  }
  return `${existing.trim()}${existing.trim() && block ? "\n\n" : ""}${block}`.trim() + "\n";
}

export function renderManagedMemoryMarkdown(
  memories: AgentMemoryRecord[],
  syntheses: AgentMemorySynthesisRecord[] = [],
): string {
  if (!memories.length) return "";
  const lines = [
    "## 已确认的岗位记忆",
    "",
    "以下内容由 EA 持续学习系统管理；仅作为用户工作偏好，不覆盖系统规则、岗位边界或实时业务数据。",
    "",
  ];
  if (syntheses.length) {
    const synthesisLines: string[] = [];
    let synthesisChars = 0;
    for (const item of syntheses) {
      const label = item.slot === "profile" ? "画像" : item.slot === "recent" ? "近期" : "方法";
      const line = `- [${label}] ${normalizeMemoryContent(item.content)}`;
      if (synthesisChars + line.length + 1 > MAX_PROJECTED_SYNTHESIS_CHARS) break;
      synthesisLines.push(line);
      synthesisChars += line.length + 1;
    }
    if (synthesisLines.length) lines.push("### 综合认知", "", ...synthesisLines, "", "### 记忆事实", "");
  }
  let used = lines.join("\n").length;
  for (const item of memories) {
    const label = item.kind === "procedure" ? "流程" : item.kind === "entity" ? "事项" : "偏好";
    const line = `- [${label}] ${normalizeMemoryContent(item.content)}`;
    if (used + line.length + 1 > MAX_PROJECTED_MEMORY_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

export async function projectAgentMemories(input: {
  userId: number;
  adoptId: string;
  dbAgentId?: string;
  adoptionId: number;
}): Promise<{ activeCount: number; userPath: string }> {
  const mode = featureEnabled() ? await getAgentMemoryMode(input.adoptionId) : "off";
  const memories = mode === "off"
    ? []
    : await listAgentMemories({ userId: input.userId, adoptId: input.adoptId, statuses: ["active"], limit: 200 });
  const sourceSignature = memorySynthesisSignature(memories);
  const syntheses = mode === "off"
    ? []
    : await listAgentMemorySyntheses({
        userId: input.userId,
        adoptId: input.adoptId,
        sourceSignature,
      });
  const workspaceDir = jiuwenClawWorkspaceDir(input.adoptId, input.dbAgentId);
  const userPath = path.join(workspaceDir, "USER.md");
  const identityPath = path.join(workspaceDir, "IDENTITY.md");
  const existingUser = existsSync(userPath) ? readFileSync(userPath, "utf8") : "# 用户偏好\n";
  const existingIdentity = existsSync(identityPath) ? readFileSync(identityPath, "utf8") : "# 身份\n";
  const nextUser = replaceManagedBlock(
    existingUser,
    MANAGED_BLOCK_START,
    MANAGED_BLOCK_END,
    renderManagedMemoryMarkdown(memories, syntheses),
  );
  const nextIdentity = replaceManagedBlock(
    existingIdentity,
    POLICY_BLOCK_START,
    POLICY_BLOCK_END,
    memoryPolicyMarkdown(mode),
  );
  if (nextUser !== existingUser) atomicWrite(userPath, nextUser);
  if (nextIdentity !== existingIdentity) atomicWrite(identityPath, nextIdentity);
  return { activeCount: memories.length, userPath };
}

async function projectByAdoptId(adoptId: string): Promise<void> {
  const claw = await getClawByAdoptId(adoptId);
  if (!claw || !String(claw.adoptId).startsWith("lgj-")) return;
  await projectAgentMemories({
    userId: Number(claw.userId),
    adoptId,
    dbAgentId: String(claw.agentId || ""),
    adoptionId: Number(claw.id),
  });
}

const synthesisTimers = new Map<string, NodeJS.Timeout>();
const synthesisInFlight = new Set<string>();

function synthesisPrompt(roleTemplate: string, memories: AgentMemoryRecord[]): string {
  const facts = memories.map((item) => ({
    id: item.id,
    kind: item.kind,
    content: item.content,
    confidence: item.confidence,
    evidence_count: item.evidenceCount,
    updated_at: item.updatedAt,
  }));
  return [
    `当前岗位：${roleTemplate}`,
    "下面是已经确认、允许长期使用的记忆事实。请只基于这些事实形成更高层的综合认知，不得补充外部知识或猜测。",
    "输出分为 profile（稳定工作画像）、recent（近期变化）、playbook（岗位方法）三类；没有依据的类别可以不输出。",
    "每条结论必须引用 memory_ids，且只能引用输入中存在的 id。尽量综合多条相关事实，避免简单改写单条事实。",
    "不得包含客户数据、行情、余额、持仓、密钥、证件信息或实时业务结论。最多 8 条，每条为简洁中文陈述。",
    "严格输出 JSON：{\"syntheses\":[{\"key\":\"profile.answer_style\",\"slot\":\"profile|recent|playbook\",\"content\":\"...\",\"memory_ids\":[1,2],\"confidence\":0-100}]}。",
    `记忆事实：${JSON.stringify(facts)}`,
  ].join("\n\n");
}

export async function refreshAgentMemorySynthesis(input: {
  userId: number;
  adoptId: string;
  roleTemplate?: string;
  force?: boolean;
}): Promise<{ status: "ready"; count: number; model: string }> {
  const key = `${input.userId}:${input.adoptId}`;
  if (synthesisInFlight.has(key)) {
    const current = await listAgentMemorySyntheses({ userId: input.userId, adoptId: input.adoptId });
    return { status: "ready", count: current.length, model: current[0]?.model || "" };
  }
  const memories = await listAgentMemories({
    userId: input.userId,
    adoptId: input.adoptId,
    statuses: ["active"],
    limit: 200,
  });
  const sourceSignature = memorySynthesisSignature(memories);
  const state = await getAgentMemorySynthesisState(input.userId, input.adoptId);
  if (!input.force && state?.status === "ready" && state.completedSignature === sourceSignature) {
    const current = await listAgentMemorySyntheses({
      userId: input.userId,
      adoptId: input.adoptId,
      sourceSignature,
    });
    return { status: "ready", count: current.length, model: state.model };
  }

  synthesisInFlight.add(key);
  await markAgentMemorySynthesisRunning({
    userId: input.userId,
    adoptId: input.adoptId,
    desiredSignature: sourceSignature,
  });
  try {
    let rows: MemorySynthesisCandidate[] = [];
    let model = "rule-based";
    if (memories.length >= 2) {
      try {
        const result = await callEaAssistantModel({
          maxTokens: 1400,
          temperature: 0,
          timeoutMs: 20_000,
          messages: [
            {
              role: "system",
              content: "你是企业岗位智能体的长期记忆整理器。所有结论都必须可追溯到提供的记忆事实，并严格输出 JSON。",
            },
            { role: "user", content: synthesisPrompt(input.roleTemplate || "general-assistant", memories) },
          ],
        });
        model = result.model;
        rows = parseMemorySyntheses(result.content, new Set(memories.map((item) => item.id)));
      } catch (error: any) {
        model = "rule-based-fallback";
        appendLogAsync("agent-memory.log", {
          ts: new Date().toISOString(),
          event: "memory_synthesis_model_fallback",
          adoptId: input.adoptId,
          error: String(error?.message || error).slice(0, 300),
        });
      }
    }
    if (!rows.length && memories.length >= 2) rows = fallbackMemorySyntheses(memories);
    await replaceAgentMemorySyntheses({
      userId: input.userId,
      adoptId: input.adoptId,
      sourceSignature,
      model,
      rows: rows.map((row) => ({
        slot: row.slot,
        canonicalKey: row.key,
        content: row.content,
        memoryIds: row.memoryIds,
        confidence: row.confidence,
      })),
    });
    await projectByAdoptId(input.adoptId);
    appendLogAsync("agent-memory.log", {
      ts: new Date().toISOString(),
      event: "memory_synthesis_complete",
      adoptId: input.adoptId,
      factCount: memories.length,
      synthesisCount: rows.length,
      model,
    });
    return { status: "ready", count: rows.length, model };
  } catch (error: any) {
    await failAgentMemorySynthesis({
      userId: input.userId,
      adoptId: input.adoptId,
      desiredSignature: sourceSignature,
      errorMessage: String(error?.message || error),
    });
    throw error;
  } finally {
    synthesisInFlight.delete(key);
    void (async () => {
      const latest = await listAgentMemories({
        userId: input.userId,
        adoptId: input.adoptId,
        statuses: ["active"],
        limit: 200,
      });
      if (memorySynthesisSignature(latest) !== sourceSignature) {
        scheduleAgentMemorySynthesis(input, 50);
      }
    })().catch(() => {});
  }
}

function scheduleAgentMemorySynthesis(input: {
  userId: number;
  adoptId: string;
  roleTemplate?: string;
}, delayMs = MEMORY_SYNTHESIS_DELAY_MS): void {
  const key = `${input.userId}:${input.adoptId}`;
  if (synthesisTimers.has(key) || synthesisInFlight.has(key)) return;
  void (async () => {
    const memories = await listAgentMemories({
      userId: input.userId,
      adoptId: input.adoptId,
      statuses: ["active"],
      limit: 200,
    });
    await markAgentMemorySynthesisPending({
      userId: input.userId,
      adoptId: input.adoptId,
      desiredSignature: memorySynthesisSignature(memories),
    });
  })().catch(() => {});
  const timer = setTimeout(() => {
    synthesisTimers.delete(key);
    void refreshAgentMemorySynthesis(input).catch((error) => {
      appendLogAsync("agent-memory.log", {
        ts: new Date().toISOString(),
        event: "memory_synthesis_failed",
        adoptId: input.adoptId,
        error: String(error?.message || error).slice(0, 300),
      });
    });
  }, delayMs);
  timer.unref?.();
  synthesisTimers.set(key, timer);
}

function scheduleSynthesisByAdoptId(adoptId: string): void {
  void (async () => {
    const claw = await getClawByAdoptId(adoptId);
    if (!claw) return;
    scheduleAgentMemorySynthesis({
      userId: Number(claw.userId),
      adoptId,
      roleTemplate: String(claw.roleTemplate || "general-assistant"),
    });
  })().catch(() => {});
}

async function isAgentMemoryLearningAllowed(userId: number, adoptId: string): Promise<boolean> {
  const claw = await getClawByAdoptId(adoptId);
  return Boolean(
    claw
    && Number(claw.userId) === Number(userId)
    && await getAgentMemoryMode(Number(claw.id)) === "learn_and_use",
  );
}

function evidenceHash(input: MemoryEvidenceInput, content: string): string {
  return sha256([
    input.sourceType,
    input.channel,
    input.sessionId || "",
    input.requestId || "",
    input.conversationId || "",
    input.messageId || "",
    normalizeMemoryContent(content),
  ].join("\0"));
}

async function observeMemory(input: {
  userId: number;
  adoptId: string;
  roleTemplate: string;
  scope?: "role" | "user";
  kind: AgentMemoryKind;
  key?: string;
  content: string;
  source: AgentMemorySource;
  confidence: number;
  expiresDays?: number | null;
  evidence: MemoryEvidenceInput;
}): Promise<AgentMemoryRecord> {
  const content = normalizeMemoryContent(input.content);
  const risk = memoryContentRisk(content);
  if (risk) throw new Error(`memory_rejected:${risk}`);
  const canonicalKey = normalizeMemoryKey(input.key, content);
  const explicit = input.source === "explicit";
  const expiresAt = input.expiresDays
    ? new Date(Date.now() + input.expiresDays * 24 * 60 * 60 * 1000)
    : null;
  let item = await findAgentMemoryByKey(input.userId, input.adoptId, canonicalKey);
  if (item && ["forgotten", "rejected"].includes(item.status) && !explicit) return item;
  if (!item) {
    item = await createAgentMemory({
      userId: input.userId,
      adoptId: input.adoptId,
      roleTemplate: input.roleTemplate,
      scope: input.scope || "role",
      kind: input.kind,
      status: explicit ? "active" : "candidate",
      canonicalKey,
      content,
      source: input.source,
      confidence: input.confidence,
      expiresAt,
    });
  } else if (!(item.status === "active" && !explicit)) {
    await updateAgentMemoryObservation({
      id: item.id,
      content,
      kind: input.kind,
      source: input.source,
      confidence: input.confidence,
      status: explicit ? "active" : undefined,
      expiresAt,
    });
  }
  const evidenceCount = await addAgentMemoryEvidence({
    memoryId: item.id,
    userId: input.userId,
    adoptId: input.adoptId,
    sourceType: input.evidence.sourceType,
    channel: input.evidence.channel,
    sessionId: input.evidence.sessionId,
    requestId: input.evidence.requestId,
    conversationId: input.evidence.conversationId,
    messageId: input.evidence.messageId,
    sourceHash: evidenceHash(input.evidence, content),
    // Automatic evidence keeps only a hash and structured metadata. The durable
    // memory itself is already stored in agent_memory_items, so retaining a chat
    // excerpt would unnecessarily duplicate user content.
    snippet: input.evidence.sourceType === "explicit"
      ? sanitizeMemoryTurnText(input.evidence.sourceText, 500)
      : undefined,
    metadata: input.evidence.metadata,
  });
  item = await getAgentMemoryById(input.userId, input.adoptId, item.id) || item;
  if (!explicit && item.status === "candidate" && evidenceCount >= 2 && item.confidence >= 70) {
    await setAgentMemoryStatus(item.id, input.userId, input.adoptId, "active");
    item = await getAgentMemoryById(input.userId, input.adoptId, item.id) || { ...item, status: "active" };
  }
  if (item.status === "active") {
    await projectByAdoptId(input.adoptId);
    scheduleAgentMemorySynthesis({
      userId: input.userId,
      adoptId: input.adoptId,
      roleTemplate: input.roleTemplate,
    });
  }
  return item;
}

export async function rememberExplicitPreference(input: {
  adoptId: string;
  content: string;
  key?: string;
  kind?: AgentMemoryKind;
  channel?: string;
  sessionId?: string;
  requestId?: string;
  conversationId?: string;
  messageId?: string;
}): Promise<AgentMemoryRecord> {
  if (!featureEnabled()) throw new Error("持续学习已关闭");
  const claw = await getClawByAdoptId(input.adoptId);
  if (!claw) throw new Error("岗位智能体不存在");
  const mode = await getAgentMemoryMode(Number(claw.id));
  if (mode !== "learn_and_use") throw new Error(mode === "off" ? "持续学习已关闭" : "当前仅使用已有记忆");
  return observeMemory({
    userId: Number(claw.userId),
    adoptId: input.adoptId,
    roleTemplate: String(claw.roleTemplate || "general-assistant"),
    kind: input.kind && MEMORY_KINDS.has(input.kind) ? input.kind : "preference",
    key: input.key,
    content: input.content,
    source: "explicit",
    confidence: 100,
    evidence: {
      sourceType: "explicit",
      channel: String(input.channel || "conversation"),
      sessionId: input.sessionId,
      requestId: input.requestId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      sourceText: input.content,
    },
  });
}

export async function forgetAgentMemory(input: {
  userId: number;
  adoptId: string;
  id?: number;
  query?: string;
}): Promise<AgentMemoryRecord> {
  const items = await listAgentMemories({
    userId: input.userId,
    adoptId: input.adoptId,
    statuses: ["active", "candidate"],
    limit: 300,
  });
  const query = normalizeMemoryContent(input.query).toLowerCase();
  const item = input.id
    ? items.find((candidate) => candidate.id === input.id)
    : items.find((candidate) => query && (
      candidate.content.toLowerCase().includes(query)
      || query.includes(candidate.content.toLowerCase())
      || candidate.canonicalKey === normalizeMemoryKey(query, query)
    ));
  if (!item) throw new Error("没有找到匹配的岗位偏好");
  await forgetAgentMemoryRecord(item.id, input.userId, input.adoptId);
  await projectByAdoptId(input.adoptId);
  scheduleAgentMemorySynthesis({
    userId: input.userId,
    adoptId: input.adoptId,
    roleTemplate: item.roleTemplate,
  });
  return { ...item, status: "forgotten" };
}

export async function updateAgentMemory(input: {
  userId: number;
  adoptId: string;
  id: number;
  content: string;
}): Promise<AgentMemoryRecord> {
  const content = normalizeMemoryContent(input.content);
  const risk = memoryContentRisk(content);
  if (risk) throw new Error(`memory_rejected:${risk}`);
  const existing = await getAgentMemoryById(input.userId, input.adoptId, input.id);
  if (!existing || !["active", "candidate"].includes(existing.status)) throw new Error("岗位偏好不存在");
  await updateAgentMemoryContent(input.id, input.userId, input.adoptId, content);
  await projectByAdoptId(input.adoptId);
  scheduleAgentMemorySynthesis({
    userId: input.userId,
    adoptId: input.adoptId,
    roleTemplate: existing.roleTemplate,
  });
  return await getAgentMemoryById(input.userId, input.adoptId, input.id) || { ...existing, content, status: "active" };
}

export async function listAgentMemoryView(input: { userId: number; adoptId: string; adoptionId: number }) {
  const [mode, items] = await Promise.all([
    getAgentMemoryMode(input.adoptionId),
    listAgentMemories({ userId: input.userId, adoptId: input.adoptId, statuses: ["active", "candidate"], limit: 300 }),
  ]);
  const evidence = await listAgentMemoryEvidence({
    userId: input.userId,
    adoptId: input.adoptId,
    memoryIds: items.map((item) => item.id),
    limit: 600,
  });
  const activeItems = items.filter((item) => item.status === "active");
  const sourceSignature = memorySynthesisSignature(activeItems);
  const [syntheses, storedSynthesisState] = await Promise.all([
    listAgentMemorySyntheses({
      userId: input.userId,
      adoptId: input.adoptId,
      sourceSignature,
    }),
    getAgentMemorySynthesisState(input.userId, input.adoptId),
  ]);
  const synthesisReady = storedSynthesisState?.status === "ready"
    && storedSynthesisState.completedSignature === sourceSignature;
  const synthesisFailed = storedSynthesisState?.status === "failed"
    && storedSynthesisState.desiredSignature === sourceSignature;
  if (!synthesisReady && !synthesisFailed) scheduleSynthesisByAdoptId(input.adoptId);
  const synthesisStatus = synthesisReady
    ? "ready"
    : synthesisFailed
      ? "failed"
      : "building";
  return {
    mode,
    summary: {
      active: activeItems.length,
      candidate: items.filter((item) => item.status === "candidate").length,
      procedures: activeItems.filter((item) => item.kind === "procedure").length,
      evidence: evidence.length,
      syntheses: syntheses.length,
    },
    items,
    evidence,
    syntheses,
    synthesisState: {
      status: synthesisStatus,
      model: synthesisReady ? storedSynthesisState?.model || "" : "",
      errorMessage: synthesisFailed ? storedSynthesisState?.errorMessage || "记忆整理暂时失败" : null,
      generatedAt: synthesisReady ? storedSynthesisState?.completedAt || null : null,
    },
  };
}

export async function confirmAgentMemory(input: { userId: number; adoptId: string; id: number }): Promise<void> {
  const existing = await getAgentMemoryById(input.userId, input.adoptId, input.id);
  if (!existing || existing.status !== "candidate") throw new Error("待确认记忆不存在");
  await confirmAgentMemoryRecord(input.id, input.userId, input.adoptId);
  await projectByAdoptId(input.adoptId);
  scheduleAgentMemorySynthesis({
    userId: input.userId,
    adoptId: input.adoptId,
    roleTemplate: existing.roleTemplate,
  });
}

export async function rejectAgentMemory(input: { userId: number; adoptId: string; id: number }): Promise<void> {
  const existing = await getAgentMemoryById(input.userId, input.adoptId, input.id);
  if (!existing || existing.status !== "candidate") throw new Error("待确认记忆不存在");
  await rejectAgentMemoryRecord(input.id, input.userId, input.adoptId);
}

export async function changeAgentMemoryMode(input: {
  userId: number;
  adoptId: string;
  adoptionId: number;
  dbAgentId?: string;
  mode: AgentMemoryMode;
}): Promise<void> {
  await setAgentMemoryMode(input.adoptionId, input.mode, input.userId);
  await projectAgentMemories(input);
}

export async function applyPositiveMemoryFeedback(input: {
  userId: number;
  adoptId: string;
  conversationId: string;
}): Promise<void> {
  const promoted = await promoteConversationMemoryCandidates(input);
  if (promoted > 0) {
    await projectByAdoptId(input.adoptId);
    scheduleSynthesisByAdoptId(input.adoptId);
  }
}

export async function applyNegativeMemoryFeedback(input: {
  userId: number;
  adoptId: string;
  conversationId: string;
}): Promise<void> {
  await rejectConversationMemoryCandidates(input);
}

export async function enqueueAgentMemoryTurn(turn: AgentMemoryTurn): Promise<void> {
  if (!featureEnabled() || isLowSignalMemoryTurn(turn.userMessage, turn.assistantMessage)) return;
  const claw = await getClawByAdoptId(turn.adoptId);
  if (!claw || Number(claw.userId) !== Number(turn.userId)) return;
  if (await getAgentMemoryMode(Number(claw.id)) !== "learn_and_use") return;
  const payload: MemoryJobPayload = {
    userMessage: sanitizeMemoryTurnText(turn.userMessage, 5000),
    assistantMessage: sanitizeMemoryTurnText(turn.assistantMessage, 8000),
    selectedSkillIds: (turn.selectedSkillIds || []).map(String).filter(Boolean).slice(0, 20),
    toolNames: (turn.toolNames || []).map(String).filter(Boolean).slice(0, 30),
    messageId: String(turn.messageId || "").slice(0, 128),
  };
  const idempotencyKey = sha256([
    "turn-v1",
    turn.adoptId,
    turn.channel,
    turn.sessionId || "",
    turn.requestId || "",
    payload.userMessage,
  ].join("\0"));
  const payloadEncrypted = encryptSecret(JSON.stringify(payload), { maxStoredLength: null });
  await enqueueAgentMemoryJob({
    idempotencyKey,
    userId: turn.userId,
    adoptId: turn.adoptId,
    roleTemplate: turn.roleTemplate || String(claw.roleTemplate || "general-assistant"),
    channel: String(turn.channel || "web").slice(0, 32),
    sessionId: String(turn.sessionId || "").slice(0, 160),
    requestId: String(turn.requestId || "").slice(0, 160),
    conversationId: String(turn.conversationId || "").slice(0, 128),
    payloadEncrypted,
  });
  if (workerStarted) queueMicrotask(() => void processNextMemoryJob());
}

function extractionPrompt(roleTemplate: string, payload: MemoryJobPayload): string {
  return [
    `当前岗位：${roleTemplate}`,
    "请从这一轮对话中识别未来仍有价值、且明确来自用户的稳定工作偏好。",
    "只保存沟通方式、输出格式、稳定工作习惯、明确纠正，以及经过工具成功验证后可复用的个人流程。",
    "不要保存问候、临时任务、任务进度、助手猜测、附件正文、密钥、个人证件、客户明细、余额、持仓、行情、产品状态或任何实时业务数据。",
    "content 必须是第三人称、简短、可独立理解的中文陈述。key 使用稳定的英文点分标识，相同语义必须尽量返回相同 key。",
    "如果没有值得长期保存的内容，返回 {\"memories\":[]}。最多返回 3 条。",
    "输出严格 JSON：{\"memories\":[{\"key\":\"output.risk_first\",\"kind\":\"preference|instruction|entity|procedure\",\"content\":\"...\",\"confidence\":0-100,\"expires_days\":null}]}。",
    payload.selectedSkillIds?.length ? `本轮选择技能：${payload.selectedSkillIds.join(", ")}` : "",
    payload.toolNames?.length ? `本轮成功涉及工具：${payload.toolNames.join(", ")}` : "",
    `用户：${payload.userMessage}`,
    `助手：${payload.assistantMessage}`,
  ].filter(Boolean).join("\n\n");
}

let memoryWorkerBusy = false;

async function processNextMemoryJob(): Promise<void> {
  if (memoryWorkerBusy || !featureEnabled()) return;
  memoryWorkerBusy = true;
  let job: Awaited<ReturnType<typeof claimNextAgentMemoryJob>> = null;
  try {
    job = await claimNextAgentMemoryJob();
    if (!job) return;
    if (!await isAgentMemoryLearningAllowed(job.userId, job.adoptId)) {
      await finishAgentMemoryJob(job.id, "skipped");
      return;
    }
    const payload = JSON.parse(decryptSecret(job.payloadEncrypted)) as MemoryJobPayload;
    if (isLowSignalMemoryTurn(payload.userMessage, payload.assistantMessage)) {
      await finishAgentMemoryJob(job.id, "skipped");
      return;
    }
    const result = await callEaAssistantModel({
      maxTokens: 600,
      temperature: 0,
      timeoutMs: 12_000,
      messages: [
        {
          role: "system",
          content: "你是企业岗位智能体的记忆评审器。只提取用户明确表达且未来仍稳定有用的信息，并严格输出 JSON。",
        },
        { role: "user", content: extractionPrompt(job.roleTemplate, payload) },
      ],
    });
    const candidates = parseMemoryCandidates(result.content);
    if (!await isAgentMemoryLearningAllowed(job.userId, job.adoptId)) {
      await finishAgentMemoryJob(job.id, "skipped");
      return;
    }
    for (const candidate of candidates) {
      await observeMemory({
        userId: job.userId,
        adoptId: job.adoptId,
        roleTemplate: job.roleTemplate,
        kind: candidate.kind,
        key: candidate.key,
        content: candidate.content,
        source: "automatic",
        confidence: candidate.confidence,
        expiresDays: candidate.expiresDays,
        evidence: {
          sourceType: "conversation",
          channel: job.channel,
          sessionId: job.sessionId,
          requestId: job.requestId,
          conversationId: job.conversationId,
          messageId: payload.messageId,
          sourceText: payload.userMessage,
          metadata: {
            selectedSkillIds: payload.selectedSkillIds || [],
            toolNames: payload.toolNames || [],
            extractorModel: result.model,
          },
        },
      });
    }
    await finishAgentMemoryJob(job.id, candidates.length ? "done" : "skipped");
    appendLogAsync("agent-memory.log", {
      ts: new Date().toISOString(),
      event: "memory_job_complete",
      adoptId: job.adoptId,
      channel: job.channel,
      candidateCount: candidates.length,
      durationMs: result.elapsedMs,
    });
  } catch (error: any) {
    if (job) await failAgentMemoryJob(job.id, job.attempts, String(error?.message || error));
    appendLogAsync("agent-memory.log", {
      ts: new Date().toISOString(),
      event: "memory_job_failed",
      adoptId: job?.adoptId || "",
      error: String(error?.message || error).slice(0, 300),
    });
  } finally {
    memoryWorkerBusy = false;
    if (job) {
      const continuation = setTimeout(() => void processNextMemoryJob(), 25);
      continuation.unref?.();
    }
  }
}

function timestampMs(value: unknown): number {
  const raw = Number(value || 0) || 0;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw < 10_000_000_000 ? Math.round(raw * 1000) : Math.round(raw);
}

function readJson(filePath: string): any {
  try { return JSON.parse(readFileSync(filePath, "utf8")); } catch { return null; }
}

function channelSessionAdoptId(metadata: any): string {
  return String(
    metadata?.channel_metadata?.linggan_adopt_id
    || metadata?.delivery_context?.route_metadata?.linggan_adopt_id
    || metadata?.channel_metadata?.source_channel
    || "",
  ).trim();
}

function channelSessionKind(sessionName: string, metadata: any): string {
  const platform = String(
    metadata?.channel_metadata?.im_platform
    || metadata?.delivery_context?.route_metadata?.im_platform
    || "",
  ).trim().toLowerCase();
  if (platform === "wechat") return "weixin";
  if (["feishu", "weixin", "wecom", "dingtalk"].includes(platform)) return platform;

  const raw = String(metadata?.channel_id || "").trim().toLowerCase();
  if (raw === "wechat") return "weixin";
  if (["feishu", "weixin", "wecom", "dingtalk"].includes(raw)) return raw;
  if (/^feishu_/i.test(sessionName)) return "feishu";
  if (/_web_/i.test(sessionName) || /^lgj-[a-z0-9]+$/i.test(raw)) return "web";
  return "";
}

async function scanJiuwenChannelSessions(): Promise<void> {
  if (!featureEnabled()) return;
  const sessionsRoot = path.join(JIUWENCLAW_HOME, "agent", "sessions");
  if (!existsSync(sessionsRoot)) return;
  const sortedEntries = readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, dir: path.join(sessionsRoot, entry.name) }))
    .sort((a, b) => {
      try { return statSync(b.dir).mtimeMs - statSync(a.dir).mtimeMs; } catch { return 0; }
    });
  const namedChannelEntries = sortedEntries
    .filter((entry) => /(^|_)(?:feishu|weixin|wechat|wecom|dingtalk)(?:_|$)/i.test(entry.name))
    .slice(0, 300);
  const entries = Array.from(new Map(
    [...namedChannelEntries, ...sortedEntries.slice(0, 300)].map((entry) => [entry.name, entry]),
  ).values());

  for (const entry of entries) {
    const metadata = readJson(path.join(entry.dir, "metadata.json"));
    const channel = channelSessionKind(entry.name, metadata);
    if (!channel || channel === "web") continue;
    const adoptId = channelSessionAdoptId(metadata);
    if (!/^lgj-[a-z0-9]+$/i.test(adoptId)) continue;
    const historyPath = existsSync(path.join(entry.dir, "history.json"))
      ? path.join(entry.dir, "history.json")
      : path.join(entry.dir, "history.jsonl");
    if (!existsSync(historyPath)) continue;
    const sourceKey = `jiuwen:${channel}:${entry.name}`.slice(0, 191);
    const cursor = await getAgentMemoryCursor(sourceKey);
    const latestMetadataMs = timestampMs(metadata?.last_message_at);
    if (!cursor) {
      await upsertAgentMemoryCursor({ sourceKey, channel, lastTimestampMs: latestMetadataMs || Date.now() });
      continue;
    }
    if (latestMetadataMs && latestMetadataMs <= cursor.lastTimestampMs) continue;
    let records: any[] = [];
    try {
      const raw = readFileSync(historyPath, "utf8");
      records = historyPath.endsWith(".jsonl")
        ? raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
        : readJson(historyPath) || [];
    } catch {
      continue;
    }
    if (!Array.isArray(records)) continue;
    const groups = new Map<string, { user?: any; final?: any; finalTs: number; maxTs: number }>();
    let maxSeen = cursor.lastTimestampMs;
    for (const record of records) {
      const ts = timestampMs(record?.timestamp);
      maxSeen = Math.max(maxSeen, ts);
      const requestId = String(record?.request_id || record?.id || "").trim();
      if (!requestId) continue;
      const group = groups.get(requestId) || { finalTs: 0, maxTs: ts };
      group.maxTs = Math.max(group.maxTs, ts);
      if (record?.role === "user" && String(record?.content || "").trim()) group.user = record;
      if (record?.role === "assistant" && record?.event_type === "chat.final" && String(record?.content || "").trim()) {
        group.final = record;
        group.finalTs = ts;
      }
      groups.set(requestId, group);
    }
    const claw = await getClawByAdoptId(adoptId);
    if (!claw) continue;
    for (const [requestId, group] of groups) {
      if (!group.user || !group.final || group.finalTs <= cursor.lastTimestampMs) continue;
      await enqueueAgentMemoryTurn({
        userId: Number(claw.userId),
        adoptId,
        roleTemplate: String(claw.roleTemplate || "general-assistant"),
        channel,
        sessionId: entry.name,
        requestId,
        conversationId: entry.name,
        messageId: requestId,
        userMessage: String(group.user.content || ""),
        assistantMessage: String(group.final.content || ""),
      });
    }
    await upsertAgentMemoryCursor({
      sourceKey,
      channel,
      lastTimestampMs: maxSeen || latestMetadataMs || cursor.lastTimestampMs,
      lastFingerprint: sha256(`${entry.name}\0${maxSeen}`),
    });
  }
}

let workerStarted = false;

export function startAgentMemoryRuntime(): () => void {
  if (workerStarted || !featureEnabled()) return () => {};
  workerStarted = true;
  void recoverStaleAgentMemoryJobs().catch(() => {});
  void pruneAgentMemoryJobs().catch(() => {});
  void (async () => {
    try {
      const adoptions = await listClawAdoptionsAdmin({ status: "active", limit: 1000 });
      const effectiveAssetsByRole = new Map<string, Awaited<ReturnType<typeof resolveEffectiveRoleAssets>>>();
      for (const claw of adoptions) {
        if (!String(claw.adoptId).startsWith("lgj-")) continue;
        try {
          const role = resolveAgentRoleTemplate(String(claw.roleTemplate || ""));
          let effectiveAssets = effectiveAssetsByRole.get(role.id);
          if (!effectiveAssets) {
            effectiveAssets = await resolveEffectiveRoleAssets(role.id);
            effectiveAssetsByRole.set(role.id, effectiveAssets);
          }
          const workspaceDir = jiuwenClawWorkspaceDir(String(claw.adoptId), String(claw.agentId || ""));
          writeJiuwenSwarmIdentityFilesIfMissing(workspaceDir, role, effectiveAssets);
          writeJiuwenSwarmUserFileIfMissing(workspaceDir, role);
          await projectAgentMemories({
            userId: Number(claw.userId),
            adoptId: String(claw.adoptId),
            dbAgentId: String(claw.agentId || ""),
            adoptionId: Number(claw.id),
          });
        } catch (error) {
          appendLogAsync("agent-memory.log", { event: "startup_projection_failed", adoptId: String(claw.adoptId), error: String(error) });
        }
      }
    } catch {}
  })();
  const worker = setInterval(() => void processNextMemoryJob(), MEMORY_WORKER_INTERVAL_MS);
  const scanner = setInterval(() => void scanJiuwenChannelSessions().catch(() => {}), CHANNEL_SCAN_INTERVAL_MS);
  const janitor = setInterval(() => void pruneAgentMemoryJobs().catch(() => {}), 24 * 60 * 60 * 1000);
  worker.unref?.();
  scanner.unref?.();
  janitor.unref?.();
  queueMicrotask(() => void processNextMemoryJob());
  const initialScan = setTimeout(() => void scanJiuwenChannelSessions().catch(() => {}), 5000);
  initialScan.unref?.();
  return () => {
    clearInterval(worker);
    clearInterval(scanner);
    clearInterval(janitor);
    clearTimeout(initialScan);
    workerStarted = false;
  };
}

export const __agentMemoryTestables = {
  MANAGED_BLOCK_START,
  MANAGED_BLOCK_END,
  POLICY_BLOCK_START,
  POLICY_BLOCK_END,
  channelSessionKind,
};
