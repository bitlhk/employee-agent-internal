// 测试模式：仅当非生产环境显式设置 TEST_MODE=true 时启用（默认关闭）
export const TEST_MODE = process.env.NODE_ENV !== "production" && process.env.TEST_MODE === "true";

import path from "path";
import { privateMessageLogFields } from "../_core/log-privacy";
import { appendRetainedJsonLog } from "../_core/retained-json-log";

const processHome = process.env.HOME || process.env.USERPROFILE || "/root";

function expandHomePath(raw: string): string {
  const value = String(raw || "").trim();
  if (!value) return value;
  if (value === "~") return processHome;
  if (value.startsWith("~/")) return path.join(processHome, value.slice(2));
  return value;
}

function normalizeOpenClawHome(raw?: string): string {
  const value = expandHomePath(
    raw
      || process.env.CLAW_OPENCLAW_HOME
      || process.env.CLAW_REMOTE_OPENCLAW_HOME
      || process.env.OPENCLAW_HOME
      || processHome
  );
  return path.basename(value) === ".openclaw" ? value : path.join(value, ".openclaw");
}

export const APP_ROOT = process.env.APP_ROOT || process.cwd();
export const OPENCLAW_HOME = normalizeOpenClawHome();

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import {
  getClawByAdoptId,
  getSystemConfigValue,
  getSystemConfigNumber,
  createIpAccessLog,
  getIpAccessCountToday,
} from "../db";
import { getClientIp } from "../_core/ip-utils";

export const OPENCLAW_JSON_PATH = expandHomePath(process.env.CLAW_OPENCLAW_JSON || path.join(OPENCLAW_HOME, "openclaw.json"));

// ── 每日对话额度：内存计数器（重启自动清零） ──
export const clawDailyUsage = (() => {
  const map = new Map<string, { count: number; date: string }>();
  const today = () => new Date().toISOString().slice(0, 10);
  return {
    increment(adoptId: string): number {
      const d = today();
      const entry = map.get(adoptId);
      if (!entry || entry.date !== d) {
        map.set(adoptId, { count: 1, date: d });
        return 1;
      }
      entry.count++;
      return entry.count;
    },
    get(adoptId: string): number {
      const entry = map.get(adoptId);
      return entry && entry.date === today() ? entry.count : 0;
    },
  };
})();

type ClawModelOption = { id: string; name: string; desc?: string; isDefault?: boolean };
const DEFAULT_FRONTEND_MODEL_FALLBACKS = ["modelarts-maas/glm-5.2", "maas/deepseek-v4-flash"];

