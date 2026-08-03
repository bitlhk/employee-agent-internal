import express from "express";
import { decodeBase64Strict, scanUploadForMalware, validateUploadContent } from "./upload-security";
import QRCode from "qrcode";
import http from "http";
import bcrypt from "bcryptjs";
import path from "path";
import { randomUUID } from "crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import {
  getClawByAdoptId,
  getSkillMarketItem,
  getUserByEmail,
  getUserById,
  incrementSkillDownload,
  listApprovedSkillMarketItems,
  listClawsByUserId,
} from "../db";
import { sdk, sessionAuthVersion } from "./sdk";
import { isAdminMfaEnabled } from "./admin-mfa";
import {
  APP_ROOT,
  INTERNAL_BASE_URL,
  openClawAgentDir,
  resolveClawWorkspace,
  resolveRuntimeAgentId,
  resolveRuntimeWorkspaceByIds,
} from "./helpers";
import { JiuwenClawCronProvider } from "./cron/jiuwenclaw-cron-provider";
import type { CronProviderHandle } from "@shared/types/cron";
import { listMcpToolGroups } from "./claw-skills";
import {
  getFeishuStatus,
  pollFeishuBindStatus,
  startFeishuBindFlow,
  unbindFeishu,
} from "./claw-feishu";
import { skillRegistry } from "./skills/skill-registry";
import { parseSkillSourceDirectory } from "./skills/skill-source";
import { remapLegacySkillMarketPath } from "./skills/skill-store";
import type { SkillSource } from "../../shared/types/skill";
import { getAvailableClawModelsFromConfig } from "../routers/helpers";
import {
  desktopProtocolMetadata,
  resolveDesktopRuntimeType,
} from "./desktop-protocol";
import {
  listClawChatHistorySessionRecords,
  readModernChatHistorySessionMessages,
} from "./chat-history";
import { authLimiter } from "./security";

type DesktopUser = {
  id: string;
  name: string;
  email?: string | null;
  role?: string | null;
  accessLevel?: string | null;
};

type DesktopSessionSummary = {
  id: string;
  sessionKey: string;
  title: string;
  preview: string;
  searchText: string;
  startedAt: number;
  updatedAt: number;
  source: string;
  messageCount: number;
  model: string;
};

type DesktopHistoryItem =
  | { kind: "user"; id: number; content: string; timestamp: number }
  | { kind: "assistant"; id: number; content: string; timestamp: number };

type DesktopSkillItem = {
  id: string;
  name: string;
  description: string;
  category: string;
  path?: string;
  source?: string;
  marketId?: number;
  installed?: boolean;
};

type DesktopModelItem = {
  id: string;
  name: string;
  desc?: string;
  isDefault?: boolean;
};

type DesktopChannelStatus = {
  key: string;
  status: "connected" | "not_connected" | "not_configured" | "unsupported";
  label?: string;
  detail?: string;
};

function publicBaseUrl(req: express.Request): string {
  const proto =
    String(req.headers["x-forwarded-proto"] || "")
      .split(",")[0]
      .trim() ||
    req.protocol ||
    "http";
  const host = req.get("host") || `127.0.0.1:${process.env.PORT || "5000"}`;
  return `${proto}://${host}`;
}

function desktopToken(): string {
  return String(process.env.DESKTOP_GATEWAY_TOKEN || process.env.INTERNAL_API_KEY || "").trim();
}

async function toQrDataUrl(data: string): Promise<string> {
  try {
    return await QRCode.toDataURL(data, { width: 200, margin: 1 });
  } catch {
    return "";
  }
}

function defaultDesktopAgentId(): string | null {
  const configured = String(process.env.DESKTOP_OPENCLAW_AGENT_ID || "").trim();
  return configured || null;
}

function defaultDesktopAdoptId(): string | null {
  return defaultDesktopAgentId()?.replace(/^trial_/, "") || null;
}

// Returns the claw record assigned to the desktop user.
// For numeric user IDs, queries the DB for the user's active adoption.
// Falls back to the global default agent for the MVP token user.
async function getDesktopUserClaw(user: DesktopUser) {
  let claw = null;
  if (user.id === "desktop-mvp-user") {
    const adoptId = defaultDesktopAdoptId();
    claw = adoptId ? await getClawByAdoptId(adoptId) : null;
  } else {
    const uid = Number(user.id);
    if (!Number.isNaN(uid) && uid > 0) {
      const adoptions = await listClawsByUserId(uid);
      claw = adoptions.find((item) => resolveDesktopRuntimeType(item.adoptId) === "jiuwenswarm") || null;
    }
  }
  return claw && resolveDesktopRuntimeType(claw.adoptId) === "jiuwenswarm"
    ? claw
    : null;
}

async function listDesktopChannels(adoptId: string): Promise<{ channels: DesktopChannelStatus[] }> {
  const feishu = await getFeishuStatus(adoptId);

  return {
    channels: [
      {
        key: "weixin",
        status: "unsupported",
        label: "微信",
        detail: "当前 JiuwenSwarm 桌面协议暂未接入",
      },
      {
        key: "feishu",
        status: feishu.bound ? "connected" : "not_connected",
        label: feishu.domain === "lark" ? "Lark" : "飞书",
        detail: feishu.targetLabel || "",
      },
      {
        key: "wecom",
        status: "unsupported",
        label: "企业微信",
        detail: "桌面端暂未接入",
      },
      {
        key: "dingtalk",
        status: "unsupported",
        label: "钉钉",
        detail: "桌面端暂未接入",
      },
      {
        key: "qqbot",
        status: "unsupported",
        label: "QQ Bot",
        detail: "桌面端暂未接入",
      },
    ],
  };
}

