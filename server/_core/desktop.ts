import express from "express";
import { decodeBase64Strict, scanUploadForMalware, validateUploadContent } from "./upload-security";
import QRCode from "qrcode";
import http from "http";
import type { IncomingMessage, Server } from "http";
import bcrypt from "bcryptjs";
import path from "path";
import { createHash, generateKeyPairSync, randomUUID, sign } from "crypto";
import { WebSocket, WebSocketServer } from "ws";
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
  getCurrentClawByUserId,
  getSkillMarketItem,
  getUserByEmail,
  getUserById,
  incrementSkillDownload,
  listApprovedSkillMarketItems,
} from "../db";
import { sdk, sessionAuthVersion } from "./sdk";
import {
  APP_ROOT,
  bumpSessionEpoch,
  INTERNAL_BASE_URL,
  openClawAgentDir,
  resolveClawWorkspace,
  resolveRuntimeAgentId,
  resolveRuntimeWorkspaceByIds,
} from "./helpers";
import { OpenClawCronProvider } from "./cron/openclaw-cron-provider";
import type { CronProviderHandle } from "@shared/types/cron";
import { normalizeWsEvent } from "./runtime";
import { buildRuntimeUserMessage } from "./tool_schema";
import { listMcpToolGroups } from "./claw-skills";
import {
  getFeishuStatus,
  pollFeishuBindStatus,
  startFeishuBindFlow,
  unbindFeishu,
} from "./claw-feishu";
import {
  cleanupOpenClawWeixinBindingForAdopt,
  desktopPollWeixinBind,
  desktopStartWeixinBind,
  getWeixinStatus,
} from "./claw-weixin";
import { skillRegistry } from "./skills/skill-registry";
import { parseSkillSourceDirectory } from "./skills/skill-source";
import { remapLegacySkillMarketPath } from "./skills/skill-store";
import type { SkillSource } from "../../shared/types/skill";
import { getAvailableClawModelsFromConfig } from "../routers/helpers";

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

const ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const { publicKey: DESKTOP_WS_PUB, privateKey: DESKTOP_WS_PRIV } =
  generateKeyPairSync("ed25519");
const DESKTOP_WS_SPKI = DESKTOP_WS_PUB.export({ type: "spki", format: "der" });
const DESKTOP_WS_RAW_PUB = DESKTOP_WS_SPKI.subarray(ED25519_PREFIX.length);
const b64u = (buffer: Buffer) =>
  buffer
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
const DESKTOP_WS_DEV_PUB = b64u(DESKTOP_WS_RAW_PUB);
const DESKTOP_WS_DEV_ID = createHash("sha256")
  .update(DESKTOP_WS_RAW_PUB)
  .digest("hex");
const DESKTOP_WS_SCOPES = ["operator.admin", "operator.read", "operator.write"];

function signDesktopGatewayPayload(nonce: string, gatewayToken: string) {
  const signedAt = Date.now();
  const payload = [
    "v2",
    DESKTOP_WS_DEV_ID,
    "openclaw-control-ui",
    "ui",
    "operator",
    DESKTOP_WS_SCOPES.join(","),
    String(signedAt),
    gatewayToken,
    nonce,
  ].join("|");
  return {
    sig: b64u(sign(null, Buffer.from(payload, "utf8"), DESKTOP_WS_PRIV)),
    signedAt,
  };
}

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

function publicWsBaseUrl(req: express.Request): string {
  const base = publicBaseUrl(req);
  if (base.startsWith("https://")) return `wss://${base.slice("https://".length)}`;
  if (base.startsWith("http://")) return `ws://${base.slice("http://".length)}`;
  return base;
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
  if (user.id === "desktop-mvp-user") {
    const adoptId = defaultDesktopAdoptId();
    return adoptId ? getClawByAdoptId(adoptId) : null;
  }
  const uid = Number(user.id);
  if (!Number.isNaN(uid) && uid > 0) {
    return getCurrentClawByUserId(uid);
  }
  return null;
}

