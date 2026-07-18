import { execFileSync, execSync } from "child_process";
import path from "path";
import { createHash, createHmac } from "crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync, createReadStream } from "fs";
import { isIP } from "net";
import type { Request, Response } from "express";
import { createContext } from "./context";
import { appendRetainedJsonLog, startJsonLogRetention } from "./retained-json-log";
import { isPrivateIpAddress } from "./ip-address";

// ── 可配置路径（开源部署时通过 .env 覆盖）──
const processHome = process.env.HOME || process.env.USERPROFILE || "/root";

export const APP_ROOT = process.env.APP_ROOT || process.cwd();

export function expandHomePath(raw: string): string {
  const value = String(raw || "").trim();
  if (!value) return value;
  if (value === "~") return processHome;
  if (value.startsWith("~/")) return path.join(processHome, value.slice(2));
  return value;
}

export function normalizeOpenClawHome(raw?: string): string {
  const value = expandHomePath(
    raw
      || process.env.CLAW_OPENCLAW_HOME
      || process.env.CLAW_REMOTE_OPENCLAW_HOME
      || process.env.OPENCLAW_HOME
      || processHome
  );
  return path.basename(value) === ".openclaw" ? value : path.join(value, ".openclaw");
}

export const OPENCLAW_HOME = normalizeOpenClawHome();
export const OPENCLAW_BASE_HOME = path.dirname(OPENCLAW_HOME);
export const OPENCLAW_JSON_PATH = expandHomePath(process.env.CLAW_OPENCLAW_JSON || path.join(OPENCLAW_HOME, "openclaw.json"));

export const openClawPath = (...parts: string[]) => path.join(OPENCLAW_HOME, ...parts);
export const openClawAgentDir = (agentId: string) => openClawPath("agents", String(agentId || "").trim());
export const openClawWorkspaceDir = (runtimeAgentId: string) => openClawPath(`workspace-${String(runtimeAgentId || "").trim()}`);
export const openClawSkillMarketDir = () => openClawPath("skill-market");

const runtimePathPart = (value: unknown, fallback: string, maxLen = 96): string => {
  const normalized = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, maxLen)
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
};

export const isJiuwenClawAdoptId = (adoptId: string) => String(adoptId || "").startsWith("lgj-");

export function normalizeJiuwenClawHome(raw?: string): string {
  return expandHomePath(raw || process.env.JIUWENCLAW_HOME || path.join(processHome, ".jiuwenclaw"));
}

export const JIUWENCLAW_HOME = normalizeJiuwenClawHome();
export const jiuwenClawServiceId = () => runtimePathPart(process.env.JIUWENCLAW_SERVICE_ID || "linggan", "linggan", 64);
export const jiuwenClawAgentId = (adoptId: string, dbAgentIdRaw: any) =>
  runtimePathPart(dbAgentIdRaw || `jiuwen_${String(adoptId || "").trim()}`, `jiuwen_${String(adoptId || "default").trim()}`, 96);
export const jiuwenClawWorkspaceDir = (adoptId: string, dbAgentIdRaw: any) =>
  path.join(
    JIUWENCLAW_HOME,
    `service_${jiuwenClawServiceId()}`,
    `agent_${jiuwenClawAgentId(adoptId, dbAgentIdRaw)}`,
    "agent",
    "jiuwenclaw_workspace",
  );
export const jiuwenClawAgentDir = (adoptId: string, dbAgentIdRaw: any) =>
  path.join(
    JIUWENCLAW_HOME,
    `service_${jiuwenClawServiceId()}`,
    `agent_${jiuwenClawAgentId(adoptId, dbAgentIdRaw)}`,
    "agent",
  );
export const jiuwenClawSessionsDir = (adoptId: string, dbAgentIdRaw: any) =>
  path.join(jiuwenClawAgentDir(adoptId, dbAgentIdRaw), "sessions");

export const INTERNAL_BASE_URL = String(
  process.env.WORKFORCE_AGENT_INTERNAL_BASE_URL || process.env.LINGXIA_INTERNAL_BASE_URL || `http://127.0.0.1:${process.env.PORT || "5180"}`
).replace(/\/+$/, "");
export const internalApiUrl = (pathname: string) => `${INTERNAL_BASE_URL}${String(pathname || "").startsWith("/") ? pathname : `/${pathname}`}`;