function bearerToken(req: express.Request): string {
  const auth = String(req.headers.authorization || "");
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

async function verifyDesktopToken(token: string): Promise<DesktopUser | null> {
  if (!token) return null;

  // Backward-compatible MVP token for local smoke tests only. Production must
  // configure DESKTOP_GATEWAY_TOKEN or use /api/desktop/login sessions.
  const configuredToken = desktopToken();
  if (configuredToken && token === configuredToken) {
    return { id: "desktop-mvp-user", name: "Desktop MVP User" };
  }

  const session = await sdk.verifySession(token);
  if (!session?.userId) return null;
  const user = await getUserById(session.userId);
  if (!user) return null;
  return {
    id: String(user.id),
    name: user.name || user.email || session.name || "用户",
    email: user.email,
    role: user.role,
    accessLevel: (user as any).accessLevel || "public_only",
  };
}

function normalizeText(value: unknown): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function preserveMarkdownText(value: unknown): string {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function truncateText(value: unknown, max = 48): string {
  const text = normalizeText(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function parseSkillMarkdownMeta(text: string): {
  name?: string;
  description?: string;
  category?: string;
} {
  const raw = String(text || "");
  const frontmatter = raw.match(/^---\s*[\r\n]+([\s\S]*?)[\r\n]+---/);
  const block = frontmatter?.[1] || "";
  const pick = (key: string) => {
    const match = block.match(
      new RegExp(`^${key}:\\s*['"]?([^'"\\n]+)['"]?`, "im")
    );
    return match?.[1]?.trim();
  };
  const firstHeading = raw.match(/^\s*#\s+(.+)$/m)?.[1]?.trim();
  return {
    name: pick("name") || firstHeading,
    description: pick("description"),
    category: pick("category"),
  };
}

function readSkillItemFromDir(skillId: string, dir: string): DesktopSkillItem {
  const mdPath = path.join(dir, "SKILL.md");
  let meta: ReturnType<typeof parseSkillMarkdownMeta> = {};
  try {
    if (existsSync(mdPath)) {
      const stat = statSync(mdPath);
      if (stat.isFile() && stat.size < 256 * 1024) {
        meta = parseSkillMarkdownMeta(readFileSync(mdPath, "utf8"));
      }
    }
  } catch {
    meta = {};
  }
  return {
    id: skillId,
    name: meta.name || skillId,
    description: meta.description || "已安装在当前智能体下的技能。",
    category: meta.category || "已安装",
    path: dir,
    source: "installed",
    installed: true,
  };
}

function listDesktopInstalledSkills(adoptId: string, agentId: string): DesktopSkillItem[] {
  const skillsDir = path.join(
    resolveRuntimeWorkspaceByIds(adoptId, agentId),
    "skills"
  );
  if (!existsSync(skillsDir)) return [];
  const items: DesktopSkillItem[] = [];
  try {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillDir = path.join(skillsDir, entry.name);
      items.push(readSkillItemFromDir(entry.name, skillDir));
    }
  } catch {
    return [];
  }
  return items.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function readDesktopSkillContent(skillId: string, adoptId: string, agentId: string): string {
  const skillsDir = path.join(
    resolveRuntimeWorkspaceByIds(adoptId, agentId),
    "skills"
  );
  const safeId = String(skillId || "").trim();
  if (!/^[a-zA-Z0-9._-]{1,96}$/.test(safeId)) return "";
  const mdPath = path.resolve(path.join(skillsDir, safeId, "SKILL.md"));
  const root = path.resolve(skillsDir);
  if (!mdPath.startsWith(root + path.sep) || !existsSync(mdPath)) return "";
  const stat = statSync(mdPath);
  if (!stat.isFile() || stat.size > 256 * 1024) return "";
  return readFileSync(mdPath, "utf8");
}

function readDesktopModelOverride(adoptId: string): string {
  try {
    const overridesPath = path.join(
      APP_ROOT,
      "data",
      "claw-model-overrides.json"
    );
    const raw = existsSync(overridesPath)
      ? JSON.parse(readFileSync(overridesPath, "utf8") || "{}")
      : {};
    return String(raw?.[adoptId] || "").trim();
  } catch {
    return "";
  }
}

function writeDesktopModelOverride(adoptId: string, modelId: string): void {
  const overridesPath = path.join(
    APP_ROOT,
    "data",
    "claw-model-overrides.json"
  );
  let raw: Record<string, string> = {};
  try {
    raw = existsSync(overridesPath)
      ? JSON.parse(readFileSync(overridesPath, "utf8") || "{}")
      : {};
  } catch {
    raw = {};
  }
  raw[adoptId] = modelId;
  mkdirSync(path.dirname(overridesPath), { recursive: true });
  writeFileSync(overridesPath, JSON.stringify(raw, null, 2), "utf8");
}

function listDesktopModels(adoptId: string): {
  selected: string;
  defaultModel: string;
  models: DesktopModelItem[];
} {
  const models = getAvailableClawModelsFromConfig();
  const defaultModel =
    models.find(model => model.isDefault)?.id || models[0]?.id || "";
  const override = readDesktopModelOverride(adoptId);
  const modelIds = new Set(models.map(model => model.id));
  const selected = override && modelIds.has(override) ? override : defaultModel;
  return { selected, defaultModel, models };
}

async function listDesktopModelsForClaw(
  claw: NonNullable<Awaited<ReturnType<typeof getDesktopUserClaw>>>
): Promise<{ selected: string; defaultModel: string; models: DesktopModelItem[] }> {
  if (resolveDesktopRuntimeType(claw.adoptId) !== "jiuwenswarm") {
    return listDesktopModels(claw.adoptId);
  }
  const {
    JIUWEN_AUTO_MODEL_ID,
    listSelectableJiuwenModels,
  } = await import("./jiuwenswarm-model-admin");
  const runtimeModels = await listSelectableJiuwenModels();
  const models: DesktopModelItem[] = [
    {
      id: JIUWEN_AUTO_MODEL_ID,
      name: "自动",
      desc: "由平台自动选择可用模型",
      isDefault: true,
    },
    ...runtimeModels.map(model => ({
      id: model.id,
      name: model.name,
      desc: model.description,
      isDefault: false,
    })),
  ];
  const override = readDesktopModelOverride(claw.adoptId);
  const modelIds = new Set(models.map(model => model.id));
  const selected = override && modelIds.has(override)
    ? override
    : JIUWEN_AUTO_MODEL_ID;
  return {
    selected,
    defaultModel: JIUWEN_AUTO_MODEL_ID,
    models,
  };
}

async function listDesktopMarketSkills(adoptId: string, agentId: string): Promise<DesktopSkillItem[]> {
  const installed = new Set(listDesktopInstalledSkills(adoptId, agentId).map(item => item.id));
  const rows = await listApprovedSkillMarketItems();
  return rows.map((row: any) => {
    const id = String(row.skillId || row.id || "").trim();
    return {
      id,
      marketId: Number(row.id),
      name: String(row.name || row.title || row.skillId || `技能 ${row.id}`),
      description: String(row.description || "技能市场上架技能。"),
      category: String(row.category || "技能市场"),
      source: "market",
      installed: installed.has(id),
    };
  });
}

async function installDesktopMarketSkill(marketId: number, adoptId: string, agentId: string): Promise<{
  ok: boolean;
  skillId: string;
  name: string;
}> {
  const runtimeAgentId = agentId;
  const item = await getSkillMarketItem(marketId);
  if (!item || item.status !== "approved") {
    throw new Error("技能不存在或未上架");
  }
  const packagePath = remapLegacySkillMarketPath(String(item.packagePath || ""));
  if (!packagePath || !existsSync(packagePath)) {
    throw new Error("技能包源不存在");
  }

  const parsed = parseSkillSourceDirectory(
    packagePath,
    item.skillId || item.name || "market-skill"
  );
  const source: SkillSource = {
    kind: "marketplace",
    skillId: parsed.skillId || item.skillId,
    displayName: item.name || parsed.displayName || item.skillId,
    description: item.description || parsed.description || "",
    sourcePath: packagePath,
    marketplaceId: String(item.id),
    version: String(item.version || parsed.manifest?.version || "1.0.0"),
  };
  const installed = await skillRegistry.install(adoptId, source);
  if (!installed.ok) {
    throw new Error(installed.error.detail);
  }
  await skillRegistry.updateScan(adoptId, source.skillId, {
    warnings: parsed.warnings,
    scannedAt: new Date().toISOString(),
  });
  await incrementSkillDownload(marketId);
  return {
    ok: true,
    skillId: source.skillId,
    name: source.displayName || source.skillId,
  };
}

function toUnixSeconds(value: unknown): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed / 1000);
  }
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return Math.floor(Date.now() / 1000);
  return n > 10_000_000_000 ? Math.floor(n / 1000) : Math.floor(n);
}

function textFromOpenClawContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(item => textFromOpenClawContent(item))
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const obj = content as Record<string, unknown>;
    const type = String(obj.type || "");
    if (type === "tool_use" || type === "tool_result") return "";
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
    if (Array.isArray(obj.content)) return textFromOpenClawContent(obj.content);
    if (typeof obj.output_text === "string") return obj.output_text;
  }
  return "";
}

