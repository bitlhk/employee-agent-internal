/**
 * tool_router.ts — 平台工具代理层 v2
 *
 * 架构：LLM tool_call → toolNameMap → policyCheck → execute → normalizeResult
 *
 * v2 改进：
 *  1. 完整审计闭环：每个字段可举证"是否走 sandbox"
 *  2. 审计落库：ToolExecutionAudit 写入数据库
 *  3. PolicyDenyReason 枚举：拒绝原因标准化
 *  4. 参数 schema 校验：sandbox_exec 严格入参校验
 *  5. 策略配置中心：BLOCKED_PATTERNS / ALLOWED_COMMANDS 集中管理
 *  6. RoutedToolResult 结构：全路径结构化返回
 */

// ─────────────────────────────────────────────────────────────────────────────
// External deps
// ─────────────────────────────────────────────────────────────────────────────
import { sandboxExec } from "./sandbox";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, readdirSync, unlinkSync, rmdirSync } from "fs";
import { resolveExistingRegularFile, resolveWorkspaceWritePath } from "./file-path-security";
import os from "os";

// ─────────────────────────────────────────────────────────────────────────────
// 6. 结果结构（先定义类型，让其他层引用一致）─────────────────────────────────

export type PolicyDenyReason =
  | "profile_denied"
  | "starter_denied"
  | "tool_not_found"
  | "command_not_allowed"
  | "blocked_pattern"
  | "timeout_exceeded"
  | "output_limit_exceeded"
  | "invalid_arguments"
  | "too_many_args"
  | "args_type_invalid"
  | "cwd_not_allowed"
  | "cmd_too_long"
  | "rate_limited"
  | "unknown_error";

export type ExecutorName = "sandbox" | "native" | "none";

export type ErrorType =
  | "policy_denied"
  | "timeout"
  | "execution_error"
  | "invalid_arguments"
  | "unknown_error";

