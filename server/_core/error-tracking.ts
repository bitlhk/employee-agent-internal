/**
 * 错误追踪模块
 * 监控 4xx 错误，对错误率高的 IP 进行限制
 * 当 4xx 错误过多时，自动将 IP 添加到黑名单
 */

import type { Request, Response, NextFunction } from "express";
import { createSecurityLog, createIpManagement, isIpBlacklisted, getSystemConfigNumber } from "../db";

// IP 错误计数器（内存存储，生产环境建议使用 Redis）
interface IpErrorCount {
  count: number;
  firstError: number;
  lastError: number;
  errors: Array<{ status: number; path: string; timestamp: number }>;
}

const ipErrorMap = new Map<string, IpErrorCount>();

// 清理过期记录（1小时前的记录）
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 小时
const ERROR_WINDOW = 15 * 60 * 1000; // 15 分钟窗口
const MAX_4XX_ERRORS = 20; // 15 分钟内最多允许 20 个 4xx 错误（默认值，可通过配置覆盖）
const MAX_4XX_ERROR_RATE = 0.5; // 4xx 错误率超过 50% 触发限制
const AUTO_BLOCK_THRESHOLD = 30; // 自动封禁阈值：15 分钟内超过 30 个 4xx 错误时自动加入黑名单（默认值，可通过配置覆盖）

// 记录已经自动封禁的IP，避免重复添加
const autoBlockedIps = new Set<string>();

import { getClientIp } from "./ip-utils";

/**
 * Some authenticated platform endpoints are allowed to return 4xx during normal
 * UI polling or cache warm-up. Counting those responses as abuse can lock out
 * every user behind the same office/NAT IP.
 */
function isErrorTrackingExemptPath(req: Request): boolean {
  const path = (req.path || "").toLowerCase();
  if (path === "/api/claw/chat-history/messages") return true;
  if (path === "/api/claw/chat-history/sessions") return true;
  if (path === "/api/claw/files/capabilities") return true;
  if (path === "/api/claw/files/list") return true;
  if (path === "/api/claw/health-summary") return true;
  if (path === "/api/claw/mcp-tools/status") return true;
  if (path === "/api/claw/skills/registry") return true;
  if (path === "/api/embed/auth-check") return true;
  if (path.startsWith("/api/ea/session-view/")) return true;
  if (path === "/api/trpc/coop.iswhitelisted") return true;
  if (path === "/api/trpc/ipaccesslogs.getmytodaycount") return true;
  if (path.startsWith("/claw/")) return true;
  return false;
}

function isRoutinePlatformValidationError(req: Request, statusCode: number): boolean {
  if (statusCode !== 400) return false;
  const path = (req.path || "").toLowerCase();
  return path.startsWith("/api/claw/")
    || path.startsWith("/api/ea/")
    || path.startsWith("/api/trpc/");
}

/**
 * 记录 4xx 错误
 */