function parseDesktopSessionKey(
  sessionKey: string,
  runtimeAgentId: string
): { id: string; channel: string } | null {
  const parts = String(sessionKey || "").split(":");
  if (parts[0] !== "agent" || parts[1] !== runtimeAgentId) return null;
  const channel = parts[2] || "";
  if (channel !== "main" && channel !== "web") return null;
  const id = parts[3] || "";
  if (!id) return null;
  return { id, channel };
}

function safeSessionFile(sessionsDir: string, raw: any): string | null {
  const sessionId = String(raw?.sessionId || "").trim();
  const fallback = sessionId
    ? path.join(sessionsDir, `${sessionId}.jsonl`)
    : "";
  const candidate = String(raw?.sessionFile || fallback || "").trim();
  if (!candidate) return null;
  const root = path.resolve(sessionsDir);
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(root + path.sep)) return null;
  return existsSync(resolved) ? resolved : null;
}

function readDesktopSessionMessagesFromFile(
  sessionFile: string
): DesktopHistoryItem[] {
  const items: DesktopHistoryItem[] = [];
  if (!sessionFile || !existsSync(sessionFile)) return items;
  const lines = readFileSync(sessionFile, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "message") continue;
    const role = String(event?.message?.role || "");
    if (role !== "user" && role !== "assistant") continue;
    const content = preserveMarkdownText(
      textFromOpenClawContent(event?.message?.content)
    );
    if (!content) continue;
    const timestamp = toUnixSeconds(
      event?.message?.timestamp || event?.timestamp
    );
    items.push({
      kind: role === "user" ? "user" : "assistant",
      id: items.length + 1,
      content,
      timestamp,
    });
  }
  return items;
}

