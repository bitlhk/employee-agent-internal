/**
 * tenant-isolation.ts — TIL (Tenant Isolation Layer)
 *
 * 核心职责：
 *   1. 为每个 (userId, agentId) 生成稳定的 tenantToken（HMAC-SHA256，脱敏身份）
 *   2. 管理 per-tenant workspace 物理目录（/root/.openclaw/workspace/tenants/{tenantToken}/{agentId}）
 *   3. 生成脱敏后的 sessionKey（不含 userId 明文）
 *   4. 写审计日志到 business_agent_audit 表
 *   5. 维护 (userId, agentId) → tenantToken 映射表
 *
 * 安全语义：
 *   - 同一 (userId, agentId) → 同一 tenantToken（稳定，workspace 可持久化）
 *   - 不同 agentId → 不同 tenantToken（同一用户不同 agent 也互相隔离）
 *   - 下游服务无法从 tenantToken 反推 userId（HMAC 不可逆）
 */

import { createHash, createHmac, randomBytes } from "crypto";
import { mkdirSync, existsSync, readFileSync, readdirSync, statSync, cpSync } from "fs";
import path from "path";
import { OPENCLAW_HOME, OPENCLAW_JSON_PATH } from "./helpers";

function resolveTenantSecret(): string {
  const secret = process.env.TENANT_SECRET?.trim();
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("TENANT_SECRET is required in production");
  }
  return randomBytes(32).toString("hex");
}

const TENANT_SECRET = resolveTenantSecret();
const TENANT_ROOT = process.env.TENANT_ROOT || path.join(OPENCLAW_HOME, "workspace", "tenants");

export interface TenantContext {
  userId: number;
  agentId: string;
  tenantToken: string;      // 64 字符 hex（HMAC-SHA256 全量）
  tenantShort: string;      // 前 16 字符，用于 sessionKey 和日志显示
  workspace: string;         // 绝对路径 /root/.openclaw/workspace/tenants/{token}/{agentId}
  sessionKey: string;        // business:{agentId}:t:{tenantShort}:main
}

/**
 * 稳定生成 tenantToken：同一 (userId, agentId) 永远得到同一 token
 * HMAC 不可逆，下游服务无法反推 userId
 */
export function generateTenantToken(userId: number, agentId: string): string {
  const data = `uid:${userId}|agent:${agentId}`;
  return createHmac("sha256", TENANT_SECRET).update(data).digest("hex");
}

/**
 * 构建完整的 TenantContext
 * 副作用：首次调用时自动创建 workspace 目录
 */
export function buildTenantContext(userId: number, agentId: string): TenantContext {
  const tenantToken = generateTenantToken(userId, agentId);
  const tenantShort = tenantToken.slice(0, 16);
  const workspace = path.join(TENANT_ROOT, tenantToken, agentId);

  // 首次访问自动创建 per-tenant workspace 目录
  if (!existsSync(workspace)) {
    try {
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
    } catch (e) {
      console.error("[TIL] mkdir workspace failed:", workspace, e);
    }
  }

  // sessionKey 脱敏：不出现 userId
  const sessionKey = `business:${agentId}:t:${tenantShort}:main`;

  return { userId, agentId, tenantToken, tenantShort, workspace, sessionKey };
}

/**
 * 构造传给下游 runtime 的稳定 session id。
 * 部分 OpenAI-compatible runtime 会把 session_id 映射为 prompt_cache_key，
 * 上游限制最大 64 字符，所以这里统一压到安全长度内。
 */
export function buildRuntimeSessionKey(
  runtime: string,
  agentId: string,
  tenantShort: string,
  maxLength = 64,
): string {
  const normalizedRuntime = runtime.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 16) || "runtime";
  const normalizedAgentId = agentId.replace(/[^a-zA-Z0-9_-]/g, "-");
  const base = `${normalizedRuntime}:${normalizedAgentId}:t:${tenantShort}`;
  if (base.length <= maxLength) return base;
  const digest = createHash("sha256").update(base).digest("hex").slice(0, 16);
  return `${normalizedRuntime}:t:${tenantShort}:h:${digest}`;
}