export async function track4xxError(
  req: Request,
  res: Response,
  statusCode: number
) {
  if (statusCode < 400 || statusCode >= 500) {
    return; // 只追踪 4xx 错误
  }

  // Do not count the limiter's own 429 responses; otherwise one temporary block
  // keeps feeding itself and quickly escalates into a persistent blacklist row.
  if (statusCode === 429 || isErrorTrackingExemptPath(req) || isRoutinePlatformValidationError(req, statusCode)) {
    return;
  }

  // 排除静态资源路径的 404 错误（这些是正常的，不应该计入错误计数）
  const path = req.path.toLowerCase();
  const isStaticAsset = 
    path.startsWith('/assets/') || 
    path.startsWith('/images/') ||
    /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|json|webp|avif)$/i.test(path);
  
  // 静态资源的 404 错误不计入错误追踪（可能是资源未找到，但不影响功能）
  if (isStaticAsset && statusCode === 404) {
    return;
  }

  const clientIP = getClientIp(req);
  const now = Date.now();

  // 获取或创建 IP 错误记录
  let errorCount = ipErrorMap.get(clientIP);
  if (!errorCount) {
    errorCount = {
      count: 0,
      firstError: now,
      lastError: now,
      errors: [],
    };
    ipErrorMap.set(clientIP, errorCount);
  }

  // 清理过期错误记录（15 分钟前的）
  errorCount.errors = errorCount.errors.filter(
    (err) => now - err.timestamp < ERROR_WINDOW
  );

  // 添加新错误
  errorCount.errors.push({
    status: statusCode,
    path: req.path,
    timestamp: now,
  });

  errorCount.count = errorCount.errors.length;
  errorCount.lastError = now;

  // 计算错误率（需要总请求数，这里简化处理）
  const errorRate = errorCount.count / Math.max(errorCount.count, 10);

  // 获取自动封禁阈值（从系统配置读取，如果没有配置则使用默认值）
  let autoBlockThreshold = AUTO_BLOCK_THRESHOLD;
  try {
    // 使用 -1 作为默认值，如果返回 -1 说明配置不存在，使用默认阈值
    const configValue = await getSystemConfigNumber("auto_block_4xx_threshold", -1);
    if (configValue > 0) {
      autoBlockThreshold = configValue;
    }
  } catch (error) {
    // 如果读取配置失败，使用默认值
    console.warn("[ErrorTracking] Failed to read auto_block_4xx_threshold config, using default:", error);
  }

  // 如果 4xx 错误过多，记录告警
  if (errorCount.count >= MAX_4XX_ERRORS || errorRate > MAX_4XX_ERROR_RATE) {
    try {
      await createSecurityLog({
        ip: clientIP,
        path: req.path.substring(0, 500),
        method: req.method,
        userAgent: req.headers["user-agent"] || null,
        reason: `4xx 错误过多：${errorCount.count} 个错误，错误率 ${(errorRate * 100).toFixed(1)}%`,
        details: JSON.stringify({
          errorCount: errorCount.count,
          errorRate: errorRate,
          recentErrors: errorCount.errors.slice(-10), // 最近 10 个错误
          statusCode,
        }),
        severity: errorCount.count >= MAX_4XX_ERRORS ? "high" : "medium",
      });
    } catch (error) {
      console.error("[ErrorTracking] Failed to log 4xx error:", error);
    }
  }

  // 如果错误数量超过自动封禁阈值，自动将 IP 添加到黑名单
  // localhost / loopback 永远不自动封禁
  if (clientIP === "127.0.0.1" || clientIP === "::1" || clientIP === "::ffff:127.0.0.1") return;
  if (errorCount.count >= autoBlockThreshold) {
    // 检查是否已经在黑名单中
    const alreadyBlacklisted = await isIpBlacklisted(clientIP);
    
    // 如果不在黑名单中，且还没有自动封禁过，则添加到黑名单
    if (!alreadyBlacklisted && !autoBlockedIps.has(clientIP)) {
      try {
        // 获取最近错误的详细信息
        const recentErrors = errorCount.errors.slice(-10);
        const errorDetails = recentErrors.map(err => ({
          status: err.status,
          path: err.path,
          time: new Date(err.timestamp).toISOString(),
        }));

        // 添加到黑名单
        await createIpManagement({
          ip: clientIP,
          type: "blacklist",
          reason: `自动封禁：15分钟内产生 ${errorCount.count} 个 4xx 错误（阈值：${autoBlockThreshold}）`,
          severity: "high",
          notes: JSON.stringify({
            autoBlocked: true,
            errorCount: errorCount.count,
            errorRate: errorRate,
            recentErrors: errorDetails,
            blockedAt: new Date().toISOString(),
          }),
          isActive: "yes",
          // expiresAt 可以设置为 null（永久封禁）或设置一个过期时间
          // 这里设置为 24 小时后自动解封，可以根据需要调整
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24小时后过期
        });

        // 标记为已自动封禁，避免重复添加
        autoBlockedIps.add(clientIP);

        // 记录安全日志
        await createSecurityLog({
          ip: clientIP,
          path: req.path.substring(0, 500),
          method: req.method,
          userAgent: req.headers["user-agent"] || null,
          reason: `IP 已自动加入黑名单：15分钟内产生 ${errorCount.count} 个 4xx 错误`,
          details: JSON.stringify({
            action: "auto_blocked",
            errorCount: errorCount.count,
            errorRate: errorRate,
            threshold: autoBlockThreshold,
            recentErrors: errorDetails,
          }),
          severity: "critical",
        });

        console.warn(`[ErrorTracking] IP ${clientIP} 已自动加入黑名单：15分钟内产生 ${errorCount.count} 个 4xx 错误`);
      } catch (error) {
        console.error("[ErrorTracking] Failed to auto-block IP:", error);
        // 即使添加黑名单失败，也记录到安全日志
        try {
          await createSecurityLog({
            ip: clientIP,
            path: req.path.substring(0, 500),
            method: req.method,
            userAgent: req.headers["user-agent"] || null,
            reason: `尝试自动封禁 IP 失败：${error instanceof Error ? error.message : String(error)}`,
            details: JSON.stringify({
              errorCount: errorCount.count,
              errorRate: errorRate,
              threshold: autoBlockThreshold,
            }),
            severity: "high",
          });
        } catch (logError) {
          console.error("[ErrorTracking] Failed to log auto-block failure:", logError);
        }
      }
    }
  }
}