function readDesktopSessions(agentId: string, limit = 50): DesktopSessionSummary[] {
  const runtimeAgentId = agentId;
  const sessionsDir = path.join(openClawAgentDir(runtimeAgentId), "sessions");
  const sessionsPath = path.join(sessionsDir, "sessions.json");
  if (!existsSync(sessionsPath)) return [];

  let rawIndex: Record<string, any> = {};
  try {
    rawIndex = JSON.parse(readFileSync(sessionsPath, "utf8") || "{}") || {};
  } catch {
    return [];
  }

  const summaries: DesktopSessionSummary[] = [];
  for (const [sessionKey, raw] of Object.entries(rawIndex)) {
    const parsed = parseDesktopSessionKey(sessionKey, runtimeAgentId);
    if (!parsed) continue;
    const sessionFile = safeSessionFile(sessionsDir, raw);
    if (!sessionFile) continue;
    const messages = readDesktopSessionMessagesFromFile(sessionFile);
    if (messages.length === 0) continue;

    const firstUser = messages.find(item => item.kind === "user");
    const lastMessage = [...messages]
      .reverse()
      .find(item => normalizeText(item.content));
    const fileStats = statSync(sessionFile);
    const updatedAt = toUnixSeconds(
      raw?.updatedAt ||
        raw?.lastInteractionAt ||
        raw?.endedAt ||
        lastMessage?.timestamp ||
        fileStats.mtimeMs
    );
    const startedAt = toUnixSeconds(
      raw?.sessionStartedAt ||
        raw?.startedAt ||
        raw?.createdAt ||
        fileStats.birthtimeMs
    );
    summaries.push({
      id: parsed.id,
      sessionKey,
      title: truncateText(firstUser?.content, 50) || "新对话",
      preview: truncateText(lastMessage?.content, 80),
      searchText: normalizeText(
        messages.map(item => item.content).join(" ")
      ).slice(0, 12000),
      startedAt,
      updatedAt,
      source: parsed.channel === "main" ? "OpenClaw Desktop" : "OpenClaw Web",
      messageCount: messages.length,
      model: "openclaw",
    });
  }

  return summaries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

async function listDesktopSessionsForClaw(
  claw: NonNullable<Awaited<ReturnType<typeof getDesktopUserClaw>>>,
  limit: number
): Promise<DesktopSessionSummary[]> {
  if (resolveDesktopRuntimeType(claw.adoptId) !== "jiuwenswarm") {
    return readDesktopSessions(claw.agentId, limit);
  }

  const payload = await listClawChatHistorySessionRecords({
    adoptId: claw.adoptId,
    claw,
    limit: Math.min(Math.max(limit, 1), 100),
  });
  return (Array.isArray(payload.sessions) ? payload.sessions : [])
    .map((session: any): DesktopSessionSummary | null => {
      const sessionKey = String(
        session?.sessionKey || session?.sessionId || ""
      ).trim();
      if (!sessionKey) return null;
      return {
        id: sessionKey,
        sessionKey,
        title: normalizeText(session?.title) || "新对话",
        preview: normalizeText(session?.preview),
        searchText: normalizeText(session?.searchText),
        startedAt: toUnixSeconds(session?.createdAt),
        updatedAt: toUnixSeconds(session?.updatedAt),
        source: String(session?.runtime || "JiuwenSwarm Web"),
        messageCount: Number(session?.messageCount || 0),
        model: "jiuwenswarm",
      };
    })
    .filter((session): session is DesktopSessionSummary => Boolean(session));
}

function findDesktopSession(sessionIdOrKey: string, agentId: string): {
  summary: DesktopSessionSummary;
  sessionFile: string;
} | null {
  const runtimeAgentId = agentId;
  const sessionsDir = path.join(openClawAgentDir(runtimeAgentId), "sessions");
  const sessionsPath = path.join(sessionsDir, "sessions.json");
  if (!existsSync(sessionsPath)) return null;
  let rawIndex: Record<string, any> = {};
  try {
    rawIndex = JSON.parse(readFileSync(sessionsPath, "utf8") || "{}") || {};
  } catch {
    return null;
  }
  const wanted = String(sessionIdOrKey || "").trim();
  for (const [sessionKey, raw] of Object.entries(rawIndex)) {
    const parsed = parseDesktopSessionKey(sessionKey, runtimeAgentId);
    if (!parsed) continue;
    if (wanted !== sessionKey && wanted !== parsed.id) continue;
    const sessionFile = safeSessionFile(sessionsDir, raw);
    if (!sessionFile) return null;
    const summary = readDesktopSessions(agentId, 500).find(
      entry => entry.sessionKey === sessionKey
    );
    if (!summary) return null;
    return { summary, sessionFile };
  }
  return null;
}

async function readDesktopSessionMessagesForClaw(
  claw: NonNullable<Awaited<ReturnType<typeof getDesktopUserClaw>>>,
  sessionId: string
): Promise<{ summary: DesktopSessionSummary; messages: DesktopHistoryItem[] } | null> {
  if (resolveDesktopRuntimeType(claw.adoptId) !== "jiuwenswarm") {
    const found = findDesktopSession(sessionId, claw.agentId);
    if (!found) return null;
    return {
      summary: found.summary,
      messages: readDesktopSessionMessagesFromFile(found.sessionFile),
    };
  }

  const modern = await readModernChatHistorySessionMessages({
    adoptId: claw.adoptId,
    dbAgentId: claw.agentId,
    sessionKey: sessionId,
    workspaceDir: resolveRuntimeWorkspaceByIds(claw.adoptId, claw.agentId),
    maxMessages: 200,
  });
  if (!modern) return null;
  const sessions = await listDesktopSessionsForClaw(claw, 100);
  const summary = sessions.find(session => session.sessionKey === sessionId);
  if (!summary) return null;
  return {
    summary,
    messages: modern.messages.map((message, index) => ({
      kind: message.role,
      id: index + 1,
      content: preserveMarkdownText(message.text),
      timestamp: toUnixSeconds(message.timestamp),
    })),
  };
}

async function authenticateDesktopRequest(
  req: express.Request
): Promise<DesktopUser | null> {
  return verifyDesktopToken(bearerToken(req));
}

async function requireDesktopUser(
  req: express.Request,
  res: express.Response
): Promise<DesktopUser | null> {
  const user = await authenticateDesktopRequest(req);
  if (user) return user;
  res.status(401).json({ error: "Unauthorized" });
  return null;
}

function desktopChatMessage(body: unknown): string {
  const chatBody = body && typeof body === "object"
    ? body as { messages?: unknown }
    : {};
  const messages = Array.isArray(chatBody.messages) ? chatBody.messages : [];
  const userMessage = [...messages].reverse().find(message => message?.role === "user");
  const content = userMessage?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(part => part && typeof part === "object" && part.type === "text")
    .map(part => String(part.text || ""))
    .filter(Boolean)
    .join("\n");
}

async function forwardJiuwenDesktopChat(
  req: express.Request,
  res: express.Response
) {
  const user = await requireDesktopUser(req, res);
  if (!user) return;
  const claw = await getDesktopUserClaw(user);
  if (!claw) {
    res.status(404).json({ error: "no agent assigned" });
    return;
  }
  if (resolveDesktopRuntimeType(claw.adoptId) !== "jiuwenswarm") {
    res.status(409).json({ error: "desktop_runtime_mismatch" });
    return;
  }

  const message = desktopChatMessage(req.body).slice(0, 4000);
  if (!message.trim()) {
    res.status(400).json({ error: "message is empty" });
    return;
  }
  const requestedAgentId = String(req.headers["x-openclaw-agent-id"] || "").trim();
  if (requestedAgentId && requestedAgentId !== claw.agentId) {
    res.status(403).json({ error: "agent_not_allowed" });
    return;
  }

  const sessionKey = String(req.headers["x-openclaw-session-key"] || "").trim();
  const sessionLabel = sessionKey.split(":").pop() || `desktop_${Date.now().toString(36)}`;
  const conversationId = `desktop_${sessionLabel}`
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 96);
  const models = await listDesktopModelsForClaw(claw);
  const payload = JSON.stringify({
    adoptId: claw.adoptId,
    message,
    model: models.selected,
    channel: "web",
    conversationId,
    clientRunId: `desktop-${randomUUID()}`,
    runtimeMode: "fast",
  });
  const internalKey = String(process.env.INTERNAL_API_KEY || "").trim();
  if (!internalKey) {
    res.status(500).json({ error: "INTERNAL_API_KEY is not configured" });
    return;
  }

  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port: parseInt(process.env.PORT || "5180", 10),
      path: "/api/claw/chat-stream",
      method: "POST",
      timeout: 0,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "X-Internal-Key": internalKey,
      },
    },
    upstreamRes => {
      res.status(upstreamRes.statusCode || 502);
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value !== undefined) res.setHeader(key, value as string | string[]);
      }
      upstreamRes.pipe(res);
    }
  );
  upstream.on("error", error => {
    if (!res.headersSent) {
      res.status(502).json({ error: error.message || "Jiuwen desktop proxy failed" });
    } else {
      res.end();
    }
  });
  res.on("close", () => {
    if (!res.writableEnded) upstream.destroy();
  });
  upstream.write(payload);
  upstream.end();
}

// ── Desktop Memory ───────────────────────────────────────────────────────────

const DESKTOP_ENTRY_DELIMITER = "\n§\n";
const DESKTOP_MEMORY_CHAR_LIMIT = 2200;
const DESKTOP_USER_CHAR_LIMIT = 1375;

function desktopReadFile(p: string): { content: string; exists: boolean; lastModified: number | null } {
  if (!existsSync(p)) return { content: "", exists: false, lastModified: null };
  try {
    const content = readFileSync(p, "utf8");
    const stat = statSync(p);
    return { content, exists: true, lastModified: Math.floor(stat.mtimeMs / 1000) };
  } catch { return { content: "", exists: false, lastModified: null }; }
}
function desktopParseEntries(content: string): { index: number; content: string }[] {
  if (!content.trim()) return [];
  return content.split(DESKTOP_ENTRY_DELIMITER)
    .map((e, i) => ({ index: i, content: e.trim() }))
    .filter(e => e.content.length > 0);
}
function desktopSerializeEntries(entries: { index: number; content: string }[]): string {
  return entries.map(e => e.content).join(DESKTOP_ENTRY_DELIMITER);
}

// ── Desktop Cron ────────────────────────────────────────────────────────────

const desktopCronProvider = new JiuwenClawCronProvider();

function desktopCronHandle(claw: any): CronProviderHandle {
  const adoptId = String(claw.adoptId || "");
  return {
    adoptId,
    agentId: resolveRuntimeAgentId(adoptId, claw.agentId),
    userId: Number(claw.userId || 0),
    runtime: "jiuwenclaw",
  };
}

