/**
 * Workforce Agent Platform Feishu channel binding.
 *
 * Feishu uses the same app-registration device flow that OpenClaw uses:
 * init -> begin -> poll. The registration endpoint returns a dynamic appId /
 * appSecret pair after the user scans and authorizes with Feishu.
 */
import express from "express";
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from "fs";
import path from "path";
import { createHash, randomInt } from "crypto";
import {
  APP_ROOT,
  isAuthorizedInternalRequest,
  jiuwenClawAgentId,
  jiuwenClawWorkspaceDir,
  requireClawOwner,
} from "./helpers";
import type {
  ChannelBindHandle,
  ChannelBindStart,
  ChannelBindStatus,
  ChannelPayload,
  Result,
} from "@shared/types/cron";
import {
  getChannelBindingByAdopt,
  getChannelBindingByExternalUser,
  removeChannelBindingByAdopt,
  removeChannelBindingsForExternalUser,
  upsertChannelBinding,
} from "../db/channel-bindings";

const FEISHU_ACCOUNTS_URL = "https://accounts.feishu.cn";
const LARK_ACCOUNTS_URL = "https://accounts.larksuite.com";
const FEISHU_API_URL = "https://open.feishu.cn/open-apis";
const LARK_API_URL = "https://open.larksuite.com/open-apis";
const REGISTRATION_PATH = "/oauth/v1/app/registration";
const REQUEST_TIMEOUT_MS = 10_000;

const FEISHU_CONFIG_DIR = path.join(APP_ROOT, "data/feishu-accounts");
const FEISHU_BRIDGE_DIR = path.join(APP_ROOT, "data/feishu-bridge");
mkdirSync(FEISHU_CONFIG_DIR, { recursive: true });
mkdirSync(FEISHU_BRIDGE_DIR, { recursive: true });

const tenantTokenCache = new Map<string, { token: string; expiresAt: number }>();
const BIND_CODE_TTL_MS = 10 * 60 * 1000;
const BIND_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type FeishuDomain = "feishu" | "lark";

type FeishuAccount = {
  appId: string;
  appSecret: string;
  openId?: string;
  domain: FeishuDomain;
  boundAt: string;
};

type FeishuPollToken = {
  deviceCode: string;
  domain: FeishuDomain;
  expiresAt: number;
  interval: number;
  domainSwitched?: boolean;
};

type FeishuBridgeBindCode = {
  code: string;
  adoptId: string;
  userId: number;
  createdAt: string;
  expiresAt: string;
};

type FeishuBridgeBinding = {
  adoptId: string;
  userId: number;
  openId: string;
  chatId: string;
  channelId: string;
  messageId?: string;
  boundAt: string;
};

function accountPath(adoptId: string) {
  return path.join(FEISHU_CONFIG_DIR, `${adoptId}.json`);
}

function bridgeBindingPath(adoptId: string) {
  return path.join(FEISHU_BRIDGE_DIR, `${adoptId}.json`);
}

function bridgeCodesPath() {
  return path.join(FEISHU_BRIDGE_DIR, "pending-codes.json");
}

function loadAccount(adoptId: string): FeishuAccount | null {
  const p = accountPath(adoptId);
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : null;
  } catch {
    return null;
  }
}

function saveAccount(adoptId: string, account: FeishuAccount) {
  writeFileSync(accountPath(adoptId), JSON.stringify(account, null, 2), { encoding: "utf-8", mode: 0o640 });
}

function removeAccount(adoptId: string) {
  try {
    unlinkSync(accountPath(adoptId));
  } catch {
    // Already unbound.
  }
}

