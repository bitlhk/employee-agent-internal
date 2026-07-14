/**
 * 安全模块 - 防止各种攻击
 * 包括：XSS、CSRF、SQL注入、暴力破解、DDoS等
 */

import type { Express, Request, Response, NextFunction } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { validationResult } from "express-validator";

/**
 * 配置安全 HTTP 头
 */
export function setupSecurityHeaders(app: Express) {
  const forceHttpsHeaders = (process.env.WORKFORCE_AGENT_FORCE_HTTPS_HEADERS || process.env.LINGXIA_FORCE_HTTPS_HEADERS) === "true";
  // Do not infer HTTPS-only headers from FRONTEND_URL. This deployment keeps
  // both the HTTPS domain and the direct HTTP IP entry available.
  const httpsHeadersEnabled = forceHttpsHeaders;

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          scriptSrc: ["'self'", "'unsafe-inline'"], // unsafe-eval 已移除；如需动态脚本可用 nonce 替代
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
          objectSrc: ["'none'"],
          mediaSrc: ["'self'"],
          frameSrc: ["'self'", ...(process.env.CSP_FRAME_ALLOW ? process.env.CSP_FRAME_ALLOW.split(",").map(s => s.trim()) : [])],
          upgradeInsecureRequests: httpsHeadersEnabled ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false, // 允许 iframe 嵌入
      crossOriginOpenerPolicy: false, // 开发环境允许跨域 opener
      crossOriginResourcePolicy: { policy: "cross-origin" },
      hsts: httpsHeadersEnabled ? { maxAge: 31536000, includeSubDomains: true } : false,
    })
  );
}

import { getClientIp } from "./ip-utils";

/**
 * 通用 API 不做统一限流。页面初始化和轮询会产生突发请求，统一按 IP
 * 限流会误伤反向代理或办公 NAT 后的正常用户。认证、聊天和敏感操作仍
 * 使用各自的专用 limiter。
 */
export function generalLimiter(_req: Request, _res: Response, next: NextFunction) {
  next();
}

/**
 * 登录/注册速率限制
 * 防止暴力破解
 * 触发限制时记录告警
 * 开发模式下禁用限制
 */
export const authLimiter = process.env.NODE_ENV === "development"
  ? ((req: Request, res: Response, next: NextFunction) => {
      next();
    })
  : rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 5,
      message: "登录尝试次数过多，请 15 分钟后重试",
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req: Request) => {
        const trusted = (process.env.CLAW_CHAT_RATELIMIT_TRUSTED_IPS || "").split(",").map(s => s.trim()).filter(Boolean);
        if (trusted.length === 0) return false;
        return trusted.includes(getClientIp(req));
      },
      skipSuccessfulRequests: true,
      handler: async (req: Request, res: Response) => {
        const clientIP = getClientIp(req);
        try {
          const { createSecurityLog } = await import("../db");
          await createSecurityLog({
            ip: clientIP,
            path: req.path.substring(0, 500),
            method: req.method,
            userAgent: req.headers["user-agent"] || null,
            reason: "登录/注册速率限制触发：可能的暴力破解尝试",
            details: JSON.stringify({
              limit: 5,
              windowMs: 15 * 60 * 1000,
              endpoint: req.path,
            }),
            severity: "high",
          });
        } catch (error) {
          console.error("[Security] Failed to log auth rate limit:", error);
        }
        res.status(429).json({ error: "登录尝试次数过多，请 15 分钟后重试" });
      },
    });

export const authActionLimiter = process.env.NODE_ENV === "development"
  ? ((req: Request, res: Response, next: NextFunction) => {
      next();
    })
  : rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 5,
      message: "操作过于频繁，请 15 分钟后重试",
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req: Request) => {
        const trusted = (process.env.CLAW_CHAT_RATELIMIT_TRUSTED_IPS || "").split(",").map(s => s.trim()).filter(Boolean);
        if (trusted.length === 0) return false;
        return trusted.includes(getClientIp(req));
      },
      skipSuccessfulRequests: false,
      handler: async (req: Request, res: Response) => {
        const clientIP = getClientIp(req);
        try {
          const { createSecurityLog } = await import("../db");
          await createSecurityLog({
            ip: clientIP,
            path: req.path.substring(0, 500),
            method: req.method,
            userAgent: req.headers["user-agent"] || null,
            reason: "认证敏感操作速率限制触发",
            details: JSON.stringify({
              limit: 5,
              windowMs: 15 * 60 * 1000,
              endpoint: req.path,
            }),
            severity: "high",
          });
        } catch (error) {
          console.error("[Security] Failed to log auth action rate limit:", error);
        }
        res.status(429).json({ error: "操作过于频繁，请 15 分钟后重试" });
      },
    });

/**
 * 严格速率限制（用于敏感操作）
 * 已禁用：根据用户要求，不再限制操作频率
 * 直接通过，不做限制
 */