function parseDesktopScheduleStr(s: string): { kind: "interval" | "cron" | "once"; intervalMinutes?: number; cronExpr?: string; display: string } {
  const mMatch = s.trim().match(/^(\d+)m$/);
  if (mMatch) { const m = Number(mMatch[1]); return { kind: "interval", intervalMinutes: m, display: `每 ${m} 分钟` }; }
  const hMatch = s.trim().match(/^(\d+)h$/);
  if (hMatch) { const h = Number(hMatch[1]); return { kind: "interval", intervalMinutes: h * 60, display: `每 ${h} 小时` }; }
  return { kind: "cron", cronExpr: s.trim(), display: s.trim() };
}

function sharedJobToDesktopFmt(j: any): object {
  const stateMap: Record<string, "active" | "paused" | "completed"> = {
    scheduled: "active", running: "active", completed: "completed", paused: "paused", failed: "active",
  };
  const targets: any[] = j.delivery?.targets || [];
  const channelToDeliver: Record<string, string> = { wechat: "weixin", feishu: "feishu", wecom: "wecom" };
  const deliver = targets.map((t: any) => channelToDeliver[t.channelId] || t.channelId).filter(Boolean);
  return {
    id: j.id,
    name: j.name,
    schedule: j.schedule?.display || "",
    prompt: j.prompt || "",
    state: stateMap[j.state?.status || ""] || "active",
    enabled: Boolean(j.enabled),
    next_run_at: j.state?.nextRunAt || null,
    last_run_at: j.state?.lastRunAt || null,
    last_status: j.state?.lastStatus || null,
    last_error: null,
    repeat: null,
    deliver: deliver.length > 0 ? deliver : [],
    skills: Array.isArray(j.meta?.skills) ? j.meta.skills : [],
    script: (j.meta?.script as string) || null,
  };
}

// ── Desktop Cron Route Registration ─────────────────────────────────────────

