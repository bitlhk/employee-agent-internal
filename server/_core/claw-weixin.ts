/**
 * Workforce Agent Platform WeChat binding facade.
 *
 * Product still calls /api/claw/weixin/*, but the implementation is now the
 * official OpenClaw channel plugin: @tencent-weixin/openclaw-weixin.
 */
import express from "express";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { isAuthorizedInternalRequest, requireClawOwner, OPENCLAW_HOME, OPENCLAW_JSON_PATH, resolveRuntimeAgentId } from "./helpers";
import { createOpenClawRuntimeAdapter } from "./runtime";
import { auditActor, auditRequest, recordAuditBestEffort } from "./audit-events";

const OPENCLAW_WEIXIN_CHANNEL = "openclaw-weixin";
const OPENCLAW_WEIXIN_STATE_DIR = path.join(OPENCLAW_HOME, "openclaw-weixin");
const OPENCLAW_WEIXIN_ACCOUNTS_DIR = path.join(OPENCLAW_WEIXIN_STATE_DIR, "accounts");
const OPENCLAW_WEIXIN_ACCOUNTS_INDEX = path.join(OPENCLAW_WEIXIN_STATE_DIR, "accounts.json");
const OPENCLAW_WEIXIN_PLUGIN_DIST = process.env.OPENCLAW_WEIXIN_PLUGIN_DIST
  || path.join(OPENCLAW_HOME, "npm/node_modules/@tencent-weixin/openclaw-weixin/dist/src");
const OPENCLAW_WEIXIN_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const OPENCLAW_WEIXIN_DEFAULT_BOT_TYPE = "3";

type OpenClawConfig = Record<string, any>;
type WeixinBindingStatus = {
  bound: boolean;
  targetLabel?: string;
  needsReactivation?: boolean;
  accountId?: string;
  userId?: string;
  setupRequired?: boolean;
};