/**
 * 检查 IP 是否应该被限制（4xx 错误过多）
 */
export function shouldBlockIp(ip: string): boolean {
  const errorCount = ipErrorMap.get(ip);
  if (!errorCount) {
    return false;
  }

  const now = Date.now();
  // 清理过期记录
  const recentErrors = errorCount.errors.filter(
    (err) => now - err.timestamp < ERROR_WINDOW
  );

  if (recentErrors.length === 0) {
    return false;
  }

  // 如果 15 分钟内 4xx 错误超过阈值，则限制
  return recentErrors.length >= MAX_4XX_ERRORS;
}

/**
 * 4xx 错误限制中间件
 * 开发模式下禁用限制
 */
export function block4xxAbuse(req: Request, res: Response, next: NextFunction) {
  // 开发模式下不启用限制
  if (process.env.NODE_ENV === "development") {
    return next();
  }

  if (isErrorTrackingExemptPath(req)) {
    return next();
  }

  const clientIP = getClientIp(req);

  if (shouldBlockIp(clientIP)) {
    return res.status(429).json({
      error: "请求错误过多，请稍后再试",
      retryAfter: 900, // 15 分钟
    });
  }

  next();
}

/**
 * 响应拦截器 - 记录 4xx 错误
 * 开发模式下只记录，不限制
 */
export function trackResponseErrors(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const isDevelopment = process.env.NODE_ENV === "development";
  res.once("finish", () => {
    if (res.statusCode >= 400 && res.statusCode < 500) {
      if (!isDevelopment) {
        track4xxError(req, res, res.statusCode).catch(console.error);
      } else {
        console.log(`[Dev] 4xx Error: ${res.statusCode} ${req.path}`);
      }
    }
  });

  next();
}

export function resetErrorTrackingStateForTests(): void {
  ipErrorMap.clear();
  autoBlockedIps.clear();
}

// 定期清理过期记录
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  const ipsToDelete: string[] = [];
  
  ipErrorMap.forEach((errorCount, ip) => {
    // 清理 1 小时前的记录
    if (now - errorCount.lastError > CLEANUP_INTERVAL) {
      ipsToDelete.push(ip);
    }
  });
  
  ipsToDelete.forEach((ip) => {
    ipErrorMap.delete(ip);
    // 同时清理自动封禁标记（如果错误记录已过期，也清理封禁标记）
    autoBlockedIps.delete(ip);
  });
}, CLEANUP_INTERVAL);
cleanupTimer.unref();
