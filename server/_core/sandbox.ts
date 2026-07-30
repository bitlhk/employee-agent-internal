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

import { spawn } from "child_process";
import { appendFileSync, chmodSync, chownSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "fs";
import path from "path";
import { resolveExistingRegularFile } from "./file-path-security";
import { beginSandboxExecution, type OperationalOutcome } from "./observability/metrics";
import {
  buildSandboxDockerRunArgs,
  resolveSandboxContainerIdentity,
  sandboxCommandBlockReason,
  type SandboxContainerIdentity,
} from "./sandbox-policy";

export { resolveSandboxContainerIdentity } from "./sandbox-policy";

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

async function runProcess(command: string, args: string[], timeoutMs: number): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    };
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      stderr += error.message;
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
    timer = setTimeout(() => {
      stderr += `process timed out after ${timeoutMs}ms`;
      child.kill("SIGKILL");
      finish(124);
    }, timeoutMs);
    timer.unref();
  });
}

export async function sandboxExec(opts: SandboxExecOpts): Promise<SandboxExecResult> {
  const finishMetric = beginSandboxExecution();
  let metricOutcome: OperationalOutcome = "error";
  const { adoptId, command, onProgress } = opts;
  const timeoutMs = opts.timeoutMs ?? SANDBOX_TIMEOUT_MS;

  // 1. 命令黑名单检查
  const blocked = sandboxCommandBlockReason(command);
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

    const sandboxIdentity = resolveSandboxContainerIdentity();
    const outputMount = opts.outputDir
      ? prepareSandboxOutputDirectory(opts.outputDir, sandboxIdentity)
      : undefined;
    const dockerArgs = buildSandboxDockerRunArgs({
      containerName,
      identity: sandboxIdentity,
      image: SANDBOX_IMAGE,
      memory: SANDBOX_MEMORY,
      cpus: SANDBOX_CPUS,
      pidsLimit: SANDBOX_PIDS_LIMIT,
      tmpfsSize: SANDBOX_TMPFS_SIZE,
      env: opts.env,
      outputMount,
    });

    const startResult = await runProcess("docker", dockerArgs, 5_000);

    if (startResult.exitCode !== 0) {
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

    await new Promise<void>((resolve) => {
      const child = spawn("docker", ["exec", containerName, "sh", "-c", command]);
      let forceKillTimer: NodeJS.Timeout | null = null;

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
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        resolve();
      });

      child.on("error", (err) => {
        exitCode = 1;
        stderr += `\nSpawn error: ${err.message}`;
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        resolve();
      });

      // 超时控制
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
        forceKillTimer.unref();
      }, timeoutMs);
      timer.unref();
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
        await runProcess("docker", ["rm", "-f", containerId], 3_000);
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
export async function sandboxHealthCheck(): Promise<{ ok: boolean; docker: boolean; image: boolean; error?: string }> {
  const dockerInfo = await runProcess("docker", ["info"], 5_000);
  if (dockerInfo.exitCode !== 0) {
    return { ok: false, docker: false, image: false, error: "docker not accessible" };
  }
  const imageInspect = await runProcess("docker", ["inspect", SANDBOX_IMAGE], 5_000);
  if (imageInspect.exitCode !== 0) {
    return { ok: false, docker: true, image: false, error: `image ${SANDBOX_IMAGE} not found` };
  }
  return { ok: true, docker: true, image: true };
}
