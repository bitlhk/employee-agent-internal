/**
 * sandbox.ts - Plus 隔离执行层
 *
 * 架构：linggan-platform 后端 → Docker 容器（安全参数组合拳）
 * 不依赖 gVisor / OpenSandbox，v1 内嵌方案。
 *
 * 安全参数：
 *   --network none          网络隔离
 *   --read-only             根文件系统只读
 *   --tmpfs /tmp:size=50m   只给 /tmp 可写
 *   --memory 256m           内存上限
 *   --cpus 0.5              CPU 上限
 *   --pids-limit 50         防 fork 炸弹
 *   --cap-drop ALL          删除所有 Linux capabilities
 *   --security-opt no-new-privileges  禁止提权
 */

import { execSync, spawnSync, spawn } from "child_process";
import { appendFileSync, chmodSync, chownSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "fs";
import path from "path";
import { resolveExistingRegularFile } from "./file-path-security";
import { beginSandboxExecution, type OperationalOutcome } from "./observability/metrics";

const APP_ROOT = process.env.APP_ROOT || process.cwd();

// ── 配置 ──────────────────────────────────────────────────────────────
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "python:3.11-slim";
const SANDBOX_MEMORY = process.env.SANDBOX_MEMORY || "256m";
const SANDBOX_CPUS = process.env.SANDBOX_CPUS || "0.5";
const SANDBOX_PIDS_LIMIT = parseInt(process.env.SANDBOX_PIDS_LIMIT || "50");
const SANDBOX_TMPFS_SIZE = process.env.SANDBOX_TMPFS_SIZE || "50m";
const SANDBOX_TIMEOUT_MS = parseInt(process.env.SANDBOX_EXEC_TIMEOUT_MS || "10000");
const SANDBOX_MAX_OUTPUT = parseInt(process.env.SANDBOX_MAX_OUTPUT_BYTES || String(64 * 1024)); // 64KB

// 并发控制
const SANDBOX_MAX_GLOBAL = parseInt(process.env.SANDBOX_MAX_GLOBAL || "5");
const SANDBOX_MAX_PER_USER = parseInt(process.env.SANDBOX_MAX_PER_USER || "2");

export type SandboxContainerIdentity = { uid: number; gid: number; value: string };

export function resolveSandboxContainerIdentity(
  configured = process.env.SANDBOX_USER,
  hostUid = typeof process.getuid === "function" ? process.getuid() : 0,
  hostGid = typeof process.getgid === "function" ? process.getgid() : 0,
): SandboxContainerIdentity {
  const fallbackUid = hostUid > 0 ? hostUid : 65534;
  const fallbackGid = hostGid > 0 ? hostGid : 65534;
  const match = String(configured || "").trim().match(/^(\d+)(?::(\d+))?$/);
  const requestedUid = match ? Number(match[1]) : fallbackUid;
  const requestedGid = match ? Number(match[2] || match[1]) : fallbackGid;
  const uid = Number.isSafeInteger(requestedUid) && requestedUid > 0 ? requestedUid : fallbackUid;
  const gid = Number.isSafeInteger(requestedGid) && requestedGid > 0 ? requestedGid : fallbackGid;
  return { uid, gid, value: `${uid}:${gid}` };
}

export function collectSafeSandboxOutputFiles(outputDir: string): Array<{ name: string; size: number }> {
  const root = realpathSync(outputDir);
  return readdirSync(root).flatMap((name) => {
    const safePath = resolveExistingRegularFile(root, name);
    if (!safePath) return [];
    const stats = lstatSync(safePath);
    return [{ name, size: stats.size }];
  });
}

function prepareSandboxOutputDirectory(outputDir: string, identity: SandboxContainerIdentity): string {
  const entry = lstatSync(outputDir);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("sandbox output directory is invalid");
  const real = realpathSync(outputDir);
  const hostUid = typeof process.getuid === "function" ? process.getuid() : 0;
  if (hostUid === 0) {
    chownSync(real, identity.uid, identity.gid);
  } else if (identity.uid !== hostUid) {
    throw new Error("SANDBOX_USER must match the non-root service uid");
  }
  chmodSync(real, 0o700);
  return real;
}

// ── 状态追踪 ─────────────────────────────────────────────────────────
const activeByUser = new Map<string, number>(); // adoptId -> count
let activeGlobal = 0;

// ── 审计日志 ─────────────────────────────────────────────────────────
function auditLog(entry: Record<string, unknown>) {
  const logDir = `${APP_ROOT}/logs`;
  try { mkdirSync(logDir, { recursive: true }); } catch {}
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try { appendFileSync(`${logDir}/sandbox-exec.log`, line + "\n", "utf8"); } catch {}
}

// ── 命令黑名单（基础防护层） ─────────────────────────────────────────
const BLOCKED_PATTERNS = [
  /\bsudo\b/,
  /\bsu\b\s/,
  /\bchmod\b.*[+]s/,         // setuid
  /\/proc\/sysrq/,
  /\/dev\/sd/,                // 块设备
  /\bdd\b.*\/dev\//,         // dd 写设备
  /\bnsenter\b/,
  /\bunshare\b/,
  /\bmount\b/,
];

function isCommandBlocked(cmd: string): string | null {
  for (const pat of BLOCKED_PATTERNS) {
    if (pat.test(cmd)) return `blocked pattern: ${pat}`;
  }
  return null;
}

// ── 核心执行接口 ─────────────────────────────────────────────────────
export interface SandboxExecOpts {
  adoptId: string;
  command: string;           // shell 命令字符串
  timeoutMs?: number;
  env?: Record<string, string>;
  /** 进度回调：每当 stderr 出现 {"__type":"progress",...} 时触发 */
  onProgress?: (line: string) => void;
  /** 宿主机目录，挂载为容器内 /output（可写），用于导出文件 */
  outputDir?: string;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  /** 容器写到 /output 的文件名列表（已移至 workspace） */
  outputFiles?: Array<{ name: string; size: number }>;
}

export async function sandboxExec(opts: SandboxExecOpts): Promise<SandboxExecResult> {
  const finishMetric = beginSandboxExecution();
  let metricOutcome: OperationalOutcome = "error";
  const { adoptId, command, onProgress } = opts;
  const timeoutMs = opts.timeoutMs ?? SANDBOX_TIMEOUT_MS;

  // 1. 命令黑名单检查
  const blocked = isCommandBlocked(command);
  if (blocked) {
    auditLog({ event: "sandbox_blocked", adoptId, command, reason: blocked });
    finishMetric("error", 0);
    return { exitCode: 1, stdout: "", stderr: `Command blocked: ${blocked}`, truncated: false, durationMs: 0 };
  }

  // 2. 并发限制
  const userActive = activeByUser.get(adoptId) || 0;
  if (userActive >= SANDBOX_MAX_PER_USER) {
    finishMetric("error", 0);
    return { exitCode: 1, stdout: "", stderr: `Too many concurrent executions (max ${SANDBOX_MAX_PER_USER} per user)`, truncated: false, durationMs: 0 };
  }
  if (activeGlobal >= SANDBOX_MAX_GLOBAL) {
    finishMetric("error", 0);
    return { exitCode: 1, stdout: "", stderr: `Sandbox busy, please retry later`, truncated: false, durationMs: 0 };
  }

  // 3. 增加计数
  activeByUser.set(adoptId, userActive + 1);
  activeGlobal++;

  const startMs = Date.now();
  let containerId: string | null = null;

  try {
    // 4. 启动容器（detach 模式，后续 exec）
    const containerName = `sb-${adoptId.replace(/[^a-z0-9]/gi, "")}-${Date.now()}`;

    // 构建 docker run 命令
    const sandboxIdentity = resolveSandboxContainerIdentity();
    const dockerArgs = [
      "run",
      "--rm",
      "--detach",
      `--name=${containerName}`,
      "--network=none",
      "--read-only",
      `--tmpfs=/tmp:size=${SANDBOX_TMPFS_SIZE}`,
      `--memory=${SANDBOX_MEMORY}`,
      `--cpus=${SANDBOX_CPUS}`,
      `--pids-limit=${SANDBOX_PIDS_LIMIT}`,
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      `--user=${sandboxIdentity.value}`,
      "--env=HOME=/tmp",
    ];

    // 用户自定义环境变量（过滤危险 key）
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        if (/^[A-Z_][A-Z0-9_]*$/i.test(k)) {
          dockerArgs.push(`--env=${k}=${v}`);
        }
      }
    }

    // 挂载输出目录（宿主机目录 → 容器 /output，可写）
    if (opts.outputDir) {
      const outputDir = prepareSandboxOutputDirectory(opts.outputDir, sandboxIdentity);
      dockerArgs.push(`-v`, `${outputDir}:/output`);
    }

    dockerArgs.push(SANDBOX_IMAGE, "sh", "-c", "sleep 30");

    const startResult = spawnSync("docker", dockerArgs, {
      timeout: 5000,
    });

    if (startResult.status !== 0) {
      throw new Error(`Failed to start container: ${startResult.stderr}`);
    }

    containerId = containerName;

    // 5. 在容器内执行命令（带超时 + stderr 流式进度检测）
    // 使用 async spawn 而非 spawnSync，以便实时读取 stderr
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let exitCode: number | null = null;
    let timedOut = false;

    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", ["exec", containerName, "sh", "-c", command], {
        timeout: timeoutMs,
      });

      // stdout 收集（异步累积）
      child.stdout!.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.length > SANDBOX_MAX_OUTPUT) {
          stdout = stdout.slice(0, SANDBOX_MAX_OUTPUT);
          truncated = true;
        }
      });

      // stderr 流式解析：检测 {"__type":"progress",...} 并触发回调
      const PROGRESS_RE = /^\s*\{"__type"\s*:\s*"progress"/;
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        // 按换行符分割，逐行检测进度 JSON
        const lines = stderr.split("\n");
        // 保留最后一行（可能不完整，等下次 data 再处理）
        stderr = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && PROGRESS_RE.test(trimmed)) {
            try {
              JSON.parse(trimmed); // 验证是合法 JSON
              onProgress?.(trimmed);
            } catch {}
          }
        }
        if (stderr.length > SANDBOX_MAX_OUTPUT) {
          stderr = stderr.slice(0, SANDBOX_MAX_OUTPUT);
          truncated = true;
        }
      });

      child.on("close", (code) => {
        exitCode = code ?? (child.killed ? 130 : 1);
        resolve();
      });

      child.on("error", (err) => {
        exitCode = 1;
        stderr += `\nSpawn error: ${err.message}`;
        resolve();
      });

      // 超时控制
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);

      child.on("close", () => clearTimeout(timer));
    });

    const durationMs = Date.now() - startMs;
    const finalExitCode = Number(exitCode ?? 1);

    // 扫描 /output 目录，返回文件列表（由 caller 负责移走）
    let outputFiles: Array<{ name: string; size: number }> | undefined;
    if (opts.outputDir) {
      try {
        const entries = collectSafeSandboxOutputFiles(opts.outputDir);
        if (entries.length > 0) outputFiles = entries;
      } catch {}
    }

    auditLog({
      event: "sandbox_exec",
      adoptId,
      command,
      exitCode: finalExitCode,
      durationMs,
      truncated,
      timedOut,
      outputFileCount: outputFiles?.length ?? 0,
    });

    metricOutcome = timedOut ? "timeout" : finalExitCode === 0 ? "success" : "error";

    return { exitCode: finalExitCode, stdout, stderr, truncated, durationMs, outputFiles };

  } catch (err: any) {
    auditLog({ event: "sandbox_error", adoptId, command, error: String(err) });
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Sandbox error: ${err?.message || String(err)}`,
      truncated: false,
      durationMs: Date.now() - startMs,
    };
  } finally {
    finishMetric(metricOutcome, Date.now() - startMs);
    // 6. 强制清理容器
    if (containerId) {
      try {
        spawnSync("docker", ["rm", "-f", containerId], { timeout: 3000 });
      } catch {}
    }
    // 7. 释放计数
    const cur = activeByUser.get(adoptId) || 1;
    if (cur <= 1) activeByUser.delete(adoptId);
    else activeByUser.set(adoptId, cur - 1);
    activeGlobal = Math.max(0, activeGlobal - 1);
  }
}

// ── 健康检查 ─────────────────────────────────────────────────────────
export function sandboxHealthCheck(): { ok: boolean; docker: boolean; image: boolean; error?: string } {
  try {
    execSync("docker info", { stdio: "pipe", timeout: 5000 });
  } catch {
    return { ok: false, docker: false, image: false, error: "docker not accessible" };
  }
  try {
    execSync("docker inspect " + SANDBOX_IMAGE, { stdio: "pipe", timeout: 5000 });
  } catch {
    return { ok: false, docker: true, image: false, error: `image ${SANDBOX_IMAGE} not found` };
  }
  return { ok: true, docker: true, image: true };
}
