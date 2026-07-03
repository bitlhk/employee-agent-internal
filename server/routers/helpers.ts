// 测试模式：仅当非生产环境显式设置 TEST_MODE=true 时启用（默认关闭）
export const TEST_MODE = process.env.NODE_ENV !== "production" && process.env.TEST_MODE === "true";

import path from "path";

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
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import {
  getClawByAdoptId,
  getSystemConfigValue,
  getSystemConfigNumber,
  upsertSystemConfig,
  getAllExperienceConfigs,
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

export type DemoPublishStatus = {
  status: "success" | "failed" | "running";
  at: string;
  error?: string;
};

export const DEMO_PUBLISH_STATUS_KEY = "demo_route_publish_status_v1";
export const DEMO_PUBLISH_META_KEY = "demo_route_publish_meta_v1";

export const IFRAME_BYPASS_KEY = "iframe_bypass_experience_ids";

type ClawModelOption = { id: string; name: string; desc?: string; isDefault?: boolean };
const DEFAULT_FRONTEND_MODEL_FALLBACKS = ["modelarts-maas/glm-5.2", "maas/deepseek-v4-flash"];

const FRONTEND_MODEL_ALLOWLIST = new Set<string>(
  String(process.env.LINGXIA_FRONTEND_MODEL_ALLOWLIST || process.env.FRONTEND_MODEL_ALLOWLIST || "")
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
    process.env.LINGXIA_FRONTEND_MODEL_FALLBACKS
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
    // LINGXIA_FRONTEND_MODEL_ALLOWLIST. By default, mirror OpenClaw config.
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
 * 员工智能体实例编排（MVP）
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
    const logDir = `${APP_ROOT}/logs`;
    mkdirSync(logDir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event: "claw_exec",
      ...entry,
      message: String(entry.message || "").slice(0, 500),
    });
    appendFileSync(`${logDir}/claw-exec.log`, line + "\n", "utf8");
  } catch {
    // ignore
  }
}
export async function ensureIframeBypassExperienceId(experienceId: string, updatedBy?: number) {
  const raw = await getSystemConfigValue(IFRAME_BYPASS_KEY, "");
  const set = new Set(
    (raw || "")
      .split(/[\n,]/g)
      .map((x) => x.trim())
      .filter(Boolean)
  );

  if (set.has(experienceId)) return { changed: false };

  set.add(experienceId);
  const value = Array.from(set).join("\n");

  await upsertSystemConfig(
    {
      key: IFRAME_BYPASS_KEY,
      value,
      description: "不走 iframe 的体验ID列表：每行一个 experienceId，首页将直接打开原始 URL",
    },
    updatedBy
  );

  return { changed: true };
}