function loadPendingCodes(): Record<string, FeishuBridgeBindCode> {
  try {
    const raw = existsSync(bridgeCodesPath()) ? readFileSync(bridgeCodesPath(), "utf-8") : "{}";
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function savePendingCodes(codes: Record<string, FeishuBridgeBindCode>) {
  writeFileSync(bridgeCodesPath(), JSON.stringify(codes, null, 2), "utf-8");
}

function loadBridgeBindingFile(adoptId: string): FeishuBridgeBinding | null {
  try {
    const p = bridgeBindingPath(adoptId);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : null;
  } catch {
    return null;
  }
}

function loadBridgeBindingFiles(): FeishuBridgeBinding[] {
  try {
    return readdirSync(FEISHU_BRIDGE_DIR)
      .filter((name) => name.endsWith(".json") && name !== "pending-codes.json")
      .map((name) => {
        try {
          return JSON.parse(readFileSync(path.join(FEISHU_BRIDGE_DIR, name), "utf-8")) as FeishuBridgeBinding;
        } catch {
          return null;
        }
      })
      .filter((item): item is FeishuBridgeBinding => !!item?.adoptId && !!item?.openId);
  } catch {
    return [];
  }
}

function saveBridgeBindingFile(binding: FeishuBridgeBinding) {
  writeFileSync(bridgeBindingPath(binding.adoptId), JSON.stringify(binding, null, 2), "utf-8");
}

function removeBridgeBindingFile(adoptId: string) {
  try {
    unlinkSync(bridgeBindingPath(adoptId));
  } catch {
    // Already unbound.
  }
}

function removeBridgeBindingFilesForOpenId(openId: string, exceptAdoptId?: string) {
  const normalizedOpenId = String(openId || "").trim();
  if (!normalizedOpenId) return;
  for (const binding of loadBridgeBindingFiles()) {
    if (binding.openId === normalizedOpenId && binding.adoptId !== exceptAdoptId) {
      removeBridgeBindingFile(binding.adoptId);
    }
  }
}

function toBridgeBindingFromDb(row: any): FeishuBridgeBinding {
  const boundAt =
    row?.boundAt instanceof Date
      ? row.boundAt.toISOString()
      : row?.boundAt
        ? new Date(row.boundAt).toISOString()
        : new Date().toISOString();
  return {
    adoptId: String(row.adoptId || ""),
    userId: Number(row.userId || 0),
    openId: String(row.externalUserId || ""),
    chatId: String(row.externalChatId || ""),
    channelId: String(row.externalChannelId || "feishu"),
    messageId: row.sourceMessageId ? String(row.sourceMessageId) : undefined,
    boundAt,
  };
}

async function saveBridgeBinding(binding: FeishuBridgeBinding): Promise<void> {
  try {
    await upsertChannelBinding({
      channel: "feishu",
      adoptId: binding.adoptId,
      userId: binding.userId,
      externalUserId: binding.openId,
      externalChatId: binding.chatId,
      externalChannelId: binding.channelId || "feishu",
      sourceMessageId: binding.messageId || null,
      boundAt: binding.boundAt ? new Date(binding.boundAt) : new Date(),
    });
  } catch (error: any) {
    console.warn("[FEISHU-BRIDGE] DB binding save failed, writing file backup only", error?.message || error);
  }
  saveBridgeBindingFile(binding);
}

async function loadBridgeBinding(adoptId: string): Promise<FeishuBridgeBinding | null> {
  try {
    const row = await getChannelBindingByAdopt("feishu", adoptId);
    if (row) return toBridgeBindingFromDb(row);
  } catch (error: any) {
    console.warn("[FEISHU-BRIDGE] DB binding lookup failed, falling back to file", error?.message || error);
  }

  const fileBinding = loadBridgeBindingFile(adoptId);
  if (fileBinding?.adoptId && fileBinding.openId) {
    try {
      await saveBridgeBinding(fileBinding);
    } catch (error: any) {
      console.warn("[FEISHU-BRIDGE] DB binding backfill failed", error?.message || error);
    }
  }
  return fileBinding;
}

async function loadBridgeBindingByOpenId(openId: string): Promise<FeishuBridgeBinding | null> {
  const normalizedOpenId = String(openId || "").trim();
  if (!normalizedOpenId) return null;
  try {
    const row = await getChannelBindingByExternalUser("feishu", normalizedOpenId);
    if (row) return toBridgeBindingFromDb(row);
  } catch (error: any) {
    console.warn("[FEISHU-BRIDGE] DB external binding lookup failed, falling back to file", error?.message || error);
  }

  const fileBinding = loadBridgeBindingFiles().find((item) => item.openId === normalizedOpenId) || null;
  if (fileBinding?.adoptId && fileBinding.openId) {
    try {
      await saveBridgeBinding(fileBinding);
    } catch (error: any) {
      console.warn("[FEISHU-BRIDGE] DB external binding backfill failed", error?.message || error);
    }
  }
  return fileBinding;
}

async function removeBridgeBinding(adoptId: string): Promise<void> {
  try {
    await removeChannelBindingByAdopt("feishu", adoptId);
  } catch (error: any) {
    console.warn("[FEISHU-BRIDGE] DB binding removal failed", error?.message || error);
  }
  removeBridgeBindingFile(adoptId);
}

async function removeBridgeBindingsForOpenId(openId: string, exceptAdoptId?: string): Promise<void> {
  const normalizedOpenId = String(openId || "").trim();
  if (!normalizedOpenId) return;
  try {
    await removeChannelBindingsForExternalUser("feishu", normalizedOpenId, exceptAdoptId);
  } catch (error: any) {
    console.warn("[FEISHU-BRIDGE] DB external binding removal failed", error?.message || error);
  }
  removeBridgeBindingFilesForOpenId(normalizedOpenId, exceptAdoptId);
}

function randomBindCode(): string {
  let code = "";
  for (let i = 0; i < 6; i += 1) code += BIND_CODE_ALPHABET[randomInt(BIND_CODE_ALPHABET.length)];
  return code;
}

function pruneExpiredCodes(codes: Record<string, FeishuBridgeBindCode>) {
  const now = Date.now();
  for (const [code, item] of Object.entries(codes)) {
    if (!item?.expiresAt || Date.parse(item.expiresAt) <= now) delete codes[code];
  }
}

function createBridgeBindCode(adoptId: string, userId: number): FeishuBridgeBindCode {
  const codes = loadPendingCodes();
  pruneExpiredCodes(codes);
  for (const [code, item] of Object.entries(codes)) {
    if (item.adoptId === adoptId) delete codes[code];
  }
  let code = randomBindCode();
  while (codes[code]) code = randomBindCode();
  const now = new Date();
  const item: FeishuBridgeBindCode = {
    code,
    adoptId,
    userId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + BIND_CODE_TTL_MS).toISOString(),
  };
  codes[code] = item;
  savePendingCodes(codes);
  return item;
}

function normalizeBindCode(value: unknown): string {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function extractBindCode(input: unknown): string {
  const text = String(input || "").trim();
  const match = text.match(/(?:^|\s)(?:绑定|bind)\s*[:：]?\s*([A-Za-z0-9]{4,12})(?:\s|$)/i);
  return normalizeBindCode(match?.[1] || text);
}

function sanitizeRoutePart(value: unknown, fallback: string): string {
  const normalized = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 96)
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function hashRouteId(value: unknown): string {
  const normalized = String(value || "").trim();
  return normalized ? createHash("sha256").update(normalized).digest("hex").slice(0, 10) : "";
}

function expectedBridgeToken(): string {
  return String(
    process.env.WORKFORCE_AGENT_JIUWEN_WEBHOOK_TOKEN
      || process.env.JIUWEN_WEBHOOK_TOKEN
      || process.env.LINGGAN_JIUWEN_WEBHOOK_TOKEN
      || process.env.INTERNAL_API_KEY
      || "",
  ).trim();
}

function accountsBaseUrl(domain: FeishuDomain) {
  return domain === "lark" ? LARK_ACCOUNTS_URL : FEISHU_ACCOUNTS_URL;
}

function apiBaseUrl(domain: FeishuDomain) {
  return domain === "lark" ? LARK_API_URL : FEISHU_API_URL;
}

function loadBridgeSenderAccount(): FeishuAccount | null {
  const appId = String(
    process.env.LINGGAN_FEISHU_APP_ID ||
      process.env.FEISHU_APP_ID ||
      process.env.JIUWENSWARM_FEISHU_APP_ID ||
      ""
  ).trim();
  const appSecret = String(
    process.env.LINGGAN_FEISHU_APP_SECRET ||
      process.env.FEISHU_APP_SECRET ||
      process.env.JIUWENSWARM_FEISHU_APP_SECRET ||
      ""
  ).trim();
  if (!appId || !appSecret) return null;
  const rawDomain = String(process.env.LINGGAN_FEISHU_DOMAIN || process.env.FEISHU_DOMAIN || "feishu").trim();
  return {
    appId,
    appSecret,
    domain: rawDomain === "lark" ? "lark" : "feishu",
    boundAt: new Date(0).toISOString(),
  };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function postRegistration(domain: FeishuDomain, body: Record<string, string>) {
  const response = await fetchWithTimeout(`${accountsBaseUrl(domain)}${REGISTRATION_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  return await response.json().catch(() => ({}));
}

function encodePollToken(token: FeishuPollToken): string {
  return Buffer.from(JSON.stringify(token), "utf-8").toString("base64url");
}

function decodePollToken(raw: string): FeishuPollToken | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf-8"));
    if (!parsed?.deviceCode) return null;
    return {
      deviceCode: String(parsed.deviceCode),
      domain: parsed.domain === "lark" ? "lark" : "feishu",
      expiresAt: Number(parsed.expiresAt || 0),
      interval: Number(parsed.interval || 5) || 5,
      domainSwitched: !!parsed.domainSwitched,
    };
  } catch {
    return null;
  }
}

function toBindHandle(userId: number, account: FeishuAccount): ChannelBindHandle {
  return {
    channelId: "feishu",
    userId,
    targetId: account.openId,
    targetLabel: account.openId || "飞书用户",
    boundAt: account.boundAt,
    domain: account.domain,
    metadata: {
      appId: account.appId,
      appSecret: account.appSecret,
      openId: account.openId,
    },
  };
}

export async function getFeishuStatus(adoptId: string): Promise<{
  bound: boolean;
  targetLabel?: string;
  domain?: string;
  bidirectionalBound?: boolean;
  bidirectionalConfigured?: boolean;
  bidirectionalTargetLabel?: string;
  deliveryReady?: boolean;
  deliveryMode?: "account" | "bridge";
}> {
  const account = loadAccount(adoptId);
  const bridge = await loadBridgeBinding(adoptId);
  const bridgeSender = loadBridgeSenderAccount();
  const accountReady = !!(account?.appId && account?.appSecret && account?.openId);
  const bridgeConfigured = !!(bridgeSender?.appId && bridgeSender?.appSecret);
  const bridgeReady = bridgeConfigured && !!bridge?.openId;
  return {
    bound: !!(account?.appId && account?.appSecret),
    targetLabel: bridge?.openId || account?.openId || "",
    domain: account?.domain,
    bidirectionalBound: !!bridge?.openId,
    bidirectionalConfigured: bridgeConfigured,
    bidirectionalTargetLabel: bridge?.openId || "",
    deliveryReady: accountReady || bridgeReady,
    deliveryMode: bridgeReady ? "bridge" : accountReady ? "account" : undefined,
  };
}

export async function initFeishuBindFlow(): Promise<Result<{ supported: boolean; reason?: string }>> {
  const data = await postRegistration("feishu", { action: "init" });
  const methods = Array.isArray(data?.supported_auth_methods) ? data.supported_auth_methods : [];
  if (!methods.includes("client_secret")) {
    return {
      ok: true,
      value: { supported: false, reason: "当前飞书环境不支持 client_secret app-registration" },
    };
  }
  return { ok: true, value: { supported: true } };
}

export async function startFeishuBindFlow(): Promise<Result<ChannelBindStart>> {
  const init = await initFeishuBindFlow();
  if (!init.ok) return { ok: false, error: init.error };
  if (!init.value.supported) {
    return { ok: false, error: { kind: "auth_failed", detail: init.value.reason || "feishu registration unsupported" } };
  }

  const data = await postRegistration("feishu", {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  });
  if (!data?.device_code || !data?.verification_uri_complete) {
    return { ok: false, error: { kind: "channel_unreachable", detail: "Feishu begin response missing device_code" } };
  }
  const interval = Number(data.interval || 5) || 5;
  const expireIn = Number(data.expires_in || 3600) || 3600;
  const pollToken = encodePollToken({
    deviceCode: String(data.device_code),
    domain: "feishu",
    expiresAt: Date.now() + expireIn * 1000,
    interval,
  });
  const qrUrl = new URL(String(data.verification_uri_complete));
  qrUrl.searchParams.set("from", "lingxia_channel");
  qrUrl.searchParams.set("tp", "lingxia_feishu");
  return {
    ok: true,
    value: {
      qrCode: qrUrl.toString(),
      pollToken,
      expiresAt: new Date(Date.now() + expireIn * 1000).toISOString(),
      verificationUri: String(data.verification_uri || ""),
      userCode: String(data.user_code || ""),
      pollIntervalMs: interval * 1000,
    },
  };
}

export async function pollFeishuBindStatus(adoptId: string, userId: number, rawPollToken: string): Promise<Result<ChannelBindStatus & { pollToken?: string }>> {
  const token = decodePollToken(rawPollToken);
  if (!token) return { ok: false, error: { kind: "payload_rejected", detail: "invalid feishu poll token" } };
  if (Date.now() > token.expiresAt) return { ok: true, value: { status: "expired" } };

  let data: any;
  try {
    data = await postRegistration(token.domain, { action: "poll", device_code: token.deviceCode });
  } catch {
    return { ok: true, value: { status: "pending" } };
  }

  if (data?.user_info?.tenant_brand === "lark" && token.domain !== "lark" && !token.domainSwitched) {
    const next = encodePollToken({ ...token, domain: "lark", domainSwitched: true });
    return { ok: true, value: { status: "pending", pollToken: next } };
  }

  if (data?.client_id && data?.client_secret) {
    const openId = data.user_info?.open_id ? String(data.user_info.open_id) : "";
    if (!openId) {
      return {
        ok: false,
        error: {
          kind: "auth_failed",
          detail: "Feishu authorization did not return open_id; please retry binding",
        },
      };
    }
    const account: FeishuAccount = {
      appId: String(data.client_id),
      appSecret: String(data.client_secret),
      openId,
      domain: token.domain,
      boundAt: new Date().toISOString(),
    };
    saveAccount(adoptId, account);
    return { ok: true, value: { status: "confirmed", bindHandle: toBindHandle(userId, account) } };
  }

  if (data?.error === "access_denied" || data?.error === "expired_token") {
    return { ok: true, value: { status: "expired" } };
  }
  return { ok: true, value: { status: "pending" } };
}

async function getTenantAccessToken(account: FeishuAccount): Promise<string> {
  const cacheKey = `${account.domain}:${account.appId}`;
  const cached = tenantTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }
  const response = await fetchWithTimeout(`${apiBaseUrl(account.domain)}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: account.appId, app_secret: account.appSecret }),
  });
  const data = await response.json().catch(() => ({}));
  if (data?.code !== 0 || !data?.tenant_access_token) {
    throw new Error(`Feishu token error: ${data?.msg || "unknown"}`);
  }
  const token = String(data.tenant_access_token);
  const expiresIn = Number(data.expire || 7200) || 7200;
  tenantTokenCache.set(cacheKey, {
    token,
    expiresAt: Date.now() + expiresIn * 1000,
  });
  return token;
}