export const LOG_DIR = `${APP_ROOT}/logs`;
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
export const startApplicationLogRetention = () => startJsonLogRetention(LOG_DIR);
export const appendLogAsync = (fileName: string, payload: any) => {
  void appendRetainedJsonLog(`${LOG_DIR}/${fileName}`, payload).catch(() => {});
};

// ── Internal API auth ──
export function isLoopbackRequest(req: Request): boolean {
  const candidates = [
    req.ip,
    req.socket.remoteAddress,
    String(req.headers["x-forwarded-for"] || "").split(",")[0]?.trim(),
  ].filter(Boolean).map((value) => String(value).replace(/^::ffff:/, ""));
  return candidates.some((addr) => addr === "127.0.0.1" || addr === "::1" || addr === "localhost");
}

export function configuredInternalApiKey(): string {
  return String(process.env.INTERNAL_API_KEY || "").trim();
}

export function requestInternalToken(req: Request): string {
  const authorization = String(req.headers.authorization || "").trim();
  if (authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  return String(req.headers["x-internal-key"] || req.headers["x-linggan-token"] || "").trim();
}

export function isAuthorizedInternalRequest(req: Request, expectedToken?: string): boolean {
  const expected = String(expectedToken || configuredInternalApiKey()).trim();
  if (expected) return requestInternalToken(req) === expected;
  return process.env.NODE_ENV !== "production" && isLoopbackRequest(req);
}

// ── SSRF 防护 ──
export function isPrivateUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    if (isIP(h) && isPrivateIpAddress(h)) return true;
    if (h === "localhost" || h.endsWith(".localhost")) return true;
    if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  } catch { /* invalid URL, skip */ }
  return false;
}

// ── Session Epoch / Registry ──

const SESSION_EPOCH_PATH = `${APP_ROOT}/data/claw-session-epochs.json`;
const SESSION_REGISTRY_PATH = `${APP_ROOT}/data/claw-session-registry.json`;

export const readSessionEpoch = (adoptId: string) => {
  try {
    if (!existsSync(SESSION_EPOCH_PATH)) return 0;
    const raw = String(readFileSync(SESSION_EPOCH_PATH, "utf-8") || "{}");
    const obj = JSON.parse(raw);
    return Number(obj?.[adoptId] || 0) || 0;
  } catch { return 0; }
};

export const bumpSessionEpoch = (adoptId: string) => {
  try {
    let obj: any = {};
    if (existsSync(SESSION_EPOCH_PATH)) {
      const raw = String(readFileSync(SESSION_EPOCH_PATH, "utf-8") || "{}");
      obj = JSON.parse(raw || "{}");
    }
    const next = (Number(obj?.[adoptId] || 0) || 0) + 1;
    obj[adoptId] = next;
    mkdirSync(`${APP_ROOT}/data`, { recursive: true });
    writeFileSync(SESSION_EPOCH_PATH, JSON.stringify(obj, null, 2), 'utf-8');
    // 技能/配置变更时，同步 invalidate 该 adoptId 的所有注册表 session
    invalidateSessionRegistry(adoptId);
    return next;
  } catch { return 0; }
};

// ── Session 注册表：adoptId:runtimeAgentId -> { sessionKey, skillEpoch, createdAt } ──
// 使用 Gateway 标准 key 格式 agent:{agentId}:main，避免自定义 key 导致新建 session 时不扫 workspace skills
export const readSessionRegistry = (): Record<string, any> => {
  try {
    if (!existsSync(SESSION_REGISTRY_PATH)) return {};
    const raw = String(readFileSync(SESSION_REGISTRY_PATH, "utf-8") || "{}");
    return JSON.parse(raw) || {};
  } catch { return {}; }
};

export const writeSessionRegistry = (reg: Record<string, any>) => {
  try {
    mkdirSync(`${APP_ROOT}/data`, { recursive: true });
    writeFileSync(SESSION_REGISTRY_PATH, JSON.stringify(reg, null, 2), 'utf-8');
  } catch {}
};

export const getRegistryKey = (adoptId: string, runtimeAgentId: string) =>
  `${adoptId}:${runtimeAgentId}`;