export const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "敏感操作过于频繁，请稍后再试" },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * 输入验证中间件（使用 express-validator）
 * 注意：需要在路由中使用 express-validator 的验证链
 */
export const validateInput = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: "输入验证失败",
      details: errors.array(),
    });
  }
  next();
};

/**
 * 清理用户输入，防止 XSS
 */
export function sanitizeInput(input: string): string {
  if (typeof input !== "string") {
    return "";
  }
  
  return input
    .trim()
    .replace(/[<>]/g, "") // 移除潜在的 HTML 标签
    .replace(/javascript:/gi, "") // 移除 javascript: 协议
    .replace(/on\w+=/gi, ""); // 移除事件处理器
}

/**
 * 验证和清理对象的所有字符串字段
 */
export function sanitizeObject<T extends Record<string, any>>(obj: T): Partial<T> {
  const sanitized: Partial<T> = {};
  for (const key in obj) {
    if (typeof obj[key] === "string") {
      (sanitized as any)[key] = sanitizeInput(obj[key]);
    } else if (typeof obj[key] === "object" && obj[key] !== null && !Array.isArray(obj[key])) {
      (sanitized as any)[key] = sanitizeObject(obj[key]);
    } else {
      (sanitized as any)[key] = obj[key];
    }
  }
  return sanitized;
}

/**
 * 请求大小限制中间件
 */
export function requestSizeLimiter(maxSize: number = 50 * 1024 * 1024) {
  return (req: Request, res: Response, next: NextFunction) => {
    const contentLength = req.headers["content-length"];
    if (contentLength && parseInt(contentLength) > maxSize) {
      return res.status(413).json({
        error: "请求体过大",
        maxSize: `${maxSize / 1024 / 1024}MB`,
      });
    }
    next();
  };
}

/**
 * IP 白名单检查（从数据库读取）
 */
export async function checkIpWhitelist(req: Request): Promise<boolean> {
  const clientIP = getClientIp(req);
  try {
    const { isIpWhitelisted } = await import("../db");
    return await isIpWhitelisted(clientIP);
  } catch (error) {
    console.error("[Security] Failed to check IP whitelist:", error);
    return false;
  }
}

/**
 * IP 黑名单检查（从数据库读取）
 */
export async function checkIpBlacklist(req: Request): Promise<boolean> {
  const clientIP = getClientIp(req);
  try {
    const { isIpBlacklisted } = await import("../db");
    return await isIpBlacklisted(clientIP);
  } catch (error) {
    console.error("[Security] Failed to check IP blacklist:", error);
    return false;
  }
}

/**
 * IP 白名单中间件（从数据库读取）
 */
export function ipWhitelistMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const isWhitelisted = await checkIpWhitelist(req);
    if (isWhitelisted) {
      return next();
    }

    // 白名单不是强制性的，如果没有配置白名单，允许所有 IP
    // 只有在明确配置了白名单时才限制
    next();
  };
}

/**
 * IP 黑名单中间件（从数据库读取）
 */
export function ipBlacklistMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // localhost / loopback 永远不封禁
      const _ip = getClientIp(req);
      if (_ip === "127.0.0.1" || _ip === "::1" || _ip === "::ffff:127.0.0.1") return next();

      const isBlacklisted = await checkIpBlacklist(req);
      if (isBlacklisted) {
        const clientIP = getClientIp(req);
        // 记录到安全日志
        try {
          const { createSecurityLog } = await import("../db");
          await createSecurityLog({
            ip: clientIP,
            path: req.path.substring(0, 500),
            method: req.method,
            userAgent: req.headers["user-agent"] || null,
            reason: "IP 地址在黑名单中，请求被拒绝",
            severity: "high",
          });
        } catch (error) {
          console.error("[Security] Failed to log blacklisted IP access:", error);
        }

        return res.status(403).json({ error: "IP 地址已被封禁" });
      }

      next();
    } catch (error) {
      // 如果检查黑名单时出错，记录错误但允许请求继续（避免阻塞正常请求）
      console.error("[Security] Failed to check IP blacklist:", error);
      next();
    }
  };
}

/**
 * 记录可疑活动到数据库
 */
export async function logSuspiciousActivity(
  req: Request,
  reason: string,
  severity: "low" | "medium" | "high" | "critical" = "medium",
  details?: Record<string, any>
) {
  const clientIP =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    (req.headers["x-real-ip"] as string) ||
    req.socket.remoteAddress ||
    "unknown";

  const logData = {
    ip: clientIP,
    path: req.path,
    method: req.method,
    userAgent: req.headers["user-agent"] || null,
    reason,
    timestamp: new Date().toISOString(),
    ...details,
  };

  // 同时记录到控制台
  console.warn(`[Security] 可疑活动检测:`, logData);

  // 异步保存到数据库（不阻塞请求）
  try {
    const { createSecurityLog } = await import("../db");
    await createSecurityLog({
      ip: clientIP,
      path: req.path.substring(0, 500), // 限制长度
      method: req.method,
      userAgent: req.headers["user-agent"] || null,
      reason: reason.substring(0, 200), // 限制长度
      details: details ? JSON.stringify(details) : null,
      severity,
    });
  } catch (error) {
    // 如果数据库写入失败，只记录到控制台
    console.error("[Security] Failed to save security log to database:", error);
  }
}