/**
 * 异步写审计日志（不阻塞主流程，失败不抛异常）
 */
export async function auditTenantAccess(
  ctx: TenantContext,
  action: string,
  meta?: Record<string, any>
): Promise<void> {
  try {
    const { getDb } = await import("../db");
    const db = await getDb();
    if (!db) return;
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`
      INSERT INTO business_agent_audit
        (user_id, tenant_token, agent_id, action, session_key, meta, created_at)
      VALUES
        (${ctx.userId}, ${ctx.tenantToken}, ${ctx.agentId}, ${action},
         ${ctx.sessionKey}, ${JSON.stringify(meta || {})}, NOW())
    `);
  } catch (e) {
    console.error("[TIL] audit failed:", e);
  }
}

/**
 * 写入/更新 tenant 映射表（upsert 语义）
 * 首次调用 insert，后续调用更新 last_used_at 和 message_count
 */
export async function upsertTenantMap(ctx: TenantContext): Promise<void> {
  try {
    const { getDb } = await import("../db");
    const db = await getDb();
    if (!db) return;
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`
      INSERT INTO business_agent_tenant_map
        (user_id, agent_id, tenant_token, workspace_path, first_used_at, last_used_at, message_count)
      VALUES
        (${ctx.userId}, ${ctx.agentId}, ${ctx.tenantToken}, ${ctx.workspace}, NOW(), NOW(), 1)
      ON DUPLICATE KEY UPDATE
        last_used_at = NOW(),
        message_count = message_count + 1
    `);
  } catch (e) {
    console.error("[TIL] upsert tenant map failed:", e);
  }
}

/**
 * 便捷方法：一次完成 context 构建 + 映射更新 + 首次审计
 * 业务代码入口用这个，减少调用层数
 */
export async function beginTenantSession(
  userId: number,
  agentId: string,
  action: string = "chat_send",
  meta?: Record<string, any>
): Promise<TenantContext> {
  const ctx = buildTenantContext(userId, agentId);
  // 异步执行，不阻塞返回
  upsertTenantMap(ctx).catch(() => {});
  auditTenantAccess(ctx, action, meta).catch(() => {});
  return ctx;
}

// ─────────────────────────────────────────────────────────────────
// Per-tenant OpenClaw agent 动态注册
// 原理：为 (userId, templateAgentId) 对动态创建一个独立的 OpenClaw agent
//       agent_id = {templateAgentId}-t-{tenantShort}
//       workspace = /root/.openclaw/workspace/tenants/{token}/{templateAgentId}
//       OpenClaw 内部按 agent_id 隔离 workspace，工具调用强制限制在该目录内
// 副作用：
//   - 调用 OpenClaw 的 agents.create RPC（首次）
//   - 内存里记一个 Set 缓存，避免重复 RPC
// ─────────────────────────────────────────────────────────────────

import { execFileSync } from "child_process";

const _registeredAgents = new Set<string>();

/**
 * 确保 per-tenant agent 已在 OpenClaw 注册
 * 返回 per-tenant agent_id
 */