export const normalizeSessionPart = (value: unknown, maxLen = 96): string => {
  const normalized = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9:_-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, maxLen);
  return normalized.replace(/^_+|_+$/g, "");
};

export const normalizeSessionChannel = (value: unknown): string => {
  const channel = normalizeSessionPart(value, 32).toLowerCase();
  return channel || "main";
};

export const normalizeConversationId = (value: unknown): string => {
  return normalizeSessionPart(value, 96);
};

export const buildSessionRegistryScope = (channel?: unknown, conversationId?: unknown): string => {
  const normalizedChannel = normalizeSessionChannel(channel);
  const normalizedConversationId = normalizeConversationId(conversationId);
  if (normalizedChannel && normalizedChannel !== "main" && normalizedConversationId) {
    return `${normalizedChannel}:${normalizedConversationId}`;
  }
  return "main";
};

export const buildRuntimeSessionKey = (args: {
  runtimeAgentId: string;
  channel?: unknown;
  conversationId?: unknown;
  epoch?: number;
  epochLabel?: unknown;
}): string => {
  const runtimeAgentId = normalizeSessionPart(args.runtimeAgentId, 96);
  const epoch = Number(args.epoch || 0) || 0;
  const epochLabel = normalizeSessionPart(args.epochLabel, 64);
  if (epochLabel) return `agent:${runtimeAgentId}:main:${epochLabel}`;

  const channel = normalizeSessionChannel(args.channel);
  const conversationId = normalizeConversationId(args.conversationId);
  const base = channel !== "main" && conversationId
    ? `agent:${runtimeAgentId}:${channel}:${conversationId}`
    : `agent:${runtimeAgentId}:main`;
  return epoch > 0 ? `${base}:e${epoch}` : base;
};

export const getScopedRegistryKey = (adoptId: string, runtimeAgentId: string, scope: string = "main") =>
  scope && scope !== "main" ? `${adoptId}:${runtimeAgentId}:${scope}` : getRegistryKey(adoptId, runtimeAgentId);

export const lookupSessionRegistry = (adoptId: string, runtimeAgentId: string, currentEpoch: number, scope: string = "main"): string | null => {
  try {
    const reg = readSessionRegistry();
    const key = getScopedRegistryKey(adoptId, runtimeAgentId, scope);
    const entry = reg[key];
    if (!entry) return null;
    // skillEpoch 不匹配则 stale，强制重建
    if (Number(entry.skillEpoch) !== currentEpoch) return null;
    return String(entry.sessionKey || "");
  } catch { return null; }
};

export const upsertSessionRegistry = (adoptId: string, runtimeAgentId: string, sessionKey: string, skillEpoch: number, scope: string = "main") => {
  try {
    const reg = readSessionRegistry();
    const key = getScopedRegistryKey(adoptId, runtimeAgentId, scope);
    reg[key] = { sessionKey, skillEpoch, createdAt: new Date().toISOString() };
    writeSessionRegistry(reg);
  } catch {}
};

// 2026-04-29 批次 2 A3：read-only sessionKey 解析（recover 端点用）
// 抽自 claw-chat.ts L341-357 同样三档逻辑：epochLabel → registry → epoch fallback
// 区别：**永不 upsert**（recover 不能污染 registry，避免它替正在等连接的 chat 写错的 key）
// claw-chat.ts 主聊天路径保留自己的 upsert 行为不动
export const resolveSessionKey = (
  adoptId: string,
  runtimeAgentId: string,
  epoch: number,
  epochLabel?: string,
  channel?: unknown,
  conversationId?: unknown,
): string => {
  const scope = buildSessionRegistryScope(channel, conversationId);
  const found = lookupSessionRegistry(adoptId, runtimeAgentId, epoch, scope);
  if (found) return found;
  return buildRuntimeSessionKey({ runtimeAgentId, channel, conversationId, epoch, epochLabel });
};

export const invalidateSessionRegistry = (adoptId: string) => {
  try {
    const reg = readSessionRegistry();
    // 删除所有该 adoptId 下的注册表条目（前缀匹配）
    const keysToDelete = Object.keys(reg).filter(k => k.startsWith(`${adoptId}:`));
    if (keysToDelete.length === 0) return;
    keysToDelete.forEach(k => delete reg[k]);
    writeSessionRegistry(reg);
  } catch {}
};