/**
 * 检测可疑请求
 */
export function detectSuspiciousActivity(req: Request, res: Response, next: NextFunction) {
  const userAgent = req.headers["user-agent"] || "";
  const path = req.path.toLowerCase();
  const queryString = req.url.toLowerCase();

  // 检测 SQL 注入尝试
  // 注意：避免误判正常的 JSON 和 URL 编码内容
  const sqlInjectionPatterns = [
    /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION)\b.*\b(FROM|INTO|WHERE|SET|VALUES)\b)/i, // 完整的 SQL 语句模式
    /(--|\/\*|\*\/)(?!.*json)/i, // SQL 注释，但排除 JSON 相关内容
  ];

  // 检测 XSS 尝试
  const xssPatterns = [
    /<script[^>]*>.*?<\/script>/gi,
    /javascript:/gi,
    /\bon\w+\s*=/gi,
    /<iframe/gi,
    /<object/gi,
    /<embed/gi,
  ];

  // 检测路径遍历（只在路径中检测，不在查询参数中）
  const pathTraversalPatterns: RegExp[] = [];
  // 只在路径中检测，避免误判查询参数中的正常内容
  if (path.includes('../') || path.includes('..\\')) {
    pathTraversalPatterns.push(/\.\./);
  }

  const suspiciousPatterns = [
    ...sqlInjectionPatterns,
    ...xssPatterns,
    ...pathTraversalPatterns,
  ];

  const suspiciousContent = path + queryString + userAgent;

  // 跳过对 tRPC 和 API 路由的严格检测（这些路由使用 JSON 和 URL 编码是正常的）
  const isApiRoute = path.startsWith('/api/trpc') || path.startsWith('/api/');
  
  // 跳过对静态资源文件的检测（文件名可能包含 -- 等字符，这是正常的）
  const isStaticAsset = path.startsWith('/assets/') || path.startsWith('/images/') || 
                        /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|json)$/i.test(path);
  
  for (const pattern of suspiciousPatterns) {
    // 对于 API 路由，使用更宽松的检测
    if (isApiRoute && (sqlInjectionPatterns.includes(pattern) || pathTraversalPatterns.includes(pattern))) {
      continue; // 跳过对 API 路由的 SQL 注入和路径遍历检测
    }
    
    // 对于静态资源文件，跳过 SQL 注入检测（文件名可能包含 --）
    if (isStaticAsset && sqlInjectionPatterns.includes(pattern)) {
      continue; // 跳过对静态资源的 SQL 注入检测
    }
    
    if (pattern.test(suspiciousContent)) {
      // 根据模式类型确定严重程度
      let severity: "low" | "medium" | "high" | "critical" = "medium";
      if (sqlInjectionPatterns.includes(pattern)) {
        severity = "high";
      } else if (xssPatterns.includes(pattern)) {
        severity = "high";
      } else if (pathTraversalPatterns.includes(pattern)) {
        severity = "critical";
      }

      // 异步记录日志，不阻塞请求
      logSuspiciousActivity(
        req,
        `检测到可疑模式: ${pattern}`,
        severity,
        {
          pattern: pattern.toString(),
          matchedContent: suspiciousContent.substring(0, 500),
        }
      ).catch((error) => {
        console.error("[Security] Failed to log suspicious activity:", error);
      });
      
      return res.status(400).json({
        error: "请求包含可疑内容",
      });
    }
  }

  next();
}


/**
 * 岗位智能体聊天接口速率限制
 * 按 adoptId 限速（优先），兜底按 IP
 * 每个 adoptId 每分钟最多 15 次请求
 */
export const clawChatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number.parseInt(process.env.CLAW_CHAT_RATELIMIT_MAX || "60", 10) || 60,
  keyGenerator: (req: Request) => {
    const adoptId = req.body?.adoptId;
    if (typeof adoptId === "string" && adoptId.length > 0) {
      return "adoptId:" + adoptId.slice(0, 64);
    }
    return getClientIp(req);
  },
  message: { error: "请求过于频繁，请稍后再试" },
  standardHeaders: true,
  legacyHeaders: false,
  handler: async (req: Request, res: Response) => {
    const clientIP = getClientIp(req);
    const adoptId = req.body?.adoptId || "";
    try {
      const { createSecurityLog } = await import("../db");
      await createSecurityLog({
        ip: clientIP,
        path: req.path.substring(0, 500),
        method: req.method,
        userAgent: req.headers["user-agent"] || null,
        reason: "岗位智能体聊天速率限制触发",
        details: JSON.stringify({ adoptId: adoptId.slice(0, 64) }),
        severity: "medium",
      });
    } catch {}
    res.status(429).json({ error: "请求过于频繁，请稍后再试" });
  },
});