export interface RoutedToolResult {
  auditId: string;
  toolCallId: string;
  toolName: string;
  executor: ExecutorName;
  // 成功与否
  ok: boolean;
  exitCode?: number;
  // 输出
  output: string;
  truncated: boolean;
  // 错误分类
  errorType?: ErrorType;
  policyDenyReason?: PolicyDenyReason;
  // 元信息
  // suppressedOriginalResult: true=代理层拦截替换, false=透传原始
  suppressedOriginalResult: boolean;
  /** 沙箱产出的文件，已移至 workspace，可供下载 */
  outputFiles?: Array<{ name: string; size: number; workspacePath: string }>;
  meta: {
    durationMs?: number;
    stdoutBytes?: number;
    stderrBytes?: number;
    originalToolName?: string;
    routedToolName?: string;
    policyDecision?: "allow" | "deny" | "rewrite";
    deniedReason?: string;   // 用户可读
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. 策略配置中心（集中管理，不要散在逻辑里）─────────────────────────────────

export interface ToolPolicyConfig {
  sandboxExec: {
    allowedCommands: string[];
    blockedPatterns: Array<{ pat: RegExp; reason: string }>;
    timeoutMs: number;
    outputLimitBytes: number;
    maxArgs: number;
    allowedCwd: string[];   // 白名单目录，empty = 全部禁用
    envKeyPattern: RegExp; // 允许的环境变量 key 格式
  };
}

export const TOOL_POLICY: ToolPolicyConfig = {
  sandboxExec: {
    // 允许的基础命令（精确匹配）
    allowedCommands: [
      "ls", "cat", "grep", "find", "echo", "pwd", "mkdir", "touch",
      "cp", "mv", "head", "tail", "sort", "uniq", "wc", "awk", "sed",
      "python3", "pip3", "node", "npm", "pnpm", "git",
      "zip", "unzip", "tar", "gzip", "gunzip",
      "ps", "kill", "killall", "pgrep", "pkill",
      "df", "du", "free", "uptime",
      "whoami", "id", "hostname", "uname", "date",
      "base64", "md5sum", "sha256sum", "sha1sum",
      "jq", "xxd", "hexdump",
    ],

    // 黑名单模式（正则）
    blockedPatterns: [
      { pat: /\bsudo\b/,                              reason: "sudo not allowed" },
      { pat: /\bsu\b\s/,                              reason: "su not allowed" },
      { pat: /\bchmod\b.*[+]s/,                      reason: "setuid bit not allowed" },
      { pat: /\/proc\/sysrq/,                         reason: "sysrq not allowed" },
      { pat: /\/dev\/sd/,                             reason: "block device not allowed" },
      { pat: /\bdd\b.*\/dev\//,                       reason: "dd to device not allowed" },
      { pat: /\bnsenter\b/,                          reason: "nsenter not allowed" },
      { pat: /\bunshare\b/,                           reason: "unshare not allowed" },
      { pat: /\bmount\b/,                            reason: "mount not allowed" },
      { pat: /\bnohup\b.*&\s*$/,                      reason: "background daemon not allowed" },
      { pat: /\bcurl\b.*--output\b|\bwget\b.*-O\s/, reason: "file download not allowed" },
      { pat: /\brm\b.*-rf\s+\/(?!tmp)/,             reason: "recursive root delete not allowed" },
      { pat: /;\s*rm\s+/,                             reason: "chain rm not allowed" },
      { pat: /\|\s*rm\s+/,                            reason: "pipe rm not allowed" },
      { pat: /\bsh\b.*-i\b/,                          reason: "interactive shell not allowed" },
      { pat: /\bpython3?\b.*-m\s+pip\b/,              reason: "pip install not allowed" },
      // 防止内联代码执行绕过 allowedCommands 白名单
      { pat: /\bpython3?\b.*-[cC]\b/,               reason: "python inline exec not allowed" },
      { pat: /\bpython\b.*-[cC]\b/,                 reason: "python inline exec not allowed" },
      { pat: /\bnode\b.*-[eE]\b/,                   reason: "node inline eval not allowed" },
      { pat: /\bnode\b.*--eval\b/,                  reason: "node inline eval not allowed" },
      { pat: /\bnpm\b.*(install|i)\b/,              reason: "npm install not allowed in sandbox" },
      { pat: /\bpnpm\b.*(install|add)\b/,           reason: "pnpm install not allowed in sandbox" },

      // – 承感路径 + 信桿接钠信桿 –––––––––––––––––
      { pat: /\/etc\/(shadow|passwd|sudoers|ssh\/|ssl\/private)/, reason: "sensitive system file not allowed" },
      { pat: /\.(bash_history|zsh_history|ash_history)/, reason: "shell history not allowed" },
      { pat: /\.(bashrc|bash_profile|zshrc|profile|bash_logout)/, reason: "shell rc config not allowed" },
      { pat: /\/\.openclaw\//, reason: "openclaw config not allowed" },
      { pat: /\/\.config\//, reason: "user config dir not allowed" },
      { pat: /\/\.ssh\//, reason: "ssh keys not allowed" },
      { pat: /\/proc\/[0-9]+\/environ/, reason: "process environ not allowed" },
      { pat: /\/proc\/[0-9]+\/cmdline/, reason: "process cmdline not allowed" },
      { pat: /[.]env([.]local|[.]prod|[.]development|[.]staging)?\b/, reason: ".env file not allowed" },
      { pat: /\bfind\b.*\/(etc|root|home|proc|sys)\b/, reason: "find in sensitive dirs not allowed" },
      { pat: /\bhostname\b/, reason: "hostname command not allowed" },
    ],

    timeoutMs:         30_000,
    outputLimitBytes:  64 * 1024,  // 64KB
    maxArgs:           20,
    // cwd 白名单（empty = 完全禁用 cwd）
    allowedCwd:       [],
    // 环境变量 key 格式（防止 KEY=value 注入）
    envKeyPattern:    /^[A-Z_][A-Z0-9_]{0,30}$/,
  },
};

// 用户可读的拒绝原因映射（用于 SSE 返回）
const POLICY_DENY_USER_READABLE: Partial<Record<PolicyDenyReason, string>> = {
  profile_denied:      "当前权限级别不允许执行该工具",
  starter_denied:      "exec 工具仅对 plus 及以上用户开放",
  tool_not_found:      "工具不存在或未启用",
  command_not_allowed: "命令不在允许列表中，请联系管理员",
  blocked_pattern:     "命令包含敏感操作，被安全策略拦截",
  timeout_exceeded:    "执行超时，请减少操作复杂度",
  output_limit_exceeded: "输出过长，已截断",
  invalid_arguments:   "参数格式不符合安全要求",
  too_many_args:       "参数过多，请简化",
  args_type_invalid:   "参数类型错误",
  cwd_not_allowed:     "工作目录不在允许范围内",
  cmd_too_long:        "命令过长，超过长度上限",
  rate_limited:        "已达每小时 exec 次数上限，请稍后再试",
  unknown_error:       "未知错误，请稍后重试",
};

// ─────────────────────────────────────────────────────────────────────────────
// 加固 3：per-user 每小时 exec 速率限制（进程内 Map，pm2 重启清零，MVP 可接受）
// ─────────────────────────────────────────────────────────────────────────────
const EXEC_RATE_LIMIT_MAP = new Map<number, { count: number; resetAt: number }>();
const EXEC_RATE_LIMIT_MAX = parseInt(process.env.SANDBOX_RATE_LIMIT_PER_USER_HOUR || "200", 10);
const EXEC_RATE_LIMIT_WINDOW_MS = 3600_000;

function checkExecRateLimit(userId: number): { allowed: boolean; resetInMin?: number } {
  const now = Date.now();
  if (EXEC_RATE_LIMIT_MAP.size > 1_000) {
    for (const [key, value] of EXEC_RATE_LIMIT_MAP) {
      if (now >= value.resetAt) EXEC_RATE_LIMIT_MAP.delete(key);
    }
  }
  let rl = EXEC_RATE_LIMIT_MAP.get(userId);
  if (!rl || now >= rl.resetAt) {
    rl = { count: 0, resetAt: now + EXEC_RATE_LIMIT_WINDOW_MS };
    EXEC_RATE_LIMIT_MAP.set(userId, rl);
  }
  if (rl.count >= EXEC_RATE_LIMIT_MAX) {
    return { allowed: false, resetInMin: Math.ceil((rl.resetAt - now) / 60_000) };
  }
  rl.count += 1;
  return { allowed: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具名映射（1 层）───────────────────────────────────────────────────────────

const TOOL_NAME_MAP: Record<string, string> = {
  exec:     "sandbox_exec",
  process:  "sandbox_exec",
};

export function resolveToolHandler(name: string): string {
  return TOOL_NAME_MAP[name] ?? "denied";
}

// ─────────────────────────────────────────────────────────────────────────────
// 审计 ID 生成─────────────────────────────────────────────────────────────────

function newAuditId(): string {
  return `aud_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 日志辅助─────────────────────────────────────────────────────────────────────

const APP_ROOT_TR = process.env.APP_ROOT || process.cwd();
const LOG_DIR = `${APP_ROOT_TR}/logs`;

function ensureLogDir() {
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}

function auditLog(entry: Record<string, unknown>) {
  ensureLogDir();
  const line = JSON.stringify(entry);
  try { appendFileSync(`${LOG_DIR}/tool-router.log`, line + "\n", "utf8"); } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 参数 schema 校验──────────────────────────────────────────────────────────

export interface SandboxExecInput {
  cmd?:     string | null;
  args?:    string[] | null;
  cwd?:     string | null;
  timeoutMs?: number | null;
  env?:     Record<string, string> | null;
}

export function validateSandboxExecInput(argsStr: string): {
  ok: boolean;
  input?: SandboxExecInput;
  denyReason?: PolicyDenyReason;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(argsStr);
  } catch {
    return { ok: false, denyReason: "invalid_arguments" };
  }

  // 支持两种格式：
  //   1. 字符串 = 命令本身
  //   2. 对象 = { cmd, args, cwd, timeoutMs, env }
  if (typeof raw === "string") {
    const cmd = (raw as string).trim();
    if (!cmd) return { ok: false, denyReason: "invalid_arguments" };
    return { ok: true, input: { cmd, args: null, cwd: null, timeoutMs: null, env: null } };
  }

  if (typeof raw !== "object" || raw === null) {
    return { ok: false, denyReason: "invalid_arguments" };
  }

  const obj = raw as Record<string, unknown>;

  // cmd: 必须是非空字符串
  const cmdRaw = obj.cmd ?? obj.command ?? obj.code ?? obj._;
  const cmd = typeof cmdRaw === "string" ? cmdRaw.trim() : null;
  if (!cmd) return { ok: false, denyReason: "invalid_arguments" };

  // 加固 2：命令总长度限制（cmd + args 拼接），默认 4KB
  const cmdMaxLen = parseInt(process.env.SANDBOX_CMD_MAX_LENGTH || "4096", 10);
  const argsPreview = Array.isArray(obj.args) ? (obj.args as unknown[]).filter(a => typeof a === "string").join(" ") : "";
  if (cmd.length + argsPreview.length > cmdMaxLen) {
    return { ok: false, denyReason: "cmd_too_long" };
  }

  // args: 必须是字符串数组，最多 maxArgs 个
  const argsRaw = obj.args ?? obj._args;
  let args: string[] | null = null;
  if (Array.isArray(argsRaw)) {
    if (argsRaw.length > TOOL_POLICY.sandboxExec.maxArgs) {
      return { ok: false, denyReason: "too_many_args" };
    }
    if (!argsRaw.every(a => typeof a === "string")) {
      return { ok: false, denyReason: "args_type_invalid" };
    }
    args = argsRaw as string[];
  } else if (argsRaw !== undefined && argsRaw !== null) {
    return { ok: false, denyReason: "args_type_invalid" };
  }

  // cwd: 必须是允许的目录或空
  const cwd = typeof obj.cwd === "string" ? obj.cwd.trim() : null;
  if (cwd) {
    const allowed = TOOL_POLICY.sandboxExec.allowedCwd;
    if (allowed.length > 0 && !allowed.some(prefix => cwd.startsWith(prefix))) {
      return { ok: false, denyReason: "cwd_not_allowed" };
    }
    if (cwd === "/" || cwd === "/root" || cwd.startsWith("/root")) {
      return { ok: false, denyReason: "cwd_not_allowed" };
    }
  }

  // timeoutMs: 可选，范围校验
  let timeoutMs: number | null = null;
  if (obj.timeoutMs !== undefined) {
    if (typeof obj.timeoutMs !== "number" || obj.timeoutMs <= 0 || obj.timeoutMs > 120_000) {
      return { ok: false, denyReason: "invalid_arguments" };
    }
    timeoutMs = obj.timeoutMs;
  }

  // env: 可选，key 格式校验
  let env: Record<string, string> | null = null;
  if (obj.env !== undefined && obj.env !== null && typeof obj.env === "object") {
    const pattern = TOOL_POLICY.sandboxExec.envKeyPattern;
    env = {};
    for (const [k, v] of Object.entries(obj.env as Record<string, unknown>)) {
      if (!pattern.test(k) || typeof v !== "string") {
        return { ok: false, denyReason: "invalid_arguments" };
      }
      env[k] = v;
    }
  }

  return {
    ok: true,
    input: { cmd, args, cwd, timeoutMs, env },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 策略校验（PolicyDenyReason 枚举）────────────────────────────────────────

export interface PolicyCheckResult {
  allowed: boolean;
  denyReason?: PolicyDenyReason;
  toolHandler?: string;
  denyReasonReadable?: string;
  policyDecision?: "allow" | "deny" | "rewrite";
}

function shellQuoteArg(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function buildSandboxCommand(input: SandboxExecInput): string {
  const cmd = String(input.cmd || "").trim();
  const args = Array.isArray(input.args) ? input.args : [];
  if (args.length === 0) return cmd;
  return [cmd, ...args.map(shellQuoteArg)].join(" ");
}

function buildPolicyCommand(input: SandboxExecInput): string {
  const cmd = String(input.cmd || "").trim();
  const args = Array.isArray(input.args) ? input.args : [];
  return [cmd, ...args].filter(Boolean).join(" ");
}

export function policyCheck(
  permissionProfile: "starter" | "plus" | "internal",
  toolName: string,
  input: SandboxExecInput,
): PolicyCheckResult {
  // 1. 工具名路由
  const handler = resolveToolHandler(toolName);
  if (handler === "denied") {
    return {
      allowed: false,
      denyReason: "tool_not_found",
      denyReasonReadable: POLICY_DENY_USER_READABLE["tool_not_found"],
      policyDecision: "deny",
    };
  }

  // 2. profile 权限
  if (permissionProfile === "starter") {
    return {
      allowed: false,
      denyReason: "starter_denied",
      denyReasonReadable: POLICY_DENY_USER_READABLE["starter_denied"],
      policyDecision: "deny",
    };
  }

  // 3. plus 永远走 sandbox，不走 native
  if (permissionProfile === "plus" && handler === "native_exec") {
    return {
      allowed: false,
      denyReason: "profile_denied",
      denyReasonReadable: "plus 用户必须使用沙箱执行",
      policyDecision: "deny",
    };
  }

  // 4. sandbox_exec 命令校验
  if (handler === "sandbox_exec" && input.cmd) {
    const { blockedPatterns, allowedCommands } = TOOL_POLICY.sandboxExec;

    // 4a. 黑名单检查
    for (const { pat, reason } of blockedPatterns) {
      if (pat.test(buildPolicyCommand(input))) {
        return {
          allowed: false,
          denyReason: "blocked_pattern",
          denyReasonReadable: `命令包含敏感操作（${reason}），被安全策略拦截`,
          policyDecision: "deny",
        };
      }
    }

    // 4b. 白名单检查（精确匹配主命令）
    const mainCmd = input.cmd.split(/\s+/)[0].replace(/^.*\//, "");
    if (!allowedCommands.includes(mainCmd)) {
      return {
        allowed: false,
        denyReason: "command_not_allowed",
        denyReasonReadable: `命令 '${mainCmd}' 不在允许列表中，如有需要请联系管理员`,
        policyDecision: "deny",
      };
    }
  }

  return {
    allowed: true,
    toolHandler: handler,
    policyDecision: "allow",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 审计落库──────────────────────────────────────────────────────────────────

// ToolExecutionAudit 表字段
export interface ToolExecutionAuditRecord {
  auditId:           string;
  requestId?:        string;   // adoptId
  userId?:           number;
  agentId?:          string;
  profile:           "starter" | "plus" | "internal";
  toolCallId:        string;
  originalToolName:  string;
  routedToolName:    string;
  command?:          string;
  args?:             string[];
  cwd?:              string;
  timeoutMs?:        number;
  policyDecision:    "allow" | "deny" | "rewrite";
  denyReason?:       string;
  deniedReason?:     string;
  executor:          ExecutorName;
  exitCode?:         number;
  stdoutBytes?:      number;
  stderrBytes?:      number;
  truncated?:        boolean;
  durationMs?:       number;
  createdAt:         number;
}

// 审计记录缓存（按 adoptId 分组，批量写入）
const auditBuffer: ToolExecutionAuditRecord[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 5000;
const MAX_BUFFER_SIZE = 50;
const pendingLedgerWrites = new Set<Promise<void>>();
let auditStopping = false;
let auditFlushPromise: Promise<void> | null = null;

async function flushAuditBatch() {
  if (auditBuffer.length === 0) return;
  const records = auditBuffer.splice(0, auditBuffer.length);
  try {
    // 2026-04-18 fix: 原代码 3 处 bug，从没执行成功过：
    //   1) getDb() 是 async，原代码同步调用拿到 Promise
    //   2) db.prepare/stmt.run 是 better-sqlite3 API，Drizzle MySQL 不支持
    //   3) 表名写错 tool_execution_audit（单数），DB 实际是 tool_execution_audits
    // 改用 Drizzle 的 insert API，type-safe 且正确处理 MySQL ON DUPLICATE KEY
    const { getDb } = await import("../db");
    const db = await getDb();
    if (!db) {
      auditBuffer.unshift(...records);
      return;
    }
    const { toolExecutionAudits } = await import("../../drizzle/schema");
    const { sql: sqlTag } = await import("drizzle-orm");

    let ok = 0, fail = 0;
    const failedRecords: ToolExecutionAuditRecord[] = [];
    for (const r of records) {
      try {
        await db.insert(toolExecutionAudits).values({
          auditId:          r.auditId,
          requestId:        r.requestId ?? null,
          userId:           r.userId ?? null,
          agentId:          r.agentId ?? null,
          profile:          r.profile,
          toolCallId:       r.toolCallId,
          originalToolName: r.originalToolName,
          routedToolName:   r.routedToolName,
          command:          r.command ?? null,
          args:             r.args ? JSON.stringify(r.args) : null,
          cwd:              r.cwd ?? null,
          timeoutMs:        r.timeoutMs ?? null,
          policyDecision:   r.policyDecision,
          denyReason:       r.denyReason ?? null,
          deniedReason:     r.deniedReason ?? null,
          executor:         r.executor,
          exitCode:         r.exitCode ?? null,
          stdoutBytes:      r.stdoutBytes ?? null,
          stderrBytes:      r.stderrBytes ?? null,
          truncated:        r.truncated ? 1 : 0,
          durationMs:       r.durationMs ?? null,
          createdAt:        new Date(r.createdAt),
        }).onDuplicateKeyUpdate({ set: { auditId: sqlTag`audit_id` } });
        ok++;
      } catch {
        fail++;
        failedRecords.push(r);
      }
    }
    if (failedRecords.length > 0) auditBuffer.unshift(...failedRecords);
    auditLog({ event: "audit_flush", count: records.length, ok, fail });
  } catch (err) {
    auditBuffer.unshift(...records);
    auditLog({ event: "audit_flush_error", error: String(err), count: records.length });
  }
}

function flushAuditBuffer(): Promise<void> {
  if (auditFlushPromise) return auditFlushPromise;
  const running = flushAuditBatch().finally(() => {
    if (auditFlushPromise === running) auditFlushPromise = null;
  });
  auditFlushPromise = running;
  return running;
}

function scheduleFlush() {
  if (auditStopping || flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushAuditBuffer();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

function enqueueAudit(record: ToolExecutionAuditRecord) {
  auditBuffer.push(record);
  if (auditBuffer.length >= MAX_BUFFER_SIZE) {
    void flushAuditBuffer();
  } else {
    scheduleFlush();
  }
}

function trackLedgerWrite(promise: Promise<void>): void {
  pendingLedgerWrites.add(promise);
  void promise.finally(() => pendingLedgerWrites.delete(promise));
}

export function startToolAuditRuntime(): () => Promise<void> {
  auditStopping = false;
  return flushToolAuditWrites;
}

export async function flushToolAuditWrites(): Promise<void> {
  auditStopping = true;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushAuditBuffer();
  await Promise.allSettled(Array.from(pendingLedgerWrites));
  await flushAuditBuffer();
}

async function recordToolLedgerEvent(
  record: ToolExecutionAuditRecord,
  outcome: {
    result: "success" | "failed" | "denied";
    severity?: "info" | "low" | "medium" | "high";
    action: string;
    errorCode?: string;
  },
) {
  try {
    const { recordAuditEvent, redactAuditMetadata } = await import("./audit-ledger");
    const safeCommand = sanitizeToolCommand(record.command, redactAuditMetadata);
    const safeArgs = sanitizeToolArgs(record.args, redactAuditMetadata);
    const safeCwd = typeof record.cwd === "string" ? String(redactAuditMetadata(record.cwd)) : null;
    const auditResult = await recordAuditEvent({
      action: outcome.action,
      result: outcome.result,
      severity: outcome.severity || (outcome.result === "success" ? "info" : "medium"),
      actorType: "user",
      actorUserId: record.userId ?? null,
      targetType: "tool",
      targetId: record.originalToolName,
      targetName: record.originalToolName,
      resourceType: "agent",
      resourceId: record.requestId ?? null,
      agentInstanceId: record.requestId ?? null,
      runtimeType: "openclaw",
      runtimeAgentId: record.agentId ?? null,
      detailType: "audit_tool_events",
      detailId: record.auditId,
      errorCode: outcome.errorCode ?? null,
      policyCode: record.denyReason ?? null,
      toolName: record.originalToolName,
      metadata: {
        legacyAuditId: record.auditId,
        toolCallId: record.toolCallId,
        profile: record.profile,
        routedToolName: record.routedToolName,
        policyDecision: record.policyDecision,
        executor: record.executor,
        exitCode: record.exitCode ?? null,
        stdoutBytes: record.stdoutBytes ?? null,
        stderrBytes: record.stderrBytes ?? null,
        truncated: Boolean(record.truncated),
        durationMs: record.durationMs ?? null,
      },
      mode: "sync",
    });
    if (!auditResult.persisted) return;

    const { getDb } = await import("../db");
    const db = await getDb();
    if (!db) return;
    const { auditToolEvents } = await import("../../drizzle/schema");
    await db.insert(auditToolEvents).values({
      eventId: auditResult.eventId,
      toolType: record.routedToolName === "sandbox_exec" ? "shell" : "tool",
      toolName: record.originalToolName,
      originalToolName: record.originalToolName,
      routedToolName: record.routedToolName,
      executor: record.executor,
      policyDecision: record.policyDecision,
      denyReason: record.denyReason ?? null,
      command: safeCommand,
      argsJson: safeArgs === undefined ? null : { args: safeArgs },
      cwd: safeCwd,
      timeoutMs: record.timeoutMs ?? null,
      exitCode: record.exitCode ?? null,
      stdoutBytes: record.stdoutBytes ?? null,
      stderrBytes: record.stderrBytes ?? null,
      truncated: Boolean(record.truncated),
      durationMs: record.durationMs ?? null,
      metadataJson: {
        legacyAuditId: record.auditId,
        deniedReasonPresent: Boolean(record.deniedReason),
      },
    } as any);
  } catch (error) {
    auditLog({
      event: "audit_tool_ledger_error",
      auditId: record.auditId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function sanitizeToolCommand(
  command: string | undefined,
  redact: (value: unknown) => unknown,
): string | null {
  if (!command) return null;
  const redacted = String(redact(command));
  return redacted.length > 2048 ? `${redacted.slice(0, 2048)}...[TRUNCATED]` : redacted;
}

function sanitizeToolArgs(
  args: unknown,
  redact: (value: unknown) => unknown,
): unknown {
  if (args === undefined || args === null) return undefined;
  const redacted = redactToolArgSecrets(redact(args));
  const json = JSON.stringify(redacted);
  if (Buffer.byteLength(json, "utf8") <= 4096) return redacted;
  return {
    truncated: true,
    preview: json.slice(0, 2048),
    originalBytes: Buffer.byteLength(json, "utf8"),
  };
}

function redactToolArgSecrets(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const secretFlag = /^(?:--?)?(?:password|token|secret|api[-_]?key|cookie|authorization|credential|private[-_]?key|gatewayToken|botToken)$/i;
  return value.map((item, index) => {
    if (typeof item !== "string") return item;
    const previous = value[index - 1];
    if (typeof previous === "string" && secretFlag.test(previous.replace(/^-+/, ""))) return "[REDACTED]";
    if (/^(--?(?:password|token|secret|api[-_]?key|cookie|authorization|credential|private[-_]?key|gatewayToken|botToken)=)/i.test(item)) {
      return item.replace(/^(--?[^=]+=).+$/i, "$1[REDACTED]");
    }
    return item;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 主路由入口───────────────────────────────────────────────────────────────────

export interface ToolContext {
  adoptId:  string;
  agentId:  string;
  userId:   number;
  permissionProfile: "starter" | "plus" | "internal";
  sessionKey: string;
  /** 智能体 workspace 目录（用于存放沙箱导出文件） */
  workspaceDir?: string;
  /** 进度/状态事件发送函数（可选，SSE 可用时传入） */
  sendEvent?: (event: string, data: object) => void;
}

export interface ToolCallRequest {
  id:        string;
  name:     string;
  arguments: string;
}

/**
 * routeTool — 统一工具代理入口
 *
 * 返回 RoutedToolResult，结构化，可举证，可扩展
 */
export async function routeTool(
  ctx: ToolContext,
  req: ToolCallRequest,
): Promise<RoutedToolResult> {
  const auditId = newAuditId();
  const startMs = Date.now();
  const originalToolName = req.name;

  // ── Step 0: 解析参数 ───────────────────────────────────────────────────
  const validation = validateSandboxExecInput(req.arguments);
  const input = validation.ok ? validation.input! : { cmd: null, args: null, cwd: null, timeoutMs: null, env: null };

  // ── Step 1: 策略校验 ───────────────────────────────────────────────────
  const policy = policyCheck(ctx.permissionProfile, req.name, input);

  const routedToolName = policy.allowed
    ? (policy.toolHandler ?? "none")
    : "none";

  // ── Step 1.5: 速率限制（仅对通过 policy 的 sandbox_exec 计数）──
  if (policy.allowed && routedToolName === "sandbox_exec") {
    const rl = checkExecRateLimit(ctx.userId);
    if (!rl.allowed) {
      const denyMsg = `[速率限制] 每小时最多 ${EXEC_RATE_LIMIT_MAX} 次 exec，约 ${rl.resetInMin} 分钟后重置`;
      const result: RoutedToolResult = {
        auditId, toolCallId: req.id, toolName: req.name, executor: "none",
        ok: false, output: denyMsg, truncated: false,
        errorType: "policy_denied", policyDenyReason: "rate_limited",
        suppressedOriginalResult: true,
        meta: { originalToolName, routedToolName, policyDecision: "deny", deniedReason: denyMsg, durationMs: Date.now() - startMs },
      };
      enqueueAudit({
        auditId, requestId: ctx.adoptId, userId: ctx.userId, agentId: ctx.agentId,
        profile: ctx.permissionProfile, toolCallId: req.id,
        originalToolName, routedToolName,
        command: input.cmd ?? undefined, args: input.args ?? undefined,
        cwd: input.cwd ?? undefined, timeoutMs: TOOL_POLICY.sandboxExec.timeoutMs,
        policyDecision: "deny", denyReason: "rate_limited",
        deniedReason: denyMsg,
        executor: "none",
        createdAt: Date.now(),
      });
      trackLedgerWrite(recordToolLedgerEvent({
        auditId, requestId: ctx.adoptId, userId: ctx.userId, agentId: ctx.agentId,
        profile: ctx.permissionProfile, toolCallId: req.id,
        originalToolName, routedToolName,
        command: input.cmd ?? undefined, args: input.args ?? undefined,
        cwd: input.cwd ?? undefined, timeoutMs: TOOL_POLICY.sandboxExec.timeoutMs,
        policyDecision: "deny", denyReason: "rate_limited",
        deniedReason: denyMsg,
        executor: "none",
        createdAt: Date.now(),
      }, {
        action: "tool.execution.denied",
        result: "denied",
        severity: "medium",
        errorCode: "TOOL_RATE_LIMITED",
      }));
      return result;
    }
  }

  // ── Step 2: 拒绝时快速返回 ─────────────────────────────────────────────
  if (!policy.allowed) {
    const deniedReason = POLICY_DENY_USER_READABLE[policy.denyReason!] ?? "权限不足";
    const result: RoutedToolResult = {
      auditId,
      toolCallId: req.id,
      toolName: req.name,
      executor: "none",
      ok: false,
      output: `[权限拒绝] ${deniedReason}`,
      truncated: false,
      errorType: "policy_denied",
      policyDenyReason: policy.denyReason,
      suppressedOriginalResult: true,
      meta: {
        originalToolName,
        routedToolName,
        policyDecision: "deny",
        deniedReason,
        durationMs: Date.now() - startMs,
      },
    };

    enqueueAudit({
      auditId, requestId: ctx.adoptId, userId: ctx.userId, agentId: ctx.agentId,
      profile: ctx.permissionProfile, toolCallId: req.id,
      originalToolName, routedToolName,
      command: input.cmd ?? undefined,
      args: input.args ?? undefined,
      cwd: input.cwd ?? undefined,
      timeoutMs: TOOL_POLICY.sandboxExec.timeoutMs,
      policyDecision: "deny",
      denyReason: policy.denyReason,
      deniedReason,
      executor: "none",
      createdAt: Date.now(),
    });
    trackLedgerWrite(recordToolLedgerEvent({
      auditId, requestId: ctx.adoptId, userId: ctx.userId, agentId: ctx.agentId,
      profile: ctx.permissionProfile, toolCallId: req.id,
      originalToolName, routedToolName,
      command: input.cmd ?? undefined,
      args: input.args ?? undefined,
      cwd: input.cwd ?? undefined,
      timeoutMs: TOOL_POLICY.sandboxExec.timeoutMs,
      policyDecision: "deny",
      denyReason: policy.denyReason,
      deniedReason,
      executor: "none",
      createdAt: Date.now(),
    }, {
      action: "tool.execution.denied",
      result: "denied",
      severity: "medium",
      errorCode: "TOOL_POLICY_DENIED",
    }));

    auditLog({
      event: "tool_denied",
      auditId,
      adoptId: ctx.adoptId,
      originalToolName,
      routedToolName,
      denyReason: policy.denyReason,
    });

    return result;
  }

  // ── Step 3: 执行 ────────────────────────────────────────────────────────
  let exitCode: number | undefined;
  let stdout: string | undefined;
  let stderr: string | undefined;
  let truncated = false;
  let errorType: ErrorType | undefined;

  let outputFiles: Array<{ name: string; size: number; workspacePath: string }> | undefined;
  if (routedToolName === "sandbox_exec") {
    const timeoutMs = input.timeoutMs ?? TOOL_POLICY.sandboxExec.timeoutMs;
    // 为本次执行创建临时 output 目录（挂载为容器内 /output）
    let tmpOutputDir: string | null = null;
    try { tmpOutputDir = mkdtempSync("/tmp/sb-output-"); } catch {}
    try {
      const raw = await sandboxExec({
        adoptId: ctx.adoptId,
        command: buildSandboxCommand(input),
        timeoutMs,
        env: input.env ?? undefined,
        outputDir: tmpOutputDir ?? undefined,
        // 进度回调：检测 stderr 中的 {"__type":"progress",...} 并发送 SSE 事件
        onProgress: (line: string) => {
          try {
            const p = JSON.parse(line);
            if (p?.__type === "progress" && ctx.sendEvent) {
              ctx.sendEvent("agent_status", {
                kind: "progress",
                tool: originalToolName,
                step: typeof p.step === "number" ? p.step : null,
                total: typeof p.total === "number" ? p.total : null,
                label: typeof p.label === "string" ? p.label : null,
              });
            }
          } catch {}
        },
      });
      exitCode = raw.exitCode;
      stdout = raw.stdout;
      stderr = raw.stderr;
      truncated = raw.truncated;

      // 将沙箱产出文件移至智能体 workspace sandbox-files/ 目录
      if (raw.outputFiles && raw.outputFiles.length > 0 && tmpOutputDir) {
        const workspaceDir = ctx.workspaceDir;
        if (workspaceDir) {
          const filesDir = `${workspaceDir}/sandbox-files`;
          try {
            mkdirSync(filesDir, { recursive: true });
            outputFiles = [];
            for (const f of raw.outputFiles) {
              const src = resolveExistingRegularFile(tmpOutputDir, f.name);
              if (!src) {
                auditLog({ event: "sandbox_output_rejected", adoptId: ctx.adoptId, name: f.name, reason: "not_regular_file" });
                continue;
              }
              const dest = resolveWorkspaceWritePath(workspaceDir, `sandbox-files/${f.name}`);
              if (!dest) {
                auditLog({ event: "sandbox_output_rejected", adoptId: ctx.adoptId, name: f.name, reason: "invalid_destination" });
                continue;
              }
              try {
                renameSync(src, dest);
                outputFiles.push({ name: f.name, size: f.size, workspacePath: dest });
              } catch {}
            }
          } catch {}
        }
      }
    } catch (err: any) {
      errorType = "execution_error";
      stdout = `[sandbox_exec error] ${err?.message ?? String(err)}`;
      exitCode = 1;
    } finally {
      // 清理临时 output 目录残留
      if (tmpOutputDir) {
        try {
          for (const f of readdirSync(tmpOutputDir)) {
            try { unlinkSync(`${tmpOutputDir}/${f}`); } catch (e) { console.warn(`[sandbox-cleanup] unlink failed: ${tmpOutputDir}/${f}`, e); }
          }
          rmdirSync(tmpOutputDir);
        } catch (e) { console.warn(`[sandbox-cleanup] rmdir failed: ${tmpOutputDir}`, e); }
      }
    }
  } else {
    // 不应该走到这里（policy 已拦掉）
    errorType = "unknown_error";
    stdout = `[unsupported handler] ${routedToolName}`;
    exitCode = 1;
  }

  const durationMs = Date.now() - startMs;
  const output = buildOutput(stdout ?? "", stderr, exitCode, truncated);

  // ── Step 4: 结果标准化 + 落库 ───────────────────────────────────────────
  enqueueAudit({
    auditId, requestId: ctx.adoptId, userId: ctx.userId, agentId: ctx.agentId,
    profile: ctx.permissionProfile, toolCallId: req.id,
    originalToolName, routedToolName,
    command: input.cmd ?? undefined,
    args: input.args ?? undefined,
    cwd: input.cwd ?? undefined,
    timeoutMs: input.timeoutMs ?? TOOL_POLICY.sandboxExec.timeoutMs,
    policyDecision: "allow",
    executor: routedToolName as ExecutorName,
    exitCode,
    stdoutBytes: (stdout ?? "").length,
    stderrBytes: (stderr ?? "").length,
    truncated,
    durationMs,
    createdAt: Date.now(),
  });
  trackLedgerWrite(recordToolLedgerEvent({
    auditId, requestId: ctx.adoptId, userId: ctx.userId, agentId: ctx.agentId,
    profile: ctx.permissionProfile, toolCallId: req.id,
    originalToolName, routedToolName,
    command: input.cmd ?? undefined,
    args: input.args ?? undefined,
    cwd: input.cwd ?? undefined,
    timeoutMs: input.timeoutMs ?? TOOL_POLICY.sandboxExec.timeoutMs,
    policyDecision: "allow",
    executor: routedToolName as ExecutorName,
    exitCode,
    stdoutBytes: (stdout ?? "").length,
    stderrBytes: (stderr ?? "").length,
    truncated,
    durationMs,
    createdAt: Date.now(),
  }, {
    action: (exitCode ?? 1) === 0 && !errorType ? "tool.execution.completed" : "tool.execution.failed",
    result: (exitCode ?? 1) === 0 && !errorType ? "success" : "failed",
    severity: (exitCode ?? 1) === 0 && !errorType ? "info" : "medium",
    errorCode: errorType ? "TOOL_EXECUTION_ERROR" : undefined,
  }));

  auditLog({
    event: "tool_executed",
    auditId,
    adoptId: ctx.adoptId,
    originalToolName,
    routedToolName,
    executor: routedToolName,
    exitCode,
    truncated,
    durationMs,
  });

  return {
    auditId,
    toolCallId: req.id,
    toolName: req.name,
    executor: routedToolName as ExecutorName,
    ok: (exitCode ?? 1) === 0 && !errorType,
    exitCode,
    output,
    truncated,
    errorType,
    outputFiles,
    suppressedOriginalResult: true,
    meta: {
      originalToolName,
      routedToolName,
      policyDecision: "allow",
      deniedReason: undefined,
      durationMs,
      stdoutBytes: (stdout ?? "").length,
      stderrBytes: (stderr ?? "").length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数─────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// 工具函数

function buildOutput(stdout: string, stderr: string | undefined, exitCode: number | undefined, truncated: boolean): string {
  let out = "";
  if (exitCode !== 0 && exitCode !== undefined && stderr) {
    out = `[exit ${exitCode}]\n${stdout || stderr}`;
  } else if (stdout) {
    out = stdout;
  } else if (stderr) {
    out = stderr;
  } else {
    out = "(no output)";
  }
  if (truncated) {
    out += "\n[输出已截断]";
  }
  return out;
}

// 进程退出前刷文件缓冲
process.on("exit", () => {
  if (flushTimer !== null) clearTimeout(flushTimer);
  if (auditBuffer.length > 0) {
    try {
      ensureLogDir();
      const lines = auditBuffer.splice(0).map(r => JSON.stringify(r)).join("\n");
      appendFileSync(LOG_DIR + "/tool-router-final.log", lines + "\n", "utf8");
    } catch {}
  }
});