function readJsonFile<T = any>(filePath: string): T | null {
  try {
    return existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf-8")) as T : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  renameSync(tmp, filePath);
}

function readOpenClawConfig(): OpenClawConfig {
  return readJsonFile<OpenClawConfig>(OPENCLAW_JSON_PATH) || {};
}

function writeOpenClawConfig(config: OpenClawConfig): void {
  writeJsonAtomic(OPENCLAW_JSON_PATH, config);
}

function runtimeAgentIdFor(adoptId: string, claw?: any): string {
  return resolveRuntimeAgentId(adoptId, claw?.agentId);
}

function normalizeAccountId(accountId: string): string {
  return String(accountId || "").trim().replace(/^openclaw-weixin:/, "");
}

function pendingLoginAccountId(adoptId: string): string {
  return `lingxia-${String(adoptId || "").trim().replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function accountPath(accountId: string): string {
  return path.join(OPENCLAW_WEIXIN_ACCOUNTS_DIR, `${normalizeAccountId(accountId)}.json`);
}

function loadOfficialAccount(accountId: string): any | null {
  return readJsonFile(accountPath(accountId));
}

function listOfficialAccountIds(): string[] {
  const fromIndex = readJsonFile<string[]>(OPENCLAW_WEIXIN_ACCOUNTS_INDEX);
  if (Array.isArray(fromIndex)) return fromIndex.map(normalizeAccountId).filter(Boolean);
  return [];
}

function findReusableOfficialAccount(): { accountId: string; account: any } | null {
  const accountIds = listOfficialAccountIds();
  for (let i = accountIds.length - 1; i >= 0; i--) {
    const accountId = accountIds[i];
    const account = loadOfficialAccount(accountId);
    if (account?.token) return { accountId, account };
  }
  return null;
}

function isOfficialPluginEnabled(config = readOpenClawConfig()): boolean {
  const entry = config?.plugins?.entries?.[OPENCLAW_WEIXIN_CHANNEL];
  if (entry && entry.enabled === false) return false;
  return Boolean(entry) && existsSync(path.join(OPENCLAW_WEIXIN_PLUGIN_DIST, "auth/login-qr.js"));
}

function getBindings(config = readOpenClawConfig()): any[] {
  return Array.isArray(config.bindings) ? config.bindings : [];
}

function bindingMatchesAgent(binding: any, runtimeAgentId: string): boolean {
  return binding?.agentId === runtimeAgentId && binding?.match?.channel === OPENCLAW_WEIXIN_CHANNEL;
}

function findBindingForAdopt(adoptId: string, claw?: any, config = readOpenClawConfig()): any | null {
  const runtimeAgentId = runtimeAgentIdFor(adoptId, claw);
  return getBindings(config).find((b) => bindingMatchesAgent(b, runtimeAgentId)) || null;
}

function targetFromBinding(binding: any): { accountId: string; userId: string } {
  const match = binding?.match || {};
  return {
    accountId: normalizeAccountId(match.accountId || ""),
    userId: String(match.peer?.id || "").trim(),
  };
}

function upsertOpenClawWeixinBinding(params: {
  adoptId: string;
  claw: any;
  accountId: string;
  userId?: string;
}): void {
  const accountId = normalizeAccountId(params.accountId);
  if (!accountId) throw new Error("openclaw-weixin accountId missing after login");

  const config = readOpenClawConfig();
  const runtimeAgentId = runtimeAgentIdFor(params.adoptId, params.claw);
  const userId = String(params.userId || "").trim();

  config.plugins = config.plugins || {};
  config.plugins.entries = config.plugins.entries || {};
  config.plugins.entries[OPENCLAW_WEIXIN_CHANNEL] = {
    ...(config.plugins.entries[OPENCLAW_WEIXIN_CHANNEL] || {}),
    enabled: true,
  };

  config.channels = config.channels || {};
  const channelConfig = config.channels[OPENCLAW_WEIXIN_CHANNEL] || {};
  channelConfig.accounts = channelConfig.accounts || {};
  channelConfig.accounts[accountId] = {
    ...(channelConfig.accounts[accountId] || {}),
    enabled: true,
    name: `Workforce Agent Platform ${params.adoptId}`,
  };
  channelConfig.defaultAccount = channelConfig.defaultAccount || accountId;
  channelConfig.channelConfigUpdatedAt = new Date().toISOString();
  config.channels[OPENCLAW_WEIXIN_CHANNEL] = channelConfig;

  const nextBindings = getBindings(config).filter((b) => {
    if (bindingMatchesAgent(b, runtimeAgentId)) return false;
    if (b?.match?.channel === OPENCLAW_WEIXIN_CHANNEL && normalizeAccountId(b?.match?.accountId || "") === accountId) {
      return false;
    }
    return true;
  });

  nextBindings.push({
    match: {
      channel: OPENCLAW_WEIXIN_CHANNEL,
      accountId,
      ...(userId ? { peer: { kind: "direct", id: userId } } : {}),
    },
    agentId: runtimeAgentId,
  });
  config.bindings = nextBindings;

  writeOpenClawConfig(config);
}

function removeOpenClawWeixinBinding(adoptId: string, claw: any): { accountId: string; userId: string } {
  const config = readOpenClawConfig();
  const binding = findBindingForAdopt(adoptId, claw, config);
  const target = targetFromBinding(binding);
  const runtimeAgentId = runtimeAgentIdFor(adoptId, claw);
  config.bindings = getBindings(config).filter((b) => !bindingMatchesAgent(b, runtimeAgentId));
  if (config.channels?.[OPENCLAW_WEIXIN_CHANNEL]) {
    config.channels[OPENCLAW_WEIXIN_CHANNEL].channelConfigUpdatedAt = new Date().toISOString();
  }
  writeOpenClawConfig(config);
  return target;
}

export function cleanupOpenClawWeixinBindingForAdopt(adoptId: string, claw: any): { removed: boolean; accountId: string; userId: string } {
  const target = removeOpenClawWeixinBinding(adoptId, claw);
  return { removed: Boolean(target.accountId), accountId: target.accountId, userId: target.userId };
}

function installHint(): string {
  return "请先在服务器安装并启用官方微信插件：npx -y @tencent-weixin/openclaw-weixin-cli install";
}

function statusFromBinding(binding: any | null, config = readOpenClawConfig()): WeixinBindingStatus {
  if (!binding) return { bound: false, setupRequired: !isOfficialPluginEnabled(config) };
  const { accountId, userId: bindingUserId } = targetFromBinding(binding);
  const account = accountId ? loadOfficialAccount(accountId) : null;
  const userId = bindingUserId || String(account?.userId || "").trim();
  return {
    bound: Boolean(accountId && account?.token),
    accountId,
    userId,
    targetLabel: userId || accountId,
    setupRequired: !isOfficialPluginEnabled(config),
  };
}

function callOpenClawRpc<T = any>(method: string, params: Record<string, any>, timeoutMs = 40000): T {
  return createOpenClawRuntimeAdapter().callRpc<T>(method, {
    ...params,
    timeoutMs: params.timeoutMs ?? timeoutMs,
  });
}

async function importWeixinPluginModule<T = any>(relativePath: string): Promise<T> {
  const filePath = path.join(OPENCLAW_WEIXIN_PLUGIN_DIST, relativePath);
  if (!existsSync(filePath)) throw new Error(`openclaw-weixin plugin module missing: ${filePath}`);
  return await import(pathToFileURL(filePath).href) as T;
}

async function startOfficialWeixinLogin(accountId: string): Promise<{ qrcodeUrl?: string; message?: string }> {
  const mod = await importWeixinPluginModule<{
    startWeixinLoginWithQr: (params: Record<string, any>) => Promise<{ qrcodeUrl?: string; message?: string }>;
  }>("auth/login-qr.js");
  return await mod.startWeixinLoginWithQr({
    accountId,
    apiBaseUrl: loadOfficialAccount(accountId)?.baseUrl?.trim() || OPENCLAW_WEIXIN_DEFAULT_BASE_URL,
    botType: OPENCLAW_WEIXIN_DEFAULT_BOT_TYPE,
    force: true,
    verbose: false,
  });
}

async function waitOfficialWeixinLogin(accountId: string): Promise<{ connected?: boolean; alreadyConnected?: boolean; message?: string; accountId?: string; botToken?: string; baseUrl?: string; userId?: string }> {
  const mod = await importWeixinPluginModule<{
    waitForWeixinLogin: (params: Record<string, any>) => Promise<{ connected?: boolean; alreadyConnected?: boolean; message?: string; accountId?: string; botToken?: string; baseUrl?: string; userId?: string }>;
  }>("auth/login-qr.js");
  return await mod.waitForWeixinLogin({
    sessionKey: accountId,
    apiBaseUrl: loadOfficialAccount(accountId)?.baseUrl?.trim() || OPENCLAW_WEIXIN_DEFAULT_BASE_URL,
    timeoutMs: 15000,
  });
}

async function saveOfficialWeixinAccount(result: { accountId?: string; botToken?: string; baseUrl?: string; userId?: string }): Promise<string> {
  const accountId = normalizeAccountId(result.accountId || "");
  if (!accountId || !result.botToken) throw new Error("openclaw-weixin login result missing account credentials");
  const accounts = await importWeixinPluginModule<{
    saveWeixinAccount: (accountId: string, data: Record<string, any>) => void;
    registerWeixinAccountId: (accountId: string) => void;
    clearStaleAccountsForUserId: (accountId: string, userId: string, onClearContextTokens?: (accountId: string) => void) => void;
  }>("auth/accounts.js");
  accounts.saveWeixinAccount(accountId, {
    token: result.botToken,
    baseUrl: result.baseUrl,
    userId: result.userId,
  });
  accounts.registerWeixinAccountId(accountId);
  if (result.userId) accounts.clearStaleAccountsForUserId(accountId, result.userId);
  return accountId;
}

function sendOfficialWeixinMessage(accountId: string, target: string, text: string): void {
  execFileSync("openclaw", [
    "message", "send",
    "--channel", OPENCLAW_WEIXIN_CHANNEL,
    "--account", accountId,
    "--target", target,
    "--message", text,
    "--json",
  ], { encoding: "utf-8", timeout: 45000 });
}

export async function sendWeixinMessage(adoptId: string, chatId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const config = readOpenClawConfig();
  const binding = findBindingForAdopt(adoptId, undefined, config);
  const status = statusFromBinding(binding, config);
  if (!status.bound || !status.accountId) return { ok: false, error: "weixin not bound" };
  const target = String(chatId || status.userId || "").trim();
  if (!target) return { ok: false, error: "weixin target missing; send a WeChat message to the bot first" };
  try {
    sendOfficialWeixinMessage(status.accountId, target, text);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export function getWeixinStatus(adoptId: string): WeixinBindingStatus {
  return statusFromBinding(findBindingForAdopt(adoptId));
}

export async function desktopStartWeixinBind(adoptId: string): Promise<
  | { ok: true; qrCode: string; pollToken: string }
  | { ok: false; error: string }
> {
  if (!isOfficialPluginEnabled()) {
    return { ok: false, error: "微信插件未启用，请联系管理员" };
  }
  const loginAccountId = pendingLoginAccountId(adoptId);
  const result = await startOfficialWeixinLogin(loginAccountId);
  if (!result.qrcodeUrl) {
    return { ok: false, error: result.message || "获取微信二维码失败" };
  }
  return { ok: true, qrCode: result.qrcodeUrl, pollToken: loginAccountId };
}

export async function desktopPollWeixinBind(
  adoptId: string,
  claw: any,
  pollToken: string,
): Promise<
  | { status: "confirmed"; targetLabel: string }
  | { status: "wait" }
  | { status: "expired" }
> {
  const result = await waitOfficialWeixinLogin(pollToken);
  if (!result.connected) {
    if (result.alreadyConnected) {
      const reusable = findReusableOfficialAccount();
      if (reusable) {
        const userId = String(reusable.account?.userId || "").trim();
        upsertOpenClawWeixinBinding({ adoptId, claw, accountId: reusable.accountId, userId });
        return { status: "confirmed", targetLabel: userId || reusable.accountId };
      }
    }
    if (String(result.message || "").toLowerCase().includes("expired")) {
      return { status: "expired" };
    }
    return { status: "wait" };
  }
  const accountId = await saveOfficialWeixinAccount(result);
  const account = accountId ? loadOfficialAccount(accountId) : null;
  const userId = String(account?.userId || result.userId || "").trim();
  upsertOpenClawWeixinBinding({ adoptId, claw, accountId, userId });
  return { status: "confirmed", targetLabel: userId || accountId };
}

export function registerWeixinRoutes(app: express.Express) {
  app.get("/api/claw/weixin/status", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      let claw: any;
      if (isAuthorizedInternalRequest(req)) {
        const { getClawByAdoptId } = await import("../db");
        claw = await getClawByAdoptId(adoptId);
        if (!claw) return res.status(404).json({ error: "NOT_FOUND" });
      } else {
        claw = await requireClawOwner(req, res, adoptId);
        if (!claw) return;
      }
      const config = readOpenClawConfig();
      const status = statusFromBinding(findBindingForAdopt(adoptId, claw, config), config);
      res.json({
        bound: status.bound,
        userId: status.userId || status.accountId || "",
        accountId: status.accountId || "",
        targetLabel: status.targetLabel || "",
        needsReactivation: false,
        setupRequired: status.setupRequired,
        setupHint: status.setupRequired ? installHint() : undefined,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/claw/weixin/qrcode", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      if (!isOfficialPluginEnabled()) {
        return res.status(503).json({ error: "openclaw_weixin_plugin_not_enabled", message: installHint() });
      }
      const loginAccountId = pendingLoginAccountId(adoptId);
      const result = await startOfficialWeixinLogin(loginAccountId);
      if (!result.qrcodeUrl) {
        return res.status(502).json({ error: "openclaw_weixin_qr_missing", message: result.message || "OpenClaw did not return a WeChat QR code" });
      }
      res.json({ qrcode: loginAccountId, qrcodeUrl: result.qrcodeUrl });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/claw/weixin/qrstatus", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      const sessionKey = String(req.query.qrcode || "").trim();
      if (!adoptId || !sessionKey) return res.status(400).json({ error: "adoptId and qrcode required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;

      const result = await waitOfficialWeixinLogin(sessionKey);
      if (!result.connected) {
        if (result.alreadyConnected) {
          const reusable = findReusableOfficialAccount();
          if (reusable) {
            const userId = String(reusable.account?.userId || "").trim();
            upsertOpenClawWeixinBinding({ adoptId, claw, accountId: reusable.accountId, userId });
            await recordAuditBestEffort({
              action: "channel.weixin.bound",
              ...auditActor({ id: claw.userId }),
              ...auditRequest(req),
              targetType: "agent",
              targetId: adoptId,
              targetName: String(claw.agentId || ""),
              agentInstanceId: adoptId,
              runtimeType: "openclaw",
              runtimeAgentId: runtimeAgentIdFor(adoptId, claw),
              channel: "weixin",
              metadata: {
                reusedAccount: true,
                accountIdPresent: Boolean(reusable.accountId),
                userIdPresent: Boolean(userId),
              },
            });
            return res.json({ status: "confirmed", userId: userId || reusable.accountId, accountId: reusable.accountId });
          }
          return res.json({ status: "wait", message: result.message || "already connected but no local account was found" });
        }
        const msg = String(result.message || "").toLowerCase();
        if (msg.includes("expired")) return res.json({ status: "expired" });
        return res.json({ status: "wait", message: result.message || "" });
      }

      const accountId = await saveOfficialWeixinAccount(result);
      const account = accountId ? loadOfficialAccount(accountId) : null;
      const userId = String(account?.userId || "").trim();
      upsertOpenClawWeixinBinding({ adoptId, claw, accountId, userId });
      await recordAuditBestEffort({
        action: "channel.weixin.bound",
        ...auditActor({ id: claw.userId }),
        ...auditRequest(req),
        targetType: "agent",
        targetId: adoptId,
        targetName: String(claw.agentId || ""),
        agentInstanceId: adoptId,
        runtimeType: "openclaw",
        runtimeAgentId: runtimeAgentIdFor(adoptId, claw),
        channel: "weixin",
        metadata: {
          reusedAccount: false,
          accountIdPresent: Boolean(accountId),
          userIdPresent: Boolean(userId),
        },
      });
      res.json({ status: "confirmed", userId: userId || accountId, accountId });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/claw/weixin/unbind", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const { accountId } = removeOpenClawWeixinBinding(adoptId, claw);
      if (accountId) {
        try {
          callOpenClawRpc("channels.logout", { channel: OPENCLAW_WEIXIN_CHANNEL, accountId }, 25000);
        } catch {}
      }
      await recordAuditBestEffort({
        action: "channel.weixin.unbound",
        ...auditActor({ id: claw.userId }),
        ...auditRequest(req),
        targetType: "agent",
        targetId: adoptId,
        targetName: String(claw.agentId || ""),
        agentInstanceId: adoptId,
        runtimeType: "openclaw",
        runtimeAgentId: runtimeAgentIdFor(adoptId, claw),
        channel: "weixin",
        metadata: {
          accountIdPresent: Boolean(accountId),
        },
      });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/claw/weixin/test", async (req, res) => {
    try {
      const adoptId = String(req.body?.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const config = readOpenClawConfig();
      const status = statusFromBinding(findBindingForAdopt(adoptId, claw, config), config);
      if (!status.bound || !status.accountId) return res.json({ ok: false, error: "weixin not bound" });
      const target = String(status.userId || "").trim();
      if (!target) return res.json({ ok: false, error: "weixin target missing; send a WeChat message to the bot first" });
      sendOfficialWeixinMessage(status.accountId, target, "岗位智能体通知测试\n\n微信绑定成功！这条消息来自岗位智能体平台。");
      res.json({ ok: true });
    } catch (e: any) {
      res.json({ ok: false, error: e.message });
    }
  });
}