async function listDesktopChannels(adoptId: string): Promise<{ channels: DesktopChannelStatus[] }> {
  const weixin = getWeixinStatus(adoptId);
  const feishu = await getFeishuStatus(adoptId);

  return {
    channels: [
      {
        key: "weixin",
        status: weixin.bound ? "connected" : "not_connected",
        label: "微信",
        detail: weixin.targetLabel || weixin.userId || weixin.accountId || "",
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

function bearerTokenFromIncoming(req: IncomingMessage, url: URL): string {
  const auth = String(req.headers.authorization || "");
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return (
    match?.[1]?.trim() ||
    url.searchParams.get("access_token") ||
    url.searchParams.get("token") ||
    ""
  ).trim();
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
  bumpSessionEpoch(adoptId);
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

async function forwardOpenClawChat(
  req: express.Request,
  res: express.Response
) {
  const user = await requireDesktopUser(req, res);
  if (!user) return;

  const gatewayToken = process.env.CLAW_GATEWAY_TOKEN || "";
  if (!gatewayToken) {
    res.status(500).json({ error: "CLAW_GATEWAY_TOKEN is not configured" });
    return;
  }

  const claw = await getDesktopUserClaw(user);
  if (!claw) {
    res.status(404).json({ error: "no agent assigned" });
    return;
  }
  const body = JSON.stringify(req.body || {});
  const requestedAgentId = String(req.headers["x-openclaw-agent-id"] || "").trim();
  if (requestedAgentId && requestedAgentId !== claw.agentId) {
    res.status(403).json({ error: "agent_not_allowed" });
    return;
  }
  const runtimeAgentId =
    requestedAgentId || claw.agentId;
  const sessionKey =
    String(req.headers["x-openclaw-session-key"] || "").trim() ||
    `agent:${runtimeAgentId}:main:desktop`;
  const models = listDesktopModels(claw.adoptId);
  const allowedModelIds = new Set(models.models.map(model => model.id));
  const requestedModel = String(req.headers["x-openclaw-model"] || "").trim();
  const backendModel =
    requestedModel && allowedModelIds.has(requestedModel)
      ? requestedModel
      : models.selected;

  const upstream = http.request(
    {
      hostname: process.env.CLAW_REMOTE_HOST || "127.0.0.1",
      port: parseInt(process.env.CLAW_GATEWAY_PORT || "18789", 10),
      path: "/v1/chat/completions",
      method: "POST",
      timeout: 0,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: `Bearer ${gatewayToken}`,
        "x-openclaw-agent-id": runtimeAgentId,
        "x-openclaw-session-key": sessionKey,
        ...(backendModel ? { "x-openclaw-model": backendModel } : {}),
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

  upstream.on("error", err => {
    if (!res.headersSent) {
      res.status(502).json({ error: err.message || "OpenClaw proxy failed" });
    } else {
      res.end();
    }
  });

  res.on("close", () => {
    if (!res.writableEnded) upstream.destroy();
  });
  upstream.write(body);
  upstream.end();
}

export function registerDesktopWSProxy(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname !== "/api/desktop/openclaw/ws") return;

    try {
      const user = await verifyDesktopToken(bearerTokenFromIncoming(req, url));
      if (!user) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      const claw = await getDesktopUserClaw(user);
      if (!claw) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      const requestedAgentId = String(url.searchParams.get("agentId") || "").trim();
      if (requestedAgentId && requestedAgentId !== claw.agentId) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      const agentId = requestedAgentId || claw.agentId;

      wss.handleUpgrade(req, socket, head, ws => {
        wss.emit("connection", ws, req, {
          user,
          agentId,
          adoptId: claw.adoptId,
          sessionKey: String(url.searchParams.get("sessionKey") || "").trim(),
        });
      });
    } catch (error) {
      console.error("[DESKTOP-WS] upgrade error:", error);
      socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      socket.destroy();
    }
  });

  wss.on(
    "connection",
    (
      client: WebSocket,
      _req: IncomingMessage,
      meta: { user: DesktopUser; agentId: string; adoptId: string; sessionKey?: string }
    ) => {
      const gatewayToken = process.env.CLAW_GATEWAY_TOKEN || "";
      if (!gatewayToken) {
        client.send(
          JSON.stringify({
            type: "error",
            message: "CLAW_GATEWAY_TOKEN is not configured",
          })
        );
        client.close();
        return;
      }

      const gatewayUrl = `ws://${process.env.CLAW_REMOTE_HOST || "127.0.0.1"}:${process.env.CLAW_GATEWAY_PORT || "18789"}`;
      const gw = new WebSocket(gatewayUrl, {
        headers: { Origin: INTERNAL_BASE_URL },
      });
      const pendingClientMessages: string[] = [];
      const commandOutputBuffers = new Map<string, string>();
      let ready = false;
      let sessionKey =
        meta.sessionKey ||
        `agent:${meta.agentId}:main:desktop_${Date.now().toString(36)}`;
      let sawAssistantDelta = false;
      let lastChatSnapshotText = "";
      // After a tool result, block chat.delta echoes (which contain tool output)
      // until the next agent.assistant stream event arrives.
      let blockChatDeltaUntilAgentStream = false;

      const sendToClient = (payload: object) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(payload));
        }
      };

      const emitAssistantDelta = (content: string) => {
        if (!content) return;
        sendToClient({
          choices: [
            { index: 0, delta: { content }, finish_reason: null },
          ],
        });
      };

      sendToClient({
        type: "connected",
        agentId: meta.agentId,
        sessionKey,
        ready: false,
      });

      gw.on("message", (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());

          if (msg.event === "connect.challenge") {
            const nonce = String(msg.payload?.nonce || "");
            const { sig, signedAt } = signDesktopGatewayPayload(
              nonce,
              gatewayToken
            );
            gw.send(
              JSON.stringify({
                type: "req",
                id: randomUUID(),
                method: "connect",
                params: {
                  minProtocol: 3,
                  maxProtocol: 4,
                  client: {
                    id: "openclaw-control-ui",
                    version: "1.0.0",
                    platform: "lingxia",
                    mode: "ui",
                  },
                  role: "operator",
                  scopes: DESKTOP_WS_SCOPES,
                  auth: { token: gatewayToken },
                  device: {
                    id: DESKTOP_WS_DEV_ID,
                    publicKey: DESKTOP_WS_DEV_PUB,
                    signature: sig,
                    signedAt,
                    nonce,
                  },
                  caps: ["tool-events"],
                },
              })
            );
            return;
          }

          if (msg.type === "res" && msg.id === "desktop-init-session") {
            if (!msg.ok) {
              sendToClient({
                type: "error",
                message: msg.error?.message || "OpenClaw session failed",
              });
              client.close();
              return;
            }
            sessionKey = msg.payload?.key || sessionKey;
            ready = true;
            sendToClient({
              type: "connected",
              agentId: meta.agentId,
              sessionKey,
              ready: true,
            });
            for (const pending of pendingClientMessages.splice(0)) {
              client.emit("message", Buffer.from(pending));
            }
            return;
          }

          if (msg.type === "res" && msg.ok === true && !ready) {
            const selectedModel = listDesktopModels(meta.adoptId).selected || undefined;
            gw.send(
              JSON.stringify({
                type: "req",
                id: "desktop-init-session",
                method: "sessions.create",
                params: {
                  agentId: meta.agentId,
                  key: sessionKey,
                  ...(selectedModel ? { model: selectedModel } : {}),
                },
              })
            );
            return;
          }

          if (msg.type === "res" && msg.ok === false && !ready) {
            sendToClient({
              type: "error",
              message: msg.error?.message || "OpenClaw gateway error",
            });
            client.close();
            return;
          }

          if (
            msg.event === "health" ||
            msg.event === "tick" ||
            msg.event === "heartbeat"
          ) {
            return;
          }

          const normalized = normalizeWsEvent(msg, sessionKey);
          if (normalized.kind !== "events") {
            if (msg.type === "res" && msg.ok === false) {
              sendToClient({
                type: "error",
                message: msg.error?.message || "OpenClaw RPC error",
              });
            }
            return;
          }

          const rawEvent = typeof msg.event === "string" ? msg.event : "";
          const rawPayload =
            msg.payload && typeof msg.payload === "object" ? msg.payload : {};
          const rawStream =
            typeof rawPayload.stream === "string" ? rawPayload.stream : "";
          const rawState =
            typeof rawPayload.state === "string" ? rawPayload.state : "";

          for (const event of normalized.events) {
            switch (event.type) {
              case "delta":
                if (rawEvent === "chat" && rawState === "delta") {
                  if (sawAssistantDelta || blockChatDeltaUntilAgentStream) break;
                }
                if (rawEvent === "agent" && rawStream === "assistant") {
                  sawAssistantDelta = true;
                  blockChatDeltaUntilAgentStream = false;
                }
                emitAssistantDelta(event.content);
                break;

              case "chat_snapshot": {
                if (sawAssistantDelta) break;
                const snapshot = event.content;
                const delta = snapshot.startsWith(lastChatSnapshotText)
                  ? snapshot.slice(lastChatSnapshotText.length)
                  : snapshot;
                lastChatSnapshotText = snapshot;
                emitAssistantDelta(delta);
                break;
              }

              case "thinking":
                sendToClient({
                  choices: [
                    {
                      index: 0,
                      delta: { reasoning_content: event.content },
                      finish_reason: null,
                    },
                  ],
                });
                break;

              case "tool_call":
                if (event.phase === "start") {
                  const toolCallId = event.toolCallId || `tc_${Date.now()}`;
                  commandOutputBuffers.set(toolCallId, "");
                  sendToClient({
                    _event: "tool_call",
                    id: toolCallId,
                    name: event.name || "tool",
                    arguments: JSON.stringify(event.args || {}),
                  });
                } else {
                  const toolCallId = event.toolCallId || "";
                  const buffered = commandOutputBuffers.get(toolCallId) || "";
                  commandOutputBuffers.delete(toolCallId);
                  sendToClient({
                    _event: "tool_result",
                    tool_call_id: toolCallId,
                    result:
                      buffered ||
                      (typeof event.result === "string" ? event.result : ""),
                    is_error: Boolean(event.isError),
                  });
                  // Reset so the agent's post-tool response text isn't suppressed.
                  // Block chat.delta until agent.assistant stream resumes — the
                  // gateway echoes tool output via chat.delta right after a tool
                  // result, and we must not let that leak into the main text body.
                  sawAssistantDelta = false;
                  blockChatDeltaUntilAgentStream = true;
                }
                break;

              case "command_output":
                if (event.phase === "delta") {
                  const toolCallId = event.toolCallId || "";
                  if (toolCallId && commandOutputBuffers.has(toolCallId)) {
                    commandOutputBuffers.set(
                      toolCallId,
                      (commandOutputBuffers.get(toolCallId) || "") +
                        (event.output || "")
                    );
                  }
                } else {
                  const toolCallId = event.toolCallId || "";
                  if (toolCallId && event.output) {
                    commandOutputBuffers.set(toolCallId, event.output);
                  }
                }
                break;

              case "item_status":
                sendToClient({
                  __status: event.progressText,
                  _event: "agent_status",
                  kind: "progress",
                  label: event.progressText,
                });
                break;

              case "lifecycle_end":
                sendToClient({ __stream_end: true });
                sendToClient({
                  choices: [
                    { index: 0, delta: {}, finish_reason: "stop" },
                  ],
                });
                break;

              case "chat_final": {
                if (event.content && !sawAssistantDelta) {
                  const delta = event.content.startsWith(lastChatSnapshotText)
                    ? event.content.slice(lastChatSnapshotText.length)
                    : event.content;
                  lastChatSnapshotText = event.content;
                  emitAssistantDelta(delta);
                }
                sendToClient({
                  choices: [
                    { index: 0, delta: {}, finish_reason: "stop" },
                  ],
                });
                break;
              }

              case "error":
                sendToClient({ error: event.message });
                break;

              default:
                break;
            }
          }
        } catch (error) {
          console.error("[DESKTOP-WS] parse error:", error);
        }
      });

      gw.on("error", error => {
        sendToClient({
          type: "error",
          message: error.message || "OpenClaw gateway websocket error",
        });
      });

      gw.on("close", () => {
        if (client.readyState === WebSocket.OPEN) {
          client.close(1012, "OpenClaw gateway closed");
        }
      });

      client.on("message", (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type !== "chat") return;
          if (!ready) {
            pendingClientMessages.push(raw.toString());
            sendToClient({
              __status: "正在初始化 OpenClaw 会话",
              _event: "agent_status",
              kind: "progress",
              label: "正在初始化 OpenClaw 会话",
            });
            return;
          }

          sawAssistantDelta = false;
          lastChatSnapshotText = "";
          blockChatDeltaUntilAgentStream = false;
          commandOutputBuffers.clear();
          sendToClient({
            __status: "已连接 OpenClaw，正在处理请求",
            _event: "agent_status",
            kind: "progress",
            label: "已连接 OpenClaw，正在处理请求",
          });
          gw.send(
            JSON.stringify({
              type: "req",
              id: randomUUID(),
              method: "chat.send",
              params: {
                sessionKey,
                message: buildRuntimeUserMessage(String(msg.message || "")),
                idempotencyKey: String(msg.clientRunId || randomUUID()),
                thinking: msg.runtimeMode === "plan" ? "on" : "off",
                deliver: false,
              },
            })
          );
        } catch {
          // Ignore malformed client messages.
        }
      });

      client.on("close", () => gw.close());
      client.on("error", () => gw.close());
    }
  );

  console.log("[DESKTOP-WS] registered at /api/desktop/openclaw/ws");
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