export function ensurePerTenantAgent(
  templateAgentId: string,
  tenantCtx: TenantContext
): string {
  const perTenantAgentId = `${templateAgentId}-t-${tenantCtx.tenantShort}`;

  // 内存缓存命中：直接返回
  if (_registeredAgents.has(perTenantAgentId)) {
    return perTenantAgentId;
  }

  // 检查 OpenClaw 配置（重启后需要从这里恢复缓存）
  try {
    const cfgRaw = readFileSync(OPENCLAW_JSON_PATH, "utf-8");
    const cfg = JSON.parse(cfgRaw);
    const agents = cfg?.agents?.list || [];
    const exists = agents.some((a: any) => a.id === perTenantAgentId);
    if (exists) {
      _registeredAgents.add(perTenantAgentId);
      return perTenantAgentId;
    }
  } catch (e) {
    console.warn("[TIL] read openclaw.json failed:", e);
  }

  // 调 OpenClaw agents.create RPC 注册新 agent
  try {
    const remoteHost = process.env.CLAW_REMOTE_HOST || "127.0.0.1";
    const gatewayPort = parseInt(process.env.CLAW_GATEWAY_PORT || "18789", 10);
    const gatewayToken = process.env.CLAW_GATEWAY_TOKEN || "";

    const result = execFileSync("openclaw", [
      "gateway", "call", "agents.create",
      "--url", `ws://${remoteHost}:${gatewayPort}`,
      "--token", gatewayToken,
      "--params", JSON.stringify({
        name: perTenantAgentId,
        workspace: tenantCtx.workspace,
      }),
      "--json",
    ], { timeout: 10000, encoding: "utf8" });

    console.log(`[TIL] registered per-tenant agent: ${perTenantAgentId}`, result.slice(0, 200));

    // 关键：从模板 workspace 复制核心资源（skills/、模板文件、依赖等）
    // 这样 per-tenant agent 才能继承模板的能力，而不是一个空 agent
    syncTemplateResources(templateAgentId, tenantCtx.workspace);

    _registeredAgents.add(perTenantAgentId);
    return perTenantAgentId;
  } catch (e: any) {
    console.error("[TIL] agents.create failed for", perTenantAgentId, ":", e?.message);
    // 失败时回退到模板 agent，保证业务可用
    return templateAgentId;
  }
}

/**
 * 删除 per-tenant agent（仅用于清理/测试，正常运行不调用）
 */
export function deletePerTenantAgent(perTenantAgentId: string): boolean {
  try {
    const remoteHost = process.env.CLAW_REMOTE_HOST || "127.0.0.1";
    const gatewayPort = parseInt(process.env.CLAW_GATEWAY_PORT || "18789", 10);
    const gatewayToken = process.env.CLAW_GATEWAY_TOKEN || "";
    execFileSync("openclaw", [
      "gateway", "call", "agents.delete",
      "--url", `ws://${remoteHost}:${gatewayPort}`,
      "--token", gatewayToken,
      "--params", JSON.stringify({ agentId: perTenantAgentId }),
    ], { timeout: 10000 });
    _registeredAgents.delete(perTenantAgentId);
    return true;
  } catch {
    return false;
  }
}

/**
 * 从模板 agent workspace 同步核心资源到 per-tenant workspace
 * 排除用户产物目录（output/sessions/memory），其他全部复制
 */
function syncTemplateResources(templateAgentId: string, targetWorkspace: string): void {
  try {
    // 模板 workspace 路径（基于 OpenClaw 配置）
    const cfgRaw = readFileSync(OPENCLAW_JSON_PATH, "utf-8");
    const cfg = JSON.parse(cfgRaw);
    const templateAgent = (cfg?.agents?.list || []).find((a: any) => a.id === templateAgentId);
    if (!templateAgent?.workspace) {
      console.warn(`[TIL] template agent ${templateAgentId} has no workspace, skip sync`);
      return;
    }
    const templateWorkspace = templateAgent.workspace;
    if (!templateWorkspace || templateWorkspace === targetWorkspace) return;

    // 排除目录：避免复制用户产物
    const SKIP = new Set(["output", "sessions", "memory", ".git", ".openclaw"]);

    const entries = readdirSync(templateWorkspace);
    for (const entry of entries) {
      if (SKIP.has(entry)) continue;
      const srcPath = `${templateWorkspace}/${entry}`;
      const dstPath = `${targetWorkspace}/${entry}`;
      try {
        const st = statSync(srcPath);
        // cpSync 支持递归复制目录和文件，覆盖已有内容
        cpSync(srcPath, dstPath, {
          recursive: true,
          force: true,
          errorOnExist: false,
          dereference: false,
        });
      } catch (e: any) {
        console.warn(`[TIL] copy ${entry} failed:`, e?.message);
      }
    }
    console.log(`[TIL] synced template resources from ${templateAgentId} to ${targetWorkspace}`);
  } catch (e: any) {
    console.error("[TIL] syncTemplateResources failed:", e?.message);
  }
}