export async function readDemoPublishStatusMap(): Promise<Record<string, DemoPublishStatus>> {
  const raw = await getSystemConfigValue(DEMO_PUBLISH_STATUS_KEY, "{}");
  try {
    const obj = JSON.parse(raw || "{}");
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

export async function writeDemoPublishStatusMap(map: Record<string, DemoPublishStatus>, updatedBy?: number) {
  await upsertSystemConfig(
    {
      key: DEMO_PUBLISH_STATUS_KEY,
      value: JSON.stringify(map),
      description: "demo 路由发布状态（按 experienceId）",
    },
    updatedBy
  );
}

export async function publishDemoRoutingNow(updatedBy?: number): Promise<{ ok: boolean; message: string }> {
  const activeConfigs = (await getAllExperienceConfigs("all")).filter((c: any) => c.status === "active" && c.url);
  const statusMap = await readDemoPublishStatusMap();
  const nowIso = new Date().toISOString();

  for (const c of activeConfigs as any[]) {
    statusMap[c.experienceId] = { status: "running", at: nowIso };
  }
  await writeDemoPublishStatusMap(statusMap, updatedBy);

  let nginxSitePath = process.env.NGINX_SITE_PATH || "/etc/nginx/sites-available/finance-ai-landing";
  let nginxBackupPath = "";

  try {
    const demoDomain = process.env.DEMO_ROUTE_DOMAIN || "demo.example.com";
    const siteDomain = process.env.SITE_DOMAIN || "www.example.com";
    nginxSitePath = process.env.NGINX_SITE_PATH || "/etc/nginx/sites-available/finance-ai-landing";
    const envPath = process.env.DEPLOY_ENV_PATH || "/opt/finance-ai-landing-new/finance-ai-landing/.env.deploy";

    const items: Array<{ id: string; upstream: string; hostHeader: string }> = [];
    for (const c of activeConfigs as any[]) {
      try {
        const u = new URL(c.url);
        if (!["http:", "https:"].includes(u.protocol)) continue;
        items.push({
          id: c.experienceId,
          upstream: `${u.protocol}//${u.host}`,
          hostHeader: u.host,
        });
      } catch {
        continue;
      }
    }

    const mapUp = ["map $host $demo_upstream {", '    default "";'];
    const mapHost = ["map $host $demo_host_header {", '    default "";'];
    const envPairs: string[] = [];

    for (const it of items) {
      const sub = `${it.id}.${demoDomain}`;
      // 防止将 demo 域名回写为自己的 upstream（自引用会导致路由死循环）
      if (it.hostHeader === sub) {
        console.warn(`[PublishDemoRouting] skip self-referenced upstream: ${it.id} -> ${it.hostHeader}`);
        continue;
      }
      mapUp.push(`    ${sub} ${it.upstream};`);
      mapHost.push(`    ${sub} ${it.hostHeader};`);
      envPairs.push(`${it.id}=${sub}`);
    }
    mapUp.push("}");
    mapHost.push("}");

    const mapConn = [
      "map $http_upgrade $connection_upgrade {",
      "    default upgrade;",
      '    "" close;',
      "}",
    ];

    const generatedMapBlock = `${mapUp.join("\n")}\n\n${mapHost.join("\n")}\n\n${mapConn.join("\n")}\n`;

    const existingConf = readFileSync(nginxSitePath, "utf8");
    // 只替换 map 区块，保留现有 server(80/443/专属路由) 以避免覆盖手工增强配置
    const mapBlockRegex = /map \$host \$demo_upstream \{[\s\S]*?\}\n\nmap \$host \$demo_host_header \{[\s\S]*?\}\n(?:\nmap \$http_upgrade \$connection_upgrade \{[\s\S]*?\}\n)?/m;
    const conf = mapBlockRegex.test(existingConf)
      ? existingConf.replace(mapBlockRegex, `${generatedMapBlock}\n`)
      : `${generatedMapBlock}\n${existingConf}`;

    // 发布前备份，失败可回滚
    nginxBackupPath = `${nginxSitePath}.bak-publish-${Date.now()}`;
    writeFileSync(nginxBackupPath, existingConf, "utf8");
    writeFileSync(nginxSitePath, conf, "utf8");

    // 同步到 sites-enabled（nginx 实际读取的路径）
    const sitesEnabledPath = nginxSitePath.replace("/sites-available/", "/sites-enabled/");
    if (sitesEnabledPath !== nginxSitePath) {
      writeFileSync(sitesEnabledPath, conf, "utf8");
    }

    let env = readFileSync(envPath, "utf8");
    env = env
      .split("\n")
      .filter((l) => !/^DEMO_HOST_MAP_ENABLED=/.test(l) && !/^DEMO_HOST_MAP_SCHEME=/.test(l) && !/^DEMO_HOST_MAP=/.test(l))
      .join("\n");
    if (!env.endsWith("\n")) env += "\n";
    env += "DEMO_HOST_MAP_ENABLED=true\n";
    env += `DEMO_HOST_MAP_SCHEME=${process.env.DEMO_HOST_MAP_SCHEME || "http"}\n`;
    env += `DEMO_HOST_MAP=${envPairs.join(",")}\n`;
    writeFileSync(envPath, env, "utf8");

    execSync("nginx -t", { stdio: "pipe" });
    execSync("systemctl reload nginx", { stdio: "pipe" });

    const successAt = new Date().toISOString();
    for (const c of activeConfigs as any[]) {
      statusMap[c.experienceId] = { status: "success", at: successAt };
    }
    await writeDemoPublishStatusMap(statusMap, updatedBy);
    await upsertSystemConfig({ key: DEMO_PUBLISH_META_KEY, value: JSON.stringify({ at: successAt, count: items.length }), description: "demo 路由最近发布元信息" }, updatedBy);

    return { ok: true, message: `发布成功，已处理 ${items.length} 个 active demo（Nginx已生效，若新增experienceId需重启服务加载最新DEMO_HOST_MAP）` };
  } catch (e: any) {
    // 回滚 nginx 配置（若本次发布已写入过新文件）
    try {
      if (nginxBackupPath) {
        const backupConf = readFileSync(nginxBackupPath, "utf8");
        writeFileSync(nginxSitePath, backupConf, "utf8");
        execSync("nginx -t", { stdio: "pipe" });
        execSync("systemctl reload nginx", { stdio: "pipe" });
      }
    } catch (rollbackErr) {
      console.error("[PublishDemoRouting] rollback failed:", rollbackErr);
    }

    const err = String(e?.stderr || e?.message || e || "unknown").slice(0, 1200);
    const failAt = new Date().toISOString();
    for (const c of activeConfigs as any[]) {
      statusMap[c.experienceId] = { status: "failed", at: failAt, error: err };
    }
    await writeDemoPublishStatusMap(statusMap, updatedBy);
    await upsertSystemConfig({ key: DEMO_PUBLISH_META_KEY, value: JSON.stringify({ at: failAt, ok: false, error: err }), description: "demo 路由最近发布元信息" }, updatedBy);
    return { ok: false, message: `发布失败: ${err}` };
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