export async function sendFeishuMessage(adoptId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const account = loadAccount(adoptId);
  if (!account?.appId || !account?.appSecret || !account?.openId) {
    return { ok: false, error: "feishu not bound" };
  }
  try {
    const token = await getTenantAccessToken(account);
    const response = await fetchWithTimeout(`${apiBaseUrl(account.domain)}/im/v1/messages?receive_id_type=open_id`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        receive_id: account.openId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (data?.code !== 0) {
      return { ok: false, error: data?.msg || `Feishu send failed with HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.message || "feishu send failed" };
  }
}

export async function sendFeishuBridgeMessage(adoptId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const binding = await loadBridgeBinding(adoptId);
  if (!binding?.openId) {
    return { ok: false, error: "feishu bridge not bound" };
  }
  const account = loadBridgeSenderAccount();
  if (!account?.appId || !account?.appSecret) {
    return { ok: false, error: "feishu bridge app not configured" };
  }
  try {
    const token = await getTenantAccessToken(account);
    const response = await fetchWithTimeout(`${apiBaseUrl(account.domain)}/im/v1/messages?receive_id_type=open_id`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        receive_id: binding.openId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (data?.code !== 0) {
      return { ok: false, error: data?.msg || `Feishu bridge send failed with HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.message || "feishu bridge send failed" };
  }
}

export async function sendFeishuDeliveryMessage(adoptId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const status = await getFeishuStatus(adoptId);
  if (status.deliveryMode === "bridge") return sendFeishuBridgeMessage(adoptId, text);
  if (status.deliveryMode === "account") return sendFeishuMessage(adoptId, text);
  return { ok: false, error: "feishu delivery channel not bound" };
}

function maskRouteTarget(value?: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.length <= 12) return raw;
  return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
}

export async function unbindFeishu(adoptId: string): Promise<void> {
  removeAccount(adoptId);
  await removeBridgeBinding(adoptId);
}

export function registerFeishuRoutes(app: express.Express) {
  app.get("/api/claw/feishu/status", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      res.json(await getFeishuStatus(adoptId));
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "feishu status failed" });
    }
  });

  app.post("/api/claw/feishu/init", async (_req, res) => {
    try {
      const result = await initFeishuBindFlow();
      if (!result.ok) return res.status(502).json({ supported: false, reason: result.error.detail });
      res.json(result.value);
    } catch (error: any) {
      res.status(502).json({ supported: false, reason: error?.message || "feishu init failed" });
    }
  });

  app.post("/api/claw/feishu/begin", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const result = await startFeishuBindFlow();
      if (!result.ok) return res.status(502).json({ error: result.error.detail });
      res.json(result.value);
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "feishu begin failed" });
    }
  });

  app.post("/api/claw/feishu/poll", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      const pollToken = String(req.body?.pollToken || "").trim();
      if (!adoptId || !pollToken) return res.status(400).json({ error: "adoptId and pollToken required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const result = await pollFeishuBindStatus(adoptId, Number(claw.userId), pollToken);
      if (!result.ok) return res.status(502).json({ error: result.error.detail });
      if (result.value.status === "confirmed") {
        // Do not leak channel-specific credentials (appSecret) back to the browser.
        return res.json({
          status: "confirmed",
          targetLabel: result.value.bindHandle.targetLabel || "",
        });
      }
      res.json(result.value);
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "feishu poll failed" });
    }
  });

  app.post("/api/claw/feishu/unbind", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      await unbindFeishu(adoptId);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "feishu unbind failed" });
    }
  });

  app.post("/api/claw/feishu/test", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const result = await sendFeishuDeliveryMessage(adoptId, "岗位智能体频道测试\n\n飞书频道已连接，后续定时任务可投递到这里。");
      res.json(result.ok ? { ok: true } : { ok: false, error: result.error });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error?.message || "feishu test failed" });
    }
  });

  app.get("/api/claw/channels/capabilities", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;

      const feishuBinding = await loadBridgeBinding(adoptId);
      const feishuSender = loadBridgeSenderAccount();
      const feishuConfigured = !!(feishuSender?.appId && feishuSender?.appSecret);
      const feishuBound = !!feishuBinding?.openId;
      res.json({
        adoptId,
        userId: Number(claw.userId || 0) || null,
        routeModel: "employee_adopt_channel_routes",
        channels: {
          feishu: {
            key: "feishu",
            label: "飞书",
            configured: feishuConfigured,
            bound: feishuBound,
            routeReady: feishuConfigured && feishuBound,
            bindMode: "code",
            routeMode: "openId_to_adoptId",
            targetLabel: maskRouteTarget(feishuBinding?.openId),
            boundAt: feishuBinding?.boundAt || "",
            capabilities: {
              inbound: feishuConfigured,
              outbound: feishuConfigured,
              dm: feishuConfigured,
              group: false,
              scheduleDelivery: feishuConfigured && feishuBound,
              coopNotify: feishuConfigured && feishuBound,
              files: false,
            },
            reason: !feishuConfigured ? "not_configured" : !feishuBound ? "not_bound" : null,
          },
          dingtalk: {
            key: "dingtalk",
            label: "钉钉",
            configured: false,
            bound: false,
            routeReady: false,
            bindMode: "pending",
            routeMode: "pending",
            capabilities: {
              inbound: false,
              outbound: false,
              dm: false,
              group: false,
              scheduleDelivery: false,
              coopNotify: false,
              files: false,
            },
            reason: "ea_adapter_pending",
          },
          wechat: {
            key: "wechat",
            label: "微信",
            configured: false,
            bound: false,
            routeReady: false,
            bindMode: "pending",
            routeMode: "pending",
            capabilities: {
              inbound: false,
              outbound: false,
              dm: false,
              group: false,
              scheduleDelivery: false,
              coopNotify: false,
              files: false,
            },
            reason: "waiting_jiuwenswarm_support",
          },
          wecom: {
            key: "wecom",
            label: "企业微信",
            configured: false,
            bound: false,
            routeReady: false,
            bindMode: "pending",
            routeMode: "pending",
            capabilities: {
              inbound: false,
              outbound: false,
              dm: false,
              group: false,
              scheduleDelivery: false,
              coopNotify: false,
              files: false,
            },
            reason: "waiting_jiuwenswarm_support",
          },
        },
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "channel capabilities failed" });
    }
  });

  app.get("/api/claw/feishu/bidirectional/status", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const binding = await loadBridgeBinding(adoptId);
      res.json({
        bound: !!binding?.openId,
        targetLabel: binding?.openId || "",
        chatId: binding?.chatId || "",
        boundAt: binding?.boundAt || "",
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "feishu bridge status failed" });
    }
  });

  app.post("/api/claw/feishu/bidirectional/begin", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const code = createBridgeBindCode(adoptId, Number(claw.userId || 0));
      res.json({
        code: code.code,
        expiresAt: code.expiresAt,
        instruction: `请在飞书 Bot 私聊发送：绑定 ${code.code}`,
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "feishu bridge begin failed" });
    }
  });

  app.post("/api/claw/feishu/bidirectional/unbind", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      await removeBridgeBinding(adoptId);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "feishu bridge unbind failed" });
    }
  });

  app.post("/api/internal/jiuwen/feishu/bind-code", async (req, res) => {
    try {
      if (!isAuthorizedInternalRequest(req, expectedBridgeToken())) {
        return res.status(401).json({ ok: false, error: "UNAUTHORIZED", reply: "绑定失败：服务授权未通过。" });
      }

      const code = extractBindCode(req.body?.code || req.body?.content || "");
      const openId = String(req.body?.open_id || req.body?.openId || req.body?.feishu_open_id || "").trim();
      const chatId = String(req.body?.chat_id || req.body?.chatId || req.body?.feishu_chat_id || "").trim();
      const channelId = String(req.body?.channel_id || req.body?.channelId || "feishu").trim();
      const messageId = String(req.body?.message_id || req.body?.messageId || "").trim();
      if (!code) return res.status(400).json({ ok: false, error: "code required", reply: "绑定失败：没有识别到绑定码。" });
      if (!openId) return res.status(400).json({ ok: false, error: "open_id required", reply: "绑定失败：没有获取到飞书用户身份。" });

      const codes = loadPendingCodes();
      pruneExpiredCodes(codes);
      const pending = codes[code];
      if (!pending) {
        savePendingCodes(codes);
        return res.status(404).json({ ok: false, error: "code not found", reply: "绑定码无效或已过期，请回到 EA 频道页重新生成。" });
      }

      await removeBridgeBindingsForOpenId(openId, pending.adoptId);
      await saveBridgeBinding({
        adoptId: pending.adoptId,
        userId: pending.userId,
        openId,
        chatId,
        channelId,
        messageId,
        boundAt: new Date().toISOString(),
      });
      delete codes[code];
      savePendingCodes(codes);
      return res.json({
        ok: true,
        adoptId: pending.adoptId,
        reply: "飞书已绑定到你的岗位智能体，后续可以通过这个 Bot 进行双向交互。",
      });
    } catch (error: any) {
      console.error("[FEISHU-BRIDGE] bind-code failed", error?.message || error);
      return res.status(500).json({ ok: false, error: error?.message || "bind failed", reply: "绑定失败：EA 服务处理异常。" });
    }
  });

  app.post("/api/internal/jiuwen/feishu/resolve", async (req, res) => {
    try {
      if (!isAuthorizedInternalRequest(req, expectedBridgeToken())) {
        return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
      }

      const openId = String(req.body?.open_id || req.body?.openId || req.body?.feishu_open_id || "").trim();
      const chatId = String(req.body?.chat_id || req.body?.chatId || req.body?.feishu_chat_id || "").trim();
      if (!openId) return res.status(400).json({ ok: false, error: "open_id required" });

      const binding = await loadBridgeBindingByOpenId(openId);
      console.info("[FEISHU-BRIDGE] resolve", {
        openIdHash: hashRouteId(openId),
        chatIdHash: hashRouteId(chatId),
        bound: !!binding,
        adoptId: binding?.adoptId || "",
      });
      if (!binding) {
        return res.json({
          ok: true,
          bound: false,
          reply: "还没有绑定到 EA 岗位智能体。请先在 EA 的频道页生成绑定码，然后在这里发送“绑定 绑定码”。",
        });
      }

      const sessionSuffix = sanitizeRoutePart(openId || chatId, "feishu");
      const agentId = jiuwenClawAgentId(binding.adoptId, undefined);
      const projectDir = jiuwenClawWorkspaceDir(binding.adoptId, undefined);
      return res.json({
        ok: true,
        bound: true,
        adoptId: binding.adoptId,
        userId: binding.userId,
        agentId,
        projectDir,
        sessionId: `sess_${binding.adoptId}_feishu_${sessionSuffix}`,
        sourceChannel: binding.adoptId,
      });
    } catch (error: any) {
      console.error("[FEISHU-BRIDGE] resolve failed", error?.message || error);
      return res.status(500).json({ ok: false, error: error?.message || "resolve failed" });
    }
  });
}