const desktopCronProvider = new OpenClawCronProvider();

function desktopCronHandle(claw: any): CronProviderHandle {
  const adoptId = String(claw.adoptId || "");
  return {
    adoptId,
    agentId: resolveRuntimeAgentId(adoptId, claw.agentId),
    userId: Number(claw.userId || 0),
    runtime: "openclaw",
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
  app.post("/api/desktop/login", express.json(), async (req, res) => {
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
    const wsBase = publicWsBaseUrl(req);
    const claw = await getDesktopUserClaw(user);
    const agentId = claw?.agentId || defaultDesktopAgentId();
    res.json({
      mode: "mvp",
      user,
      gatewayUrl:
        process.env.DESKTOP_OPENCLAW_GATEWAY_URL ||
        `${base}/api/desktop/openclaw`,
      gatewayWsUrl:
        process.env.DESKTOP_OPENCLAW_GATEWAY_WS_URL ||
        `${wsBase}/api/desktop/openclaw/ws`,
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

  app.get("/api/desktop/openclaw/health", (_req, res) => {
    res.json({ status: "ok", mode: "desktop-openclaw-proxy" });
  });

  app.get("/api/desktop/models", async (req, res) => {
    const user = await requireDesktopUser(req, res);
    if (!user) return;
    try {
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      res.json(listDesktopModels(claw.adoptId));
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
      const models = listDesktopModels(claw.adoptId);
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
    const sessions = readDesktopSessions(claw.agentId, query ? 200 : limit);
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
    const found = findDesktopSession(sessionId, claw.agentId);
    if (!found) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    res.json({
      session: found.summary,
      messages: readDesktopSessionMessagesFromFile(found.sessionFile),
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

  app.post("/api/desktop/channels/weixin/begin", async (req, res) => {
    const user = await requireDesktopUser(req, res);
    if (!user) return;
    try {
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      const result = await desktopStartWeixinBind(claw.adoptId);
      if (!result.ok) return res.status(502).json({ error: result.error });
      const qrDataUrl = await toQrDataUrl(result.qrCode);
      res.json({ qrCode: result.qrCode, pollToken: result.pollToken, qrDataUrl });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "weixin begin failed" });
    }
  });

  app.post("/api/desktop/channels/weixin/poll", async (req, res) => {
    const user = await requireDesktopUser(req, res);
    if (!user) return;
    try {
      const pollToken = String(req.body?.pollToken || "").trim();
      if (!pollToken) return res.status(400).json({ error: "pollToken required" });
      const claw = await getDesktopUserClaw(user);
      if (!claw) return res.status(404).json({ error: "no agent assigned" });
      const result = await desktopPollWeixinBind(claw.adoptId, claw, pollToken);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "weixin poll failed" });
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
      if (key === "weixin") {
        cleanupOpenClawWeixinBindingForAdopt(claw.adoptId, claw);
        return res.json({ ok: true });
      }
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

  app.post("/api/desktop/openclaw/v1/chat/completions", forwardOpenClawChat);

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