// ── 清除 OpenClaw agent 的 sessions.json 缓存 ──
// 让下次对话自动新建 session，重新扫描 skills 目录（含最新技能快照）
// 无需用户手动 /new 或重置对话
export const clearAgentSessionsCache = (agentId: string, remoteHome: string) => {
  try {
    const sessionsPath = path.join(normalizeOpenClawHome(remoteHome), "agents", agentId, "sessions", "sessions.json");
    if (existsSync(sessionsPath)) {
      writeFileSync(sessionsPath, "{}", "utf-8");
    }
  } catch {}
};


export const resolveRequesterUserId = async (req: Request, res: Response): Promise<number | null> => {
  try {
    const ctx = await createContext({ req, res } as any);
    const uid = Number((ctx as any)?.user?.id || 0);
    return uid > 0 ? uid : null;
  } catch {
    return null;
  }
};

export const requireClawOwner = async (req: Request, res: Response, adoptId: string) => {
  const userId = await resolveRequesterUserId(req, res);
  if (!userId) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return null;
  }
  const { getClawByAdoptId } = await import("../db");
  const claw = await getClawByAdoptId(adoptId).catch(() => null);
  if (!claw) {
    res.status(404).json({ error: "NOT_FOUND" });
    return null;
  }
  if (Number((claw as any).userId || 0) !== userId) {
    appendLogAsync("claw-auth.log", { ts: new Date().toISOString(), route: req.path, userId, adoptId, result: 403 });
    res.status(403).json({ error: "FORBIDDEN" });
    return null;
  }
  return claw;
};


export const resolveRuntimeAgentId = (adoptId: string, dbAgentIdRaw: any) => {
  if (isJiuwenClawAdoptId(adoptId)) return jiuwenClawAgentId(adoptId, dbAgentIdRaw);
  const dbAgentId = String(dbAgentIdRaw || "").trim();
  const trialAgentId = `trial_${String(adoptId)}`;
  const trialAgentDir = openClawAgentDir(trialAgentId);
  return existsSync(trialAgentDir) ? trialAgentId : dbAgentId;
};

// Internal legacy RPC helper. New code must go through
// createOpenClawRuntimeAdapter().callRpc() so OpenClaw access stays centralized.
const callClawGatewayRpc = (method: string, params: Record<string, any> = {}) => {
  const remoteHost = process.env.CLAW_REMOTE_HOST || "127.0.0.1";
  const gatewayPort = parseInt(process.env.CLAW_GATEWAY_PORT || "18789", 10);
  const gatewayToken = process.env.CLAW_GATEWAY_TOKEN || "";
  const url = `ws://${remoteHost}:${gatewayPort}`;
  const out = execFileSync("openclaw", [
    "gateway", "call", method,
    "--json",
    "--url", url,
    "--token", gatewayToken,
    "--timeout", "30000",
    "--params", JSON.stringify(params || {}),
  ], { encoding: "utf-8", timeout: 40000 });
  return JSON.parse(String(out || "{}").trim() || "{}");
};