const FRONTEND_MODEL_ALLOWLIST = new Set<string>(
  String(process.env.WORKFORCE_AGENT_FRONTEND_MODEL_ALLOWLIST || process.env.LINGXIA_FRONTEND_MODEL_ALLOWLIST || process.env.FRONTEND_MODEL_ALLOWLIST || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

function isFrontendModelAllowed(modelId: string): boolean {
  if (FRONTEND_MODEL_ALLOWLIST.size === 0) return true;
  return FRONTEND_MODEL_ALLOWLIST.has(modelId);
}

function modelDisplayName(modelId: string): string {
  if (modelId === "modelarts-maas/glm-5.2") return "GLM-5.2（默认）";
  if (modelId === "modelarts-maas/glm-5.1") return "GLM-5.1（默认）";
  if (modelId === "maas/deepseek-v4-flash") return "DeepSeek-V4-Flash";
  if (modelId === "openai/gpt-5.5") return "GPT-5.5";
  return modelId;
}

function configuredFrontendFallbackModelIds(): string[] {
  const explicit = String(
    process.env.WORKFORCE_AGENT_FRONTEND_MODEL_FALLBACKS
    || process.env.LINGXIA_FRONTEND_MODEL_FALLBACKS
      || process.env.FRONTEND_MODEL_FALLBACKS
      || process.env.DEFAULT_FRONTEND_MODEL
      || process.env.CLAW_AGENT_MODEL
      || ""
  )
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return explicit.length > 0 ? explicit : DEFAULT_FRONTEND_MODEL_FALLBACKS;
}

export function getFrontendModelFallbacks(): ClawModelOption[] {
  return configuredFrontendFallbackModelIds()
    .filter(isFrontendModelAllowed)
    .map((id, index) => ({
      id,
      name: modelDisplayName(id),
      desc: "fallback",
      isDefault: index === 0,
    }));
}

export function getAvailableClawModelsFromConfig(): ClawModelOption[] {
  try {
    const raw = readFileSync(OPENCLAW_JSON_PATH, "utf8");
    const cfg = JSON.parse(raw || "{}");
    const providers = cfg?.models?.providers || {};
    const out: ClawModelOption[] = [];
    const defaultsModel = cfg?.agents?.defaults?.model || {};
    const defaultsPrimary = String(defaultsModel?.primary || "").trim();
    const modelAllowlist = cfg?.agents?.defaults?.models && typeof cfg.agents.defaults.models === "object"
      ? Object.keys(cfg.agents.defaults.models).map((id) => String(id).trim()).filter(Boolean)
      : [];

    if (modelAllowlist.length > 0) {
      const visibleAllowlist = modelAllowlist
        .filter(isFrontendModelAllowed)
        .map((id) => ({
          id,
          name: id,
          desc: "agents.defaults.models",
          isDefault: id === defaultsPrimary,
        }));
      if (visibleAllowlist.length > 0) {
        return visibleAllowlist.map((item, index, arr) => {
          if (arr.some((m) => m.isDefault)) return item;
          return index === 0 ? { ...item, isDefault: true } : item;
        });
      }
    }

    // 1) providers.models
    for (const [providerId, provider] of Object.entries<any>(providers)) {
      const models = Array.isArray(provider?.models) ? provider.models : [];
      for (const m of models) {
        const mid = String(m?.id || "").trim();
        if (!mid) continue;
        const fullId = `${providerId}/${mid}`;
        out.push({
          id: fullId,
          name: String(m?.name || mid),
          desc: `provider=${providerId}`,
        });
      }
    }

    // 2) agents.defaults.model.primary（即使 providers.models 为空也纳入）
    if (defaultsPrimary) {
      out.push({ id: defaultsPrimary, name: defaultsPrimary, desc: "defaults.primary", isDefault: true });
    }

    // 3) agents.list[].model（历史切换留下的显式模型）
    const list = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
    for (const a of list) {
      const mv = a?.model;
      if (typeof mv === "string" && mv.trim()) {
        out.push({ id: mv.trim(), name: mv.trim(), desc: "agent.override" });
      } else if (mv && typeof mv === "object") {
        const p = String((mv as any)?.primary || "").trim();
        if (p) out.push({ id: p, name: p, desc: "agent.override" });
      }
    }

    // 去重（按 id）— 后续 isDefault 可覆盖先前条目的 flag，保留原 name/desc
    const uniq = new Map<string, ClawModelOption>();
    for (const item of out) {
      const prev = uniq.get(item.id);
      if (!prev) uniq.set(item.id, item);
      else if (item.isDefault && !prev.isDefault) uniq.set(item.id, { ...prev, isDefault: true });
    }

    if (uniq.size === 0) {
      for (const item of getFrontendModelFallbacks()) {
        uniq.set(item.id, item);
      }
    }

    // Deployments may optionally restrict the frontend model selector with
    // WORKFORCE_AGENT_FRONTEND_MODEL_ALLOWLIST. By default, mirror OpenClaw config.
    for (const k of Array.from(uniq.keys())) {
      if (!isFrontendModelAllowed(k)) uniq.delete(k);
    }

    // 确保有且仅有一个 isDefault（优先保留 defaults.primary，否则标第一个）
    const arr = Array.from(uniq.values());
    const hasDefault = arr.some((m) => m.isDefault);
    if (!hasDefault && arr.length > 0) arr[0] = { ...arr[0], isDefault: true };
    return arr;
  } catch {
    return getFrontendModelFallbacks();
  }
}

export function setAgentModelInOpenclawConfig(agentId: string, modelId: string): { ok: boolean; error?: string } {
  try {
    const raw = readFileSync(OPENCLAW_JSON_PATH, "utf8");
    const cfg = JSON.parse(raw || "{}");
    const agents = cfg?.agents?.list;
    if (!Array.isArray(agents)) {
      return { ok: false, error: "agents.list missing" };
    }

    let found = false;
    for (const a of agents) {
      if (String(a?.id || "") === agentId) {
        a.model = modelId;
        found = true;
        break;
      }
    }
    if (!found) return { ok: false, error: "agent not found" };

    writeFileSync(OPENCLAW_JSON_PATH, JSON.stringify(cfg, null, 2), "utf8");
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}


export function buildClawSessionKey(adoptId: string, userId: number) {
  return `lingganclaw:user:${userId}:adopt:${adoptId}`;
}

export async function assertClawOwnerOrThrow(ctx: { user?: { id?: number | string } | null }, adoptId: string) {
  const userId = Number(ctx.user?.id || 0);
  if (!userId) throw new TRPCError({ code: "UNAUTHORIZED" });

  const claw = await getClawByAdoptId(adoptId);
  if (!claw) throw new TRPCError({ code: "NOT_FOUND" });

  if (Number((claw as any).userId || 0) !== userId) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return claw;
}


export function bumpClawSessionEpochBestEffort(adoptId: string) {
  try {
    const p = `${APP_ROOT}/data/claw-session-epochs.json`;
    let obj: any = {};
    if (existsSync(p)) {
      const raw = String(readFileSync(p, "utf-8") || "{}");
      obj = JSON.parse(raw || "{}");
    }
    const next = (Number(obj?.[adoptId] || 0) || 0) + 1;
    obj[adoptId] = next;
    mkdirSync(`${APP_ROOT}/data`, { recursive: true });
    writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8');
    return next;
  } catch {
    return 0;
  }
}

export async function applyClawSessionModelViaGatewayCommand(params: { agentId: string; sessionKey: string; modelId: string }) {
  const remoteHost = process.env.CLAW_REMOTE_HOST || "127.0.0.1";
  const gatewayPort = parseInt(process.env.CLAW_GATEWAY_PORT || "18789", 10);
  const gatewayToken = process.env.CLAW_GATEWAY_TOKEN || "";

  const body = JSON.stringify({
    model: "openclaw",
    stream: false,
    messages: [{ role: "user", content: `/model ${params.modelId}` }],
  });

  const http = await import("http");

  return await new Promise<{ ok: boolean; statusCode?: number; respText?: string; error?: string }>((resolve) => {
    const req = http.request(
      {
        hostname: remoteHost,
        port: gatewayPort,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Authorization": `Bearer ${gatewayToken}`,
          "x-openclaw-agent-id": params.agentId,
          "x-openclaw-session-key": params.sessionKey,
        },
      },
      (res: any) => {
        let buf = "";
        res.on("data", (c: any) => (buf += c.toString("utf8")));
        res.on("end", () => {
          resolve({ ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, statusCode: res.statusCode, respText: buf.slice(0, 2000) });
        });
      }
    );
    req.on("error", (err: any) => resolve({ ok: false, error: String(err?.message || err) }));
    req.write(body);
    req.end();
  });
}

export function restartOpenclawGatewayBestEffort() {
  // hot-switch mode: do NOT restart gateway from control-ui backend
  return;
}


/**
 * 岗位智能体实例编排（MVP）
 *
 * CLAW_PROVISION_MODE=mock         -> 仅占位成功（默认）
 * CLAW_PROVISION_MODE=local-script -> 调用本地脚本真实创建
 */
export function provisionEmployeeAgentInstance(params: {
  adoptId: string;
  agentId: string;
  userId: number;
  permissionProfile: "starter" | "plus" | "internal";
  ttlDays: number;
}) {
  const mode = (process.env.CLAW_PROVISION_MODE || "mock").trim();

  if (mode === "mock") {
    return {
      ok: true,
      mode,
      message: "mock provisioned",
    } as const;
  }

  if (mode === "local-script") {
    const scriptPath = process.env.CLAW_PROVISION_SCRIPT || "./scripts/claw-provision.sh";
    const cmd = [
      "bash",
      scriptPath,
      "create",
      `--adopt-id=${params.adoptId}`,
      `--agent-id=${params.agentId}`,
      `--user-id=${params.userId}`,
      `--profile=${params.permissionProfile}`,
      `--ttl-days=${params.ttlDays}`,
    ].join(" ");

    const out = execSync(cmd, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    }).trim();

    let parsed: any = null;
    try {
      parsed = out ? JSON.parse(out) : null;
    } catch {
      parsed = { raw: out };
    }

    return {
      ok: true,
      mode,
      result: parsed,
    } as const;
  }

  throw new Error(`Unsupported CLAW_PROVISION_MODE: ${mode}`);
}



export function writeClawExecAudit(entry: {
  adoptId: string;
  agentId: string;
  userId: number | string | null;
  permissionProfile: string;
  message: string;
  ok: boolean;
  durationMs?: number;
  error?: string;
  meta?: any;
}) {
  try {
    const payload = {
      ts: new Date().toISOString(),
      event: "claw_exec",
      ...entry,
      message: undefined,
      messageType: String(entry.message || "").startsWith("admin_") ? "operation" : "user_input",
      ...privateMessageLogFields(entry.message),
    };
    void appendRetainedJsonLog(`${APP_ROOT}/logs/claw-exec.log`, payload).catch(() => {});
  } catch {
    // ignore
  }
}

/**
 * 检查并记录IP访问（未注册用户）
 * 返回是否允许访问
 * 注意：登录/注册操作不受访问次数限制，允许用户随时登录/注册
 */
export async function checkAndRecordIpAccess(
  req: any,
  action: string,
  userId?: number
): Promise<{ allowed: boolean; message?: string }> {
  const clientIP = getClientIp(req);

  // 如果已登录，不限制，直接记录访问日志
  if (userId) {
    try {
      await createIpAccessLog({
        ip: clientIP,
        action,
        path: req.path || "",
        userAgent: req.headers["user-agent"] || null,
        userId: userId,
      });
    } catch (error) {
      console.error("[IP Access] Failed to record access log:", error);
    }
    return { allowed: true };
  }

  // 登录/注册操作：不受访问次数限制，允许用户随时登录/注册
  // 只记录访问日志，不进行限制检查
  if (action === "login" || action === "register") {
    try {
      await createIpAccessLog({
        ip: clientIP,
        action,
        path: req.path || "",
        userAgent: req.headers["user-agent"] || null,
        userId: null,
      });
      console.log(`[IP Access] ${action} action recorded - IP: ${clientIP} (no limit check)`);
    } catch (error) {
      console.error("[IP Access] Failed to record access log:", error);
    }
    return { allowed: true };
  }

  // 其他操作：检查访问次数限制
  // 注意：这个函数现在主要用于登录/注册，其他操作应该使用 recordExperienceClick
  try {
    // 获取配置的每日限制（默认10次）
    const dailyLimit = await getSystemConfigNumber("unregistered_daily_limit", 10);

    // 获取今日体验按钮点击次数（不包括本次访问）
    const { getIpAuthAccessCountToday } = await import("../db");
    const todayCount = await getIpAuthAccessCountToday(clientIP);

    // 检查是否超过限制（在记录本次访问之前）
    if (todayCount >= dailyLimit) {
      // 即使超过限制，也记录这次尝试访问（用于统计和分析）
      try {
        await createIpAccessLog({
          ip: clientIP,
          action,
          path: req.path || "",
          userAgent: req.headers["user-agent"] || null,
          userId: null,
        });
      } catch (error) {
        console.error("[IP Access] Failed to record blocked access log:", error);
      }

      return {
        allowed: false,
        message: `今日访问次数已达上限（${dailyLimit}次），请明天再试或注册账号后继续使用`,
      };
    }

    // 允许访问，记录本次访问
    try {
      await createIpAccessLog({
        ip: clientIP,
        action,
        path: req.path || "",
        userAgent: req.headers["user-agent"] || null,
        userId: null,
      });
    } catch (error) {
      console.error("[IP Access] Failed to record access log:", error);
    }

    return { allowed: true };
  } catch (error) {
    console.error("[IP Access] Failed to check IP access:", error);
    // 如果检查失败，允许访问（避免阻塞正常请求）
    return { allowed: true };
  }
}