export function registerDesktopRoutes(app: express.Express) {
  app.post("/api/desktop/login", authLimiter, express.json(), async (req, res) => {
    try {
      const email = String(req.body?.email || "")
        .trim()
        .toLowerCase();
      const password = String(req.body?.password || "");
      if (!email || !password) {
        res.status(400).json({ error: "Email and password are required" });
        return;
      }

      const user = await getUserByEmail(email);
      if (!user?.password) {
        res.status(401).json({ error: "邮箱或密码错误" });
        return;
      }
      const ok = await bcrypt.compare(password, user.password);
      if (!ok) {
        res.status(401).json({ error: "邮箱或密码错误" });
        return;
      }
      if (user.role === "admin" && await isAdminMfaEnabled(user.id)) {
        res.status(403).json({ error: "管理员账号需要在网页端完成二次验证" });
        return;
      }

      const accessToken = await sdk.signSession({
        userId: user.id,
        name: user.name || user.email || email,
        authVersion: sessionAuthVersion(user),
      });
      res.json({
        success: true,
        accessToken,
        user: {
          id: String(user.id),
          name: user.name || user.email || email,
          email: user.email,
          role: user.role,
          accessLevel: (user as any).accessLevel || "public_only",
        },
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Desktop login failed",
      });
    }
  });

  app.get("/api/desktop/bootstrap", async (req, res) => {
    const user = await requireDesktopUser(req, res);
    if (!user) return;
    const base = publicBaseUrl(req);
    const claw = await getDesktopUserClaw(user);
    const agentId = claw?.agentId || defaultDesktopAgentId();
    res.json({
      ...desktopProtocolMetadata(claw?.adoptId || defaultDesktopAdoptId()),
      mode: "mvp",
      user,
      gatewayUrl: `${base}/api/desktop/jiuwen`,
      gatewayWsUrl: "",
      gatewayToken: bearerToken(req),
      defaultAgentId: agentId,
      agents: agentId
        ? [
            {
              id: agentId,
              name: process.env.DESKTOP_OPENCLAW_AGENT_NAME || "岗位智能体",
              description: "Desktop gateway agent",
            },
          ]
        : [],
    });
  });

  app.get("/api/desktop/jiuwen/health", (_req, res) => {
    res.json({ status: "ok", mode: "desktop-jiuwen-proxy" });
  });

  app.get("/api/desktop/models", async (req, res) => {
    const user = await requireDesktopUser(req, res);
    if (!user) return;
    try {
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      res.json(await listDesktopModelsForClaw(claw));
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Desktop models failed",
      });
    }
  });

  app.post("/api/desktop/model-select", express.json(), async (req, res) => {
    const user = await requireDesktopUser(req, res);
    if (!user) return;
    try {
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      const modelId = String(req.body?.modelId || "").trim();
      const models = await listDesktopModelsForClaw(claw);
      if (!modelId || !models.models.some(model => model.id === modelId)) {
        res.status(400).json({ error: "Unsupported model" });
        return;
      }
      writeDesktopModelOverride(claw.adoptId, modelId);
      res.json({ ok: true, modelId });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Desktop model select failed",
      });
    }
  });

  app.get("/api/desktop/sessions", async (req, res) => {
    const user = await requireDesktopUser(req, res);
    if (!user) return;
    const limit = Math.min(
      Math.max(parseInt(String(req.query.limit || "50"), 10) || 50, 1),
      200
    );
    const query = normalizeText(req.query.q).toLowerCase();
    const claw = await getDesktopUserClaw(user);
    if (!claw) return res.status(404).json({ error: "no agent assigned" });
    const sessions = await listDesktopSessionsForClaw(
      claw,
      query ? 100 : limit
    );
    const filtered = query
      ? sessions.filter(session =>
          `${session.title} ${session.preview} ${session.searchText}`
            .toLowerCase()
            .includes(query)
        )
      : sessions;
    res.json({
      sessions: filtered.slice(0, limit),
    });
  });

  app.get("/api/desktop/session-messages", async (req, res) => {
    const user = await requireDesktopUser(req, res);
    if (!user) return;
    const sessionId = String(
      req.query.sessionId || req.query.sessionKey || ""
    ).trim();
    if (!sessionId) {
      res.status(400).json({ error: "sessionId required" });
      return;
    }
    const claw = await getDesktopUserClaw(user);
    if (!claw) return res.status(404).json({ error: "no agent assigned" });
    const found = await readDesktopSessionMessagesForClaw(claw, sessionId);
    if (!found) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    res.json({
      session: found.summary,
      messages: found.messages,
    });
  });

  app.get("/api/desktop/capabilities", async (req, res) => {
    const user = await requireDesktopUser(req, res);
    if (!user) return;
    try {
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      const [market, installed] = await Promise.all([
        listDesktopMarketSkills(claw.adoptId, claw.agentId),
        Promise.resolve(listDesktopInstalledSkills(claw.adoptId, claw.agentId)),
      ]);
      res.json({
        ...desktopProtocolMetadata(claw.adoptId),
        skills: {
          installed,
          market,
        },
        tools: listMcpToolGroups(),
        agents: [],
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Desktop capabilities failed",
      });
    }
  });

  app.get("/api/desktop/channels", async (req, res) => {
    const user = await requireDesktopUser(req, res);
    if (!user) return;
    try {
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      res.json(await listDesktopChannels(claw.adoptId));
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Desktop channel status failed",
      });
    }
  });

  app.post("/api/desktop/channels/feishu/begin", async (req, res) => {
    const user = await requireDesktopUser(req, res);
    if (!user) return;
    try {
      const result = await startFeishuBindFlow();
      if (!result.ok) return res.status(502).json({ error: result.error.detail });
      const qrDataUrl = await toQrDataUrl(result.value.qrCode);
      res.json({ ...result.value, qrDataUrl });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "feishu begin failed" });
    }
  });

  app.post("/api/desktop/channels/feishu/poll", async (req, res) => {
    const user = await requireDesktopUser(req, res);
    if (!user) return;
    try {
      const pollToken = String(req.body?.pollToken || "").trim();
      if (!pollToken) return res.status(400).json({ error: "pollToken required" });
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      const result = await pollFeishuBindStatus(claw.adoptId, Number(claw.userId), pollToken);
      if (!result.ok) return res.status(502).json({ error: result.error.detail });
      if (result.value.status === "confirmed") {
        return res.json({ status: "confirmed", targetLabel: result.value.bindHandle.targetLabel || "" });
      }
      res.json({ status: result.value.status, pollToken: (result.value as any).pollToken });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "feishu poll failed" });
    }
  });

  app.post("/api/desktop/channels/:key/unbind", async (req, res) => {
    const user = await requireDesktopUser(req, res);
    if (!user) return;
    const key = String(req.params.key || "").trim();
    try {
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      if (key === "feishu") {
        await unbindFeishu(claw.adoptId);
        return res.json({ ok: true });
      }
      return res.status(400).json({ error: "unsupported channel" });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "unbind failed" });
    }
  });

  app.get("/api/desktop/skill-content", async (req, res) => {
    const user = await requireDesktopUser(req, res);
    if (!user) return;
    const skillId = String(req.query.skillId || "").trim();
    if (!skillId) {
      res.status(400).json({ error: "skillId required" });
      return;
    }
    const claw = await getDesktopUserClaw(user);
    if (!claw) return res.status(404).json({ error: "no agent assigned" });
    res.type("text/plain").send(readDesktopSkillContent(skillId, claw.adoptId, claw.agentId));
  });

  app.post(
    "/api/desktop/skill-market/install",
    express.json(),
    async (req, res) => {
      const user = await requireDesktopUser(req, res);
      if (!user) return;
      try {
        const marketId = Number(req.body?.marketId || 0);
        if (!Number.isFinite(marketId) || marketId <= 0) {
          res.status(400).json({ error: "marketId required" });
          return;
        }
        const claw = await getDesktopUserClaw(user);
        if (!claw) return res.status(404).json({ error: "no agent assigned" });
        res.json(await installDesktopMarketSkill(marketId, claw.adoptId, claw.agentId));
      } catch (error) {
        res.status(500).json({
          error:
            error instanceof Error ? error.message : "Desktop install failed",
        });
      }
    }
  );

  app.post("/api/desktop/jiuwen/v1/chat/completions", forwardJiuwenDesktopChat);

  // ── Soul management for enterprise desktop mode ──────────────────────────

  app.get("/api/desktop/soul/read", async (req, res) => {
    const user = await requireDesktopUser(req, res); if (!user) return;
    try {
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      const workspace = resolveClawWorkspace(claw);
      const soulFile = desktopReadFile(`${workspace}/SOUL.md`);
      res.json({ content: soulFile.content, exists: soulFile.exists });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.post("/api/desktop/soul/write", express.json(), async (req, res) => {
    const user = await requireDesktopUser(req, res); if (!user) return;
    try {
      const content = String(req.body?.content || "");
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      const workspace = resolveClawWorkspace(claw);
      mkdirSync(workspace, { recursive: true });
      writeFileSync(`${workspace}/SOUL.md`, content, "utf8");
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Memory management for enterprise desktop mode ────────────────────────

  app.get("/api/desktop/memory/read", async (req, res) => {
    const user = await requireDesktopUser(req, res); if (!user) return;
    try {
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      const workspace = resolveClawWorkspace(claw);
      const memFile = desktopReadFile(`${workspace}/MEMORY.md`);
      const userFile = desktopReadFile(`${workspace}/USER.md`);
      res.json({
        memory: { ...memFile, entries: desktopParseEntries(memFile.content), charCount: memFile.content.length, charLimit: DESKTOP_MEMORY_CHAR_LIMIT },
        user: { ...userFile, charCount: userFile.content.length, charLimit: DESKTOP_USER_CHAR_LIMIT },
        stats: { totalSessions: 0, totalMessages: 0 },
      });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.post("/api/desktop/memory/entry/add", express.json(), async (req, res) => {
    const user = await requireDesktopUser(req, res); if (!user) return;
    try {
      const content = String(req.body?.content || "").trim();
      if (!content) return res.status(400).json({ error: "content required" });
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      const workspace = resolveClawWorkspace(claw);
      const memPath = `${workspace}/MEMORY.md`;
      const existing = desktopReadFile(memPath);
      const entries = desktopParseEntries(existing.content);
      const newContent = desktopSerializeEntries([...entries, { index: entries.length, content }]);
      if (newContent.length > DESKTOP_MEMORY_CHAR_LIMIT) return res.status(400).json({ error: `超出记忆上限 (${newContent.length}/${DESKTOP_MEMORY_CHAR_LIMIT} 字符)` });
      mkdirSync(workspace, { recursive: true });
      writeFileSync(memPath, newContent, "utf8");
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.post("/api/desktop/memory/entry/update", express.json(), async (req, res) => {
    const user = await requireDesktopUser(req, res); if (!user) return;
    try {
      const index = Number(req.body?.index ?? -1);
      const content = String(req.body?.content || "").trim();
      if (index < 0 || !content) return res.status(400).json({ error: "index and content required" });
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      const workspace = resolveClawWorkspace(claw);
      const memPath = `${workspace}/MEMORY.md`;
      const existing = desktopReadFile(memPath);
      const entries = desktopParseEntries(existing.content);
      if (index >= entries.length) return res.status(400).json({ error: "entry not found" });
      entries[index] = { ...entries[index], content };
      const newContent = desktopSerializeEntries(entries);
      if (newContent.length > DESKTOP_MEMORY_CHAR_LIMIT) return res.status(400).json({ error: "超出记忆上限" });
      writeFileSync(memPath, newContent, "utf8");
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.post("/api/desktop/memory/entry/remove", express.json(), async (req, res) => {
    const user = await requireDesktopUser(req, res); if (!user) return;
    try {
      const index = Number(req.body?.index ?? -1);
      if (index < 0) return res.status(400).json({ error: "index required" });
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      const workspace = resolveClawWorkspace(claw);
      const memPath = `${workspace}/MEMORY.md`;
      const existing = desktopReadFile(memPath);
      const entries = desktopParseEntries(existing.content);
      if (index >= entries.length) return res.status(400).json({ error: "entry not found" });
      entries.splice(index, 1);
      writeFileSync(memPath, desktopSerializeEntries(entries), "utf8");
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.post("/api/desktop/memory/profile", express.json(), async (req, res) => {
    const user = await requireDesktopUser(req, res); if (!user) return;
    try {
      const content = String(req.body?.content || "");
      if (content.length > DESKTOP_USER_CHAR_LIMIT) return res.status(400).json({ error: `超出上限 (${content.length}/${DESKTOP_USER_CHAR_LIMIT} 字符)` });
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      const workspace = resolveClawWorkspace(claw);
      mkdirSync(workspace, { recursive: true });
      writeFileSync(`${workspace}/USER.md`, content, "utf8");
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Cron management for enterprise desktop mode ──────────────────────────

  app.get("/api/desktop/cron/list", async (req, res) => {
    const user = await requireDesktopUser(req, res); if (!user) return;
    try {
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      const result = await desktopCronProvider.listJobs(desktopCronHandle(claw));
      if (!result.ok) return res.status(500).json({ error: result.error.detail });
      res.json({ jobs: result.value.map(sharedJobToDesktopFmt) });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.post("/api/desktop/cron/add", express.json(), async (req, res) => {
    const user = await requireDesktopUser(req, res); if (!user) return;
    try {
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      const { schedule: schedStr, prompt, name, deliver } = req.body || {};
      const schedule = parseDesktopScheduleStr(String(schedStr || "30m"));
      const deliverKey = String(deliver || "").toLowerCase();
      const channelMap: Record<string, string> = { weixin: "wechat", feishu: "feishu", wecom: "wecom" };
      const channelId = (channelMap[deliverKey] || "wechat") as any;
      const channelLabel = channelId === "wechat" ? "微信" : channelId === "feishu" ? "飞书" : deliverKey;
      const input: any = {
        name: String(name || "定时任务").trim() || "定时任务",
        prompt: String(prompt || ""),
        schedule,
        delivery: { targets: [{ channelId, channelLabel }] },
        enabled: true,
        meta: { sessionTarget: "isolated" },
      };
      const result = await desktopCronProvider.addJob(desktopCronHandle(claw), input);
      if (!result.ok) return res.status(400).json({ error: result.error.detail });
      res.json({ job: sharedJobToDesktopFmt(result.value) });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.post("/api/desktop/cron/remove", express.json(), async (req, res) => {
    const user = await requireDesktopUser(req, res); if (!user) return;
    try {
      const id = String(req.body?.id || "").trim();
      if (!id) return res.status(400).json({ error: "id required" });
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      const result = await desktopCronProvider.removeJob(desktopCronHandle(claw), id);
      if (!result.ok) return res.status(500).json({ error: result.error.detail });
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.post("/api/desktop/cron/pause", express.json(), async (req, res) => {
    const user = await requireDesktopUser(req, res); if (!user) return;
    try {
      const id = String(req.body?.id || "").trim();
      if (!id) return res.status(400).json({ error: "id required" });
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      const result = await desktopCronProvider.updateJob(desktopCronHandle(claw), id, { enabled: false });
      if (!result.ok) return res.status(500).json({ error: result.error.detail });
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.post("/api/desktop/cron/resume", express.json(), async (req, res) => {
    const user = await requireDesktopUser(req, res); if (!user) return;
    try {
      const id = String(req.body?.id || "").trim();
      if (!id) return res.status(400).json({ error: "id required" });
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      const result = await desktopCronProvider.updateJob(desktopCronHandle(claw), id, { enabled: true });
      if (!result.ok) return res.status(500).json({ error: result.error.detail });
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.post("/api/desktop/cron/trigger", express.json(), async (req, res) => {
    const user = await requireDesktopUser(req, res); if (!user) return;
    try {
      const id = String(req.body?.id || "").trim();
      if (!id) return res.status(400).json({ error: "id required" });
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      const result = await desktopCronProvider.runJobNow(desktopCronHandle(claw), id);
      if (!result.ok) return res.status(500).json({ error: result.error.detail });
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // Files
  const DESKTOP_FILES_MAX_LIST_DEPTH = 4;
  const DESKTOP_FILES_MAX_ENTRIES = 2000;
  const DESKTOP_FILES_MAX_READ_BYTES = 10 * 1024 * 1024;
  const DESKTOP_FILES_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
  const DESKTOP_FILES_PROTECTED = new Set([
    "AGENT.md","AGENTS.md","SOUL.md","TOOLS.md","MEMORY.md",
    "IDENTITY.md","HEARTBEAT.md","USER.md",
  ]);
  const DESKTOP_FILES_ALLOWED_EXT = new Set([
    "md","txt","csv","json","yaml","yml","xml","toml","ini","conf","log",
    "pdf","docx","xls","xlsx","pptx","png","jpg","jpeg","gif","svg","webp",
    "html","htm","css","zip","tar","gz","mp3","wav","m4a","aac","webm","ogg","mp4",
  ]);

  // Lexical pre-check — fast rejection of obvious traversal attempts.
  function desktopFilesLexCheck(workspace: string, relPath: string): string | null {
    if (!relPath) return workspace;
    if (relPath.startsWith("/") || relPath.includes("\0") || relPath.includes("..")) return null;
    const abs = path.normalize(path.join(workspace, relPath));
    if (!abs.startsWith(workspace + path.sep) && abs !== workspace) return null;
    return abs;
  }

  // For read/list/download: resolve symlinks and verify the real path is inside workspace.
  function desktopFilesSafeExisting(workspace: string, relPath: string): string | null {
    const lexAbs = desktopFilesLexCheck(workspace, relPath);
    if (!lexAbs) return null;
    try {
      const real = realpathSync(lexAbs);
      const realWs = realpathSync(workspace);
      if (real !== realWs && !real.startsWith(realWs + path.sep)) return null;
      return real;
    } catch {
      return null;
    }
  }

  // For upload: file may not exist yet — resolve the parent dir after mkdirSync,
  // verify it's inside workspace, then return the final write path.
  function desktopFilesSafeUpload(workspace: string, targetRel: string): string | null {
    const lexAbs = desktopFilesLexCheck(workspace, targetRel);
    if (!lexAbs) return null;
    try {
      const realWs = realpathSync(workspace);
      const parentAbs = path.dirname(lexAbs);
      mkdirSync(parentAbs, { recursive: true });
      const realParent = realpathSync(parentAbs);
      if (realParent !== realWs && !realParent.startsWith(realWs + path.sep)) return null;
      return path.join(realParent, path.basename(lexAbs));
    } catch {
      return null;
    }
  }

  function desktopFilesListDir(workspace: string, subPath = ""): { name: string; path: string; type: "file" | "directory"; size?: number; modifiedAt: string }[] {
    if (!existsSync(workspace)) return [];
    // Use lexical check for list root — walk verifies each child via statSync (no symlink follow)
    const startAbs = desktopFilesLexCheck(workspace, subPath) ?? workspace;
    const out: { name: string; path: string; type: "file" | "directory"; size?: number; modifiedAt: string }[] = [];
    const realWs = (() => { try { return realpathSync(workspace); } catch { return workspace; } })();
    function walk(absPath: string, relPath: string, depth: number) {
      if (depth > DESKTOP_FILES_MAX_LIST_DEPTH || out.length >= DESKTOP_FILES_MAX_ENTRIES) return;
      let entries: string[];
      try { entries = readdirSync(absPath); } catch { return; }
      for (const name of entries) {
        if (out.length >= DESKTOP_FILES_MAX_ENTRIES) break;
        if (name.startsWith(".")) continue;
        const childAbs = path.join(absPath, name);
        const childRel = relPath ? `${relPath}/${name}` : name;
        let st;
        try { st = statSync(childAbs, { bigint: false }); } catch { continue; }
        // Skip symlinks that escape workspace
        try {
          const real = realpathSync(childAbs);
          if (real !== realWs && !real.startsWith(realWs + path.sep)) continue;
        } catch { continue; }
        out.push({ name, path: childRel, type: st.isDirectory() ? "directory" : "file", size: st.isDirectory() ? undefined : Number(st.size), modifiedAt: st.mtime.toISOString() });
        if (st.isDirectory()) walk(childAbs, childRel, depth + 1);
      }
    }
    walk(startAbs, subPath, 0);
    return out;
  }

  app.get("/api/desktop/files/list", async (req, res) => {
    const user = await requireDesktopUser(req, res); if (!user) return;
    try {
      const subPath = String(req.query.path || "").trim();
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      const workspace = resolveClawWorkspace(claw);
      const files = desktopFilesListDir(workspace, subPath);
      res.json({ files, protectedFiles: Array.from(DESKTOP_FILES_PROTECTED) });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.get("/api/desktop/files/read", async (req, res) => {
    const user = await requireDesktopUser(req, res); if (!user) return;
    try {
      const relPath = String(req.query.path || "").trim();
      if (!relPath) return res.status(400).json({ error: "path required" });
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      const workspace = resolveClawWorkspace(claw);
      const abs = desktopFilesSafeExisting(workspace, relPath);
      if (!abs) return res.status(404).json({ error: "file not found" });
      const st = statSync(abs);
      if (!st.isFile()) return res.status(400).json({ error: "not a file" });
      if (st.size > DESKTOP_FILES_MAX_READ_BYTES) return res.status(413).json({ error: "file too large to preview" });
      const content = readFileSync(abs, "utf8");
      res.json({ path: relPath, content, size: Number(st.size), modifiedAt: st.mtime.toISOString() });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.get("/api/desktop/files/download", async (req, res) => {
    const user = await requireDesktopUser(req, res); if (!user) return;
    try {
      const relPath = String(req.query.path || "").trim();
      if (!relPath) return res.status(400).json({ error: "path required" });
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      const workspace = resolveClawWorkspace(claw);
      const abs = desktopFilesSafeExisting(workspace, relPath);
      if (!abs || !statSync(abs).isFile()) return res.status(404).json({ error: "file not found" });
      const filename = path.basename(abs);
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
      res.setHeader("Content-Type", "application/octet-stream");
      createReadStream(abs).pipe(res);
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.post("/api/desktop/files/upload", express.json({ limit: "55mb" }), async (req, res) => {
    const user = await requireDesktopUser(req, res); if (!user) return;
    try {
      const body = (req.body || {}) as any;
      const subPath = String(body.path || "").trim();
      const filenameRaw = String(body.filename || "").trim();
      const contentBase64 = String(body.contentBase64 || "");
      if (!filenameRaw || !contentBase64) return res.status(400).json({ error: "filename and contentBase64 required" });
      const filename = filenameRaw.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\.+/g, "_").replace(/^\.+/, "_").slice(0, 200);
      if (!filename) return res.status(400).json({ error: "invalid filename" });
      // Block protected system files unconditionally — use dedicated endpoints for soul/memory
      if (!subPath && DESKTOP_FILES_PROTECTED.has(filename)) return res.status(403).json({ error: "protected_file" });
      const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase() : "";
      if (!DESKTOP_FILES_ALLOWED_EXT.has(ext)) return res.status(400).json({ error: `file type .${ext} not allowed` });
      const buf = decodeBase64Strict(contentBase64);
      if (!buf) return res.status(400).json({ error: "invalid base64" });
      if (buf.length > DESKTOP_FILES_MAX_UPLOAD_BYTES) return res.status(413).json({ error: "file too large" });
      const contentValidation = validateUploadContent(ext, buf);
      if (!contentValidation.ok) return res.status(400).json({ error: "file_content_not_allowed", message: contentValidation.error });
      const malwareScan = await scanUploadForMalware(buf);
      if (!malwareScan.ok) return res.status(400).json({ error: "file_malware_scan_failed", message: malwareScan.error });
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      const workspace = resolveClawWorkspace(claw);
      const targetRel = subPath ? `${subPath}/${filename}` : filename;
      // desktopFilesSafeUpload creates parent dirs and verifies via realpathSync
      const abs = desktopFilesSafeUpload(workspace, targetRel);
      if (!abs) return res.status(400).json({ error: "path_not_allowed" });
      // Final protected-file check on the resolved basename (covers subPath tricks)
      if (DESKTOP_FILES_PROTECTED.has(path.basename(abs))) return res.status(403).json({ error: "protected_file" });
      writeFileSync(abs, buf);
      res.json({ ok: true, path: targetRel, size: buf.length });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.delete("/api/desktop/files/delete", async (req, res) => {
    const user = await requireDesktopUser(req, res); if (!user) return;
    try {
      const relPath = String(req.query.path || "").trim();
      if (!relPath) return res.status(400).json({ error: "path required" });
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      const workspace = resolveClawWorkspace(claw);
      const abs = desktopFilesSafeExisting(workspace, relPath);
      if (!abs) return res.status(404).json({ error: "not found" });
      if (DESKTOP_FILES_PROTECTED.has(path.basename(abs))) return res.status(403).json({ error: "protected_file" });
      rmSync(abs, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });
}