// ── 文件下载 Token ──
export function generateFileToken(adoptId: string, runtimeAgentId: string, relPath: string, ttlSeconds: number): string {
  const secret = process.env.FILE_TOKEN_SECRET || process.env.JWT_SECRET || "";
  if (!secret) throw new Error("FILE_TOKEN_SECRET or JWT_SECRET must be set");
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = Buffer.from(JSON.stringify({ adoptId, runtimeAgentId, path: relPath, exp })).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

// ── Workspace helpers ──
export const resolveRuntimeWorkspaceByIds = (adoptId: string, runtimeAgentId: string) => {
  if (isJiuwenClawAdoptId(adoptId)) return jiuwenClawWorkspaceDir(adoptId, runtimeAgentId);
  return openClawWorkspaceDir(runtimeAgentId);
};

export const resolveRuntimeWorkspace = (claw: any, adoptIdRaw?: string) => {
  const adoptId = String(adoptIdRaw || claw?.adoptId || "").trim();
  const runtimeAgentId = resolveRuntimeAgentId(adoptId, String(claw?.agentId || ""));
  return resolveRuntimeWorkspaceByIds(adoptId, runtimeAgentId);
};

export const resolveClawWorkspace = (claw: any) => {
  return resolveRuntimeWorkspace(claw);
};

export const computeEtag = (content: string) => createHash("sha1").update(content || "", "utf8").digest("hex");

// ── Read OpenClaw JSON config ──
export const readOpenclawJson = () => {
  try {
    const raw = readFileSync(OPENCLAW_JSON_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

// ── 统一文件下载策略 ──


/**
 * 安全化相对路径：统一 path traversal 防护
 * 去除 .., 去除前导 /, 去除 null bytes
 */
export function sanitizeRelPath(input: string): string | null {
  if (!input || typeof input !== "string") return null;
  const cleaned = input
    .replace(/\0/g, "")          // null bytes
    .replace(/\.\./g, "")        // path traversal
    .replace(/^\/+/, "")         // leading slashes
    .replace(/\/\/+/g, "/")          // collapse double slashes
    .trim();
  if (!cleaned || cleaned.startsWith("/")) return null;
  return cleaned;
}

/**
 * 安全化文件名（不允许路径分隔符）
 */
export function sanitizeFileName(input: string): string | null {
  if (!input || typeof input !== "string") return null;
  const cleaned = input.trim();
  if (!cleaned || cleaned.includes("..") || cleaned.includes("/") || cleaned.includes("\\") || cleaned.includes("\0")) {
    return null;
  }
  return cleaned;
}

/**
 * 统一文件流式下载响应
 * 所有文件下载路由共用，确保一致的 header 和错误处理
 */
export function streamFileDownload(res: Response, filePath: string, fileName?: string) {
  const name = fileName || filePath.split("/").pop() || "download";
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader("Content-Type", "application/octet-stream");
  const stream = createReadStream(filePath);
  stream.on("error", (err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: "file read error" });
    }
  });
  stream.pipe(res);
}

// ── Token 验证（供测试和路由共用）──

export function verifyFileToken(rawToken: string): { ok: true; adoptId: string; runtimeAgentId: string; path: string; exp: number } | { ok: false; error: string; status: number } {
  if (!rawToken) return { ok: false, error: "token required", status: 400 };

  const dotIdx = rawToken.lastIndexOf(".");
  if (dotIdx < 0) return { ok: false, error: "invalid token format", status: 400 };

  const payload = rawToken.slice(0, dotIdx);
  const sig = rawToken.slice(dotIdx + 1);


  const secret = process.env.FILE_TOKEN_SECRET || process.env.JWT_SECRET || "";
  if (!secret) return { ok: false, error: "server secret not configured", status: 500 };
  const expectedSig = createHmac("sha256", secret).update(payload).digest("base64url");
  if (sig !== expectedSig) return { ok: false, error: "invalid token signature", status: 401 };

  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "malformed token", status: 400 };
  }

  if (!parsed.exp || Math.floor(Date.now() / 1000) > parsed.exp) {
    return { ok: false, error: "token expired", status: 401 };
  }

  return { ok: true, adoptId: parsed.adoptId, runtimeAgentId: parsed.runtimeAgentId, path: parsed.path, exp: parsed.exp };
}

// ── Memory target 解析（供测试和路由共用）──

export function resolveMemoryTarget(workspace: string, target: string): { ok: true; path: string; max: number } | { ok: false; reason: string } {
  const t = String(target || "").trim();
  if (t === "MEMORY.md") return { ok: true, path: `${workspace}/MEMORY.md`, max: 256 * 1024 };
  if (t === "DREAMS.md") return { ok: true, path: `${workspace}/DREAMS.md`, max: 256 * 1024 };

  const m = t.match(/^memory:(\d{4}-\d{2}-\d{2})$/);
  if (m) return { ok: true, path: `${workspace}/memory/${m[1]}.md`, max: 128 * 1024 };

  const n = t.match(/^notes:([a-zA-Z0-9._-]+\.md)$/);
  if (n) return { ok: true, path: `${workspace}/notes/${n[1]}`, max: 256 * 1024 };

  return { ok: false, reason: "path_not_allowed" };
}
