import "dotenv/config";
import "./runtime-permissions";
// 全局异常捕获：防止 uncaught exception 导致服务崩溃，并打印完整 stack 方便排查
process.on("uncaughtException", (err: Error) => {
  console.error("[UNCAUGHT EXCEPTION] Shutting down gracefully...");
  console.error("Error:", err?.message);
  console.error("Stack:", err?.stack);
  // 给 PM2/systemd 5 秒优雅退出，然后重启干净的进程
  setTimeout(() => process.exit(1), 5000);
});
process.on("unhandledRejection", (reason: unknown) => {
  console.error("[UNHANDLED REJECTION]", reason);
});
import express, { type Request, type Response, type NextFunction } from "express";
import { createServer } from "http";
import net from "net";
import path from "path";
import { execSync } from "child_process";
import { randomUUID } from "crypto";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import compression from "compression";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerVoiceRoutes } from "./voice";
import { startRecycler } from "./recycler";
import { registerCronRoutes } from "./claw-cron";
import { registerJiuwenWebhookRoutes } from "./jiuwen-webhook";
import { registerNotifyRoutes } from "./claw-notify";
import { registerWeixinRoutes } from "./claw-weixin";
import { registerFeishuRoutes } from "./claw-feishu";
import { registerSkillRoutes } from "./claw-skills";
import { registerCollabRoutes } from "./claw-collab";
import { registerAgentTaskRoutes } from "./claw-agent-tasks";
import { registerPlatformToolsMcpRoutes } from "./platform-tools-mcp";
import { registerCustomMcpRoutes } from "./custom-mcp";
import { registerSkillConfigRoutes } from "./claw-skill-config";
import { registerToolsPolicyRoutes } from "./claw-tools-policy";
import { registerCoreFileRoutes } from "./claw-core-files";
import { registerMemoryRoutes } from "./claw-memory";
import { registerDownloadRoutes } from "./claw-downloads";
import { registerFilesRoutes } from "./claw-files";
import { registerSandboxRoutes } from "./claw-sandbox";
import { registerManagedBrowserRoutes } from "./managed-browser";
import { registerChatStreamRoutes } from "./claw-chat";
import { registerRecoverRoutes } from "./claw-recover";
import { registerCoopUploadRoutes } from "./coop-upload";
import { registerEaSessionViewRoutes } from "./ea-session-view";
import { registerEaAssistantRoutes } from "./ea-assistant-routes";
import { registerWSProxy } from "./claw-ws-proxy";
import { registerMiscRoutes } from "./claw-misc";
import { registerAuditExportRoutes } from "./audit-export-routes";
import { registerAuditIngestRoutes } from "./claw-audit-ingest";
import { registerDesktopRoutes, registerDesktopWSProxy } from "./desktop";
import { APP_ROOT, startApplicationLogRetention } from "./helpers";
import { getRoleSkillMcpBaseline, listAgentRoleTemplates } from "./role-templates";
import { sdk } from "./sdk";
import { resolveAppBindIp } from "./network-bind";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { getClawByAdoptId, getDb } from "../db";
import { getClientIp } from "./ip-utils";
import { cookieCsrfProtection } from "./csrf";
import {
  injectInstallerTelemetry,
  INSTALLER_VERSION,
  registerInstallTelemetryRoutes,
  resolveInstallTelemetryEndpoint,
} from "./install-telemetry";
import { recordInstallEvent } from "../db/install-telemetry";
import { startAgentMemoryRuntime } from "./agent-memory";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let openClawVersionCache: { value: string; expiresAt: number } | null = null;
let runtimeVersionsCache: {
  value: {
    openclaw: string;
    jiuwenswarm: string;
  };
  expiresAt: number;
} | null = null;
const iosLoadDebugEnabled = process.env.IOS_LOAD_DEBUG === "1";
startApplicationLogRetention();

const roleBaseline = getRoleSkillMcpBaseline();
console.log("[ROLE-TEMPLATE] baseline loaded", {
  version: roleBaseline.version,
  defaultRole: roleBaseline.schema.defaultRole,
  roles: listAgentRoleTemplates().length,
});

function logIosLoadDebug(message: string, fields: Record<string, unknown> = {}): void {
  if (!iosLoadDebugEnabled) return;
  console.log(`[IOS-LOAD] ${message}`, fields);
}

function readOpenClawVersion(): string {
  try {
    return String(execSync("openclaw --version", { encoding: "utf-8", timeout: 2500 }) || "").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function readPm2ProcessScriptPath(processName: string): string | null {
  try {
    const raw = String(execSync("pm2 jlist", { encoding: "utf-8", timeout: 2500 }) || "").trim();
    if (!raw) return null;
    const apps = JSON.parse(raw);
    if (!Array.isArray(apps)) return null;
    const found = apps.find((app) => String(app?.name || "") === processName && String(app?.pm2_env?.status || "") === "online");
    const scriptPath = String(found?.pm2_env?.pm_exec_path || found?.pm_exec_path || "").trim();
    return scriptPath || null;
  } catch {
    return null;
  }
}

function readJiuwenSwarmVersion(): string {
  const runningPython = readPm2ProcessScriptPath("jiuwenswarm-agentserver");
  const pythonCandidates = [
    runningPython,
    process.env.JIUWENSWARM_PYTHON,
    process.env.JIUWENCLAW_PYTHON,
    "/root/jiuwenclaw/bin/python3",
    "/home/ubuntu/.venvs/jiuwenswarm-023b1/bin/python",
    "/home/ubuntu/.venvs/jiuwenswarm-022-f538/bin/python3",
    "python3",
  ].filter(Boolean) as string[];
  const script = "import importlib.metadata; print(importlib.metadata.version('jiuwenswarm'))";
  for (const python of pythonCandidates) {
    try {
      const version = String(execSync(`${JSON.stringify(python)} -c ${JSON.stringify(script)}`, {
        encoding: "utf-8",
        timeout: 2500,
      }) || "").trim();
      if (version) return version;
    } catch {}
  }
  return "unknown";
}

function resolveProtectedClawAdoptId(req: Request): string | null {
  const pathMatch = String(req.path || "").match(/^\/claw\/(lgc-[a-z0-9-]+)(?:\/|$)/i);
  return pathMatch?.[1] || null;
}

async function guardProtectedClawSpa(req: Request, res: Response): Promise<boolean> {
  const startedAt = Date.now();
  if (req.path === "/login" || req.path === "/reset-password") {
    logIosLoadDebug("guard_skip_auth_page", {
      path: req.path,
      ms: Date.now() - startedAt,
    });
    return true;
  }
  const adoptId = resolveProtectedClawAdoptId(req);
  if (!adoptId) {
    logIosLoadDebug("guard_skip_public_route", {
      path: req.path,
      host: req.headers.host,
      ms: Date.now() - startedAt,
    });
    return true;
  }

  let user: any = null;
  try {
    user = await sdk.authenticateRequest(req);
  } catch {
    const redirect = encodeURIComponent(`${req.originalUrl || req.url || "/"}`);
    res.redirect(302, `/login?redirect=${redirect}`);
    logIosLoadDebug("guard_redirect_login", {
      path: req.path,
      adoptId,
      ms: Date.now() - startedAt,
    });
    return false;
  }

  const claw = await getClawByAdoptId(adoptId).catch(() => null);
  if (!claw || Number((claw as any).userId || 0) !== Number(user?.id || 0)) {
    res.status(403).send(`<!doctype html><meta charset="utf-8"><title>无权访问</title><body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;color:#0f172a"><main style="min-height:100vh;display:grid;place-items:center;padding:24px"><section style="max-width:420px;border:1px solid #e2e8f0;background:white;border-radius:14px;padding:32px;text-align:center;box-shadow:0 12px 30px rgba(15,23,42,.08)"><h1 style="font-size:22px;margin:0 0 12px">无权访问该工作台</h1><p style="font-size:14px;line-height:1.7;color:#64748b;margin:0">当前账号没有该岗位智能体实例的访问权限。请切换到实例所属账号，或返回自己的工作台。</p><a href="/" style="display:inline-block;margin-top:22px;padding:10px 16px;border-radius:10px;background:#0f172a;color:white;text-decoration:none;font-size:14px">返回首页</a></section></main></body>`);
    logIosLoadDebug("guard_forbidden", {
      path: req.path,
      adoptId,
      userId: user?.id,
      clawUserId: (claw as any)?.userId,
      ms: Date.now() - startedAt,
    });
    return false;
  }
  logIosLoadDebug("guard_ok", {
    path: req.path,
    adoptId,
    userId: user?.id,
    ms: Date.now() - startedAt,
  });
  return true;
}

import {
  setupSecurityHeaders,
  generalLimiter,
  authActionLimiter,
  authLimiter,
  strictLimiter,
  clawChatLimiter,
  detectSuspiciousActivity,
  requestSizeLimiter,
  ipBlacklistMiddleware,
} from "./security";
import { resolveTrustProxySetting } from "./ip-utils";
import {
  block4xxAbuse,
  trackResponseErrors,
} from "./error-tracking";
import { sandboxExec, sandboxHealthCheck } from "./sandbox";
import { startAuditDlqWorker } from "./audit-dlq-worker";
import { routeTool, type ToolContext } from "./tool_router";
import { buildChatRequestBody, type PermissionProfile } from "./tool_schema";


// 检查端口是否可用，如果被占用则抛出错误（不自动切换端口）
async function checkPortAvailable(port: number, bindIp: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(port, bindIp, () => {
      server.close(() => resolve());
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use. Please stop the process using this port or change the PORT environment variable.`));
      } else {
        reject(err);
      }
    });
  });
}



async function startServer() {
  const app = express();
  const server = createServer(app);
  
  // ========== 信任代理配置 ==========
  // 如果应用部署在代理服务器（如 nginx）后面，需要信任代理以正确获取客户端IP
  // 开发环境：信任所有代理（localhost 场景）
  // 生产环境：根据实际情况配置信任的代理IP
  const trustProxy = resolveTrustProxySetting(process.env.TRUST_PROXY, process.env.NODE_ENV);
  app.set("trust proxy", trustProxy);
  if (trustProxy === false) {
    console.log("[Server] Trust proxy disabled; set TRUST_PROXY explicitly when running behind a trusted reverse proxy");
  } else {
    console.log(`[Server] Trust proxy enabled for: ${Array.isArray(trustProxy) ? trustProxy.join(",") : String(trustProxy)}`);
  }
  
  // ========== 性能优化 ==========
  // 启用 gzip 压缩（在所有中间件之前，确保所有响应都被压缩）
  // compression 中间件会自动处理静态文件和动态响应
  app.use(compression({
    filter: (req, res) => {
      // SSE 端点不压缩——compression 会缓冲数据，破坏流式
      if (req.path === "/api/claw/chat-stream") {
        return false;
      }
      if (req.path === "/api/internal/platform-tools/mcp") {
        return false;
      }
      // 如果请求头明确要求不压缩，则不压缩
      if (req.headers["x-no-compression"]) {
        return false;
      }
      // 使用默认过滤器，它会自动识别可压缩的内容类型
      // 包括：text/*, application/javascript, application/json, application/xml, 
      // image/svg+xml, font/* 等
      return compression.filter(req, res);
    },
    level: 6, // 压缩级别 1-9，6 是平衡性能和压缩率的好选择
    threshold: 512, // 降低阈值到 512 字节，压缩更多小文件（包括首页 HTML）
    // 压缩所有可压缩的内容类型
    memLevel: 8, // 内存使用级别（1-9），8 是较好的平衡
  }));
  
  // ========== 安全配置 ==========
  // 1. 设置安全 HTTP 头
  setupSecurityHeaders(app);
  
  // 2. IP 黑名单检查（最优先，在所有其他检查之前）
  app.use(ipBlacklistMiddleware());
  
  // 3. 检测可疑活动（在所有中间件之前）
  app.use(detectSuspiciousActivity);
  
  // 4. 4xx 错误追踪和限制（在速率限制之前）
  app.use(trackResponseErrors);
  app.use(block4xxAbuse);
  
  // 5. 请求大小限制；50MB 文件经 base64 JSON 上传后约 66.7MB。
  app.use(requestSizeLimiter(80 * 1024 * 1024)); // 80MB request envelope
  
  // 6. 通用速率限制
  app.use(generalLimiter);
  
  // Configure CORS for frontend-backend separation
  // 支持多个 origin，用逗号分隔
  const allowedOrigins = process.env.CORS_ORIGIN 
    ? process.env.CORS_ORIGIN.split(',').map(origin => origin.trim())
    : ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'];

  app.use(cookieCsrfProtection(allowedOrigins));
  
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    
    // 如果请求有 origin 头，且在我们的允许列表中，则允许
    if (origin && allowedOrigins.includes(origin)) {
      res.header("Access-Control-Allow-Origin", origin);
    } else if (allowedOrigins.length === 1 && allowedOrigins[0] === '*') {
      // 只有在明确设置为 '*' 时才使用通配符（不推荐，因为不支持 credentials）
      res.header("Access-Control-Allow-Origin", "*");
    }
    
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.header("Access-Control-Allow-Credentials", "true");
    
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });

  // Anonymous installer events have a deliberately small request envelope.
  registerInstallTelemetryRoutes(app);

  // Configure body parser with larger size limit for 50MB base64 file uploads.
  app.use(express.json({ limit: "80mb" }));
  app.use(express.urlencoded({ limit: "80mb", extended: true }));
  
  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);
  registerVoiceRoutes(app);
  registerJiuwenWebhookRoutes(app);
  registerCronRoutes(app);
  registerNotifyRoutes(app);
  registerWeixinRoutes(app);
  registerFeishuRoutes(app);
  // 启动微信双向聊天桥
  import("./claw-weixin-bridge").then(m => m.startWeixinBridge()).catch(e => console.error("weixin bridge start failed:", e));
  // 启动 cron 结果投递轮询（岗位智能体平台侧，补充 Gateway 不支持的渠道）
  import("./cron-delivery").then(m => m.startCronDeliveryPoller()).catch(e => console.error("cron delivery poller start failed:", e));
  registerSkillRoutes(app);
  registerCollabRoutes(app);
  registerAgentTaskRoutes(app);
  registerPlatformToolsMcpRoutes(app);
  registerCustomMcpRoutes(app);
  registerSkillConfigRoutes(app);
  registerToolsPolicyRoutes(app);
  registerCoreFileRoutes(app);
  registerMemoryRoutes(app);
  registerDownloadRoutes(app);
  registerFilesRoutes(app);
  registerSandboxRoutes(app);
  registerManagedBrowserRoutes(app);
  registerChatStreamRoutes(app);
  registerRecoverRoutes(app);
  registerCoopUploadRoutes(app);
  registerEaSessionViewRoutes(app);
  registerEaAssistantRoutes(app);
  registerWSProxy(server);
  registerDesktopWSProxy(server);
  registerMiscRoutes(app);
  registerAuditExportRoutes(app);
  registerAuditIngestRoutes(app);
  registerDesktopRoutes(app);

  // ── 岗位智能体平台流式聊天 SSE 端点 ──
  // Session/auth helpers extracted to ./helpers.ts

  // 登录、注册端点必须在 tRPC 处理器之前限流。
  app.use([
    "/api/trpc/auth.login",
    "/api/trpc/auth.register",
  ], authLimiter);
  app.use([
    "/api/trpc/registration.sendVerificationCode",
    "/api/trpc/auth.sendForgotPasswordVerificationCode",
    "/api/trpc/auth.resetPassword",
    "/api/trpc/auth.requestPasswordReset",
  ], authActionLimiter);

  // tRPC API - 应用速率限制
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext: async (opts) => {
        try {
          return await createContext(opts);
        } catch (error) {
          console.error("[tRPC] Context creation error:", error);
          // 即使创建上下文失败，也返回一个基本的上下文
          return {
            req: opts.req,
            res: opts.res,
            user: null,
          };
        }
      },
      onError: ({ error, path, type }) => {
        // 只记录错误，不手动发送响应（让 tRPC 自己处理）
        console.error(`[tRPC Error] ${type} ${path}:`, error);
      },
    })
  );

  // ── 品牌配置公开 API（无需登录） ──
  app.get("/api/brand", async (_req, res) => {
    const toPublicBrand = (brand: any) => ({
      name: brand.name,
      nameEn: brand.nameEn,
      platform: brand.platform,
      platformEn: brand.platformEn,
      slogan: brand.slogan,
      accentColor: brand.accentColor,
      logo: brand.logo,
      favicon: brand.favicon,
      githubUrl: brand.githubUrl,
      pageTitle: brand.pageTitle,
    });
    try {
      const { getBrandConfig } = await import("./brand");
      const brand = await getBrandConfig();
      res.json(toPublicBrand(brand));
    } catch {
      const { DEFAULT_BRAND } = await import("@shared/brand");
      res.json(toPublicBrand(DEFAULT_BRAND));
    }
  });

  // Public bootstrap entrypoint. Keep the implementation in one audited script.
  app.get("/install.sh", (_req, res) => {
    const installerPath = path.join(APP_ROOT, "scripts", "bootstrap-install.sh");
    if (!existsSync(installerPath)) {
      res.status(404).type("text/plain").send("installer unavailable\n");
      return;
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Content-Disposition", "inline; filename=employee-agent-install.sh");
    res.type("text/x-shellscript; charset=utf-8");
    const installId = randomUUID();
    const endpoint = resolveInstallTelemetryEndpoint();
    const source = endpoint ? "official" : "self-hosted";
    let script = readFileSync(installerPath, "utf8");
    if (endpoint) {
      script = injectInstallerTelemetry(script, { installId, endpoint, source });
    }
    void recordInstallEvent({
      installId,
      eventType: "downloaded",
      source,
      installerVersion: INSTALLER_VERSION,
    }).catch((error) => console.error("[install-telemetry] failed to record installer download", error));
    res.send(script);
  });

  app.get("/api/meta/openclaw-version", async (_req, res) => {
    const now = Date.now();
    if (openClawVersionCache && openClawVersionCache.expiresAt > now) {
      res.json({ version: openClawVersionCache.value });
      return;
    }

    const version = readOpenClawVersion();
    openClawVersionCache = { value: version, expiresAt: now + (version === "unknown" ? 30 * 1000 : 5 * 60 * 1000) };
    res.json({ version });
  });

  app.get("/api/meta/runtime-versions", async (_req, res) => {
    const now = Date.now();
    if (runtimeVersionsCache && runtimeVersionsCache.expiresAt > now) {
      res.json(runtimeVersionsCache.value);
      return;
    }

    const value = {
      openclaw: readOpenClawVersion(),
      jiuwenswarm: readJiuwenSwarmVersion(),
    };
    const hasUnknown = Object.values(value).some((version) => version === "unknown");
    runtimeVersionsCache = { value, expiresAt: now + (hasUnknown ? 30 * 1000 : 5 * 60 * 1000) };
    res.json(value);
  });

  app.get("/api/claw/help-doc", async (_req, res) => {
    try {
      const helpPath = `${APP_ROOT}/HELP.md`;
      if (!existsSync(helpPath)) {
        res.status(404).json({ error: "HELP.md not found" });
        return;
      }
      const content = String(readFileSync(helpPath, "utf-8") || "");
      res.json({ content });
    } catch (_e) {
      res.status(500).json({ error: "read help doc failed" });
    }
  });

  // Health check endpoint（必须在静态文件服务之前）
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // 静态文件服务（始终提供前端构建文件，不区分环境）
  const clientDistPath = path.resolve(__dirname, "../../dist/client");
  const fs = await import("fs");
  const isProduction = process.env.NODE_ENV === "production";
  
  // 检查静态文件目录是否存在
  if (fs.existsSync(clientDistPath)) {
    // 静态资源（JS/CSS/图片等），排除 index.html
    const staticOptions = {
      maxAge: isProduction ? "1y" : 0,
      etag: isProduction,
      lastModified: isProduction,
      index: false, // 禁用自动 index.html 服务，避免冲突
      setHeaders: (res: express.Response, filePath: string) => {
        // index.html 不在这里处理，会在下面的路由中单独处理
        if (filePath.endsWith("index.html")) {
          return; // 跳过 index.html
        }
        // 其他静态资源设置缓存策略
        if (isProduction) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
        }
        // 确保静态资源可以被压缩（compression 中间件会自动处理）
        // 不需要手动设置压缩头，compression 中间件会根据内容类型自动处理
      },
    };
  app.use((req, res, next) => {
    if (!iosLoadDebugEnabled) return next();
    const ext = path.extname(req.path).toLowerCase();
    const shouldTrace = req.path === "/" || req.path === "/login" || [".js", ".css"].includes(ext);
    if (!shouldTrace) return next();

    const startedAt = Date.now();
    let logged = false;
    const logDone = (event: string) => {
      if (logged) return;
      logged = true;
      logIosLoadDebug(event, {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        ms: Date.now() - startedAt,
        host: req.headers.host,
        ua: req.headers["user-agent"],
        ip: getClientIp(req),
      });
    };
    res.once("finish", () => logDone("request_finish"));
    res.once("close", () => {
      if (!res.writableEnded) logDone("request_close_before_finish");
    });
    next();
  });
  app.use(express.static(clientDistPath, staticOptions));
    
    // SPA 路由回退：所有非 API 请求返回 index.html
    // 注意：这个路由必须在静态文件服务之后，确保静态文件优先匹配
    app.get("*", async (req, res, next) => {
      const spaStartedAt = Date.now();
      logIosLoadDebug("spa_route_start", {
        method: req.method,
        path: req.path,
        originalUrl: req.originalUrl,
        host: req.headers.host,
        ua: req.headers["user-agent"],
        ip: getClientIp(req),
      });
      // 跳过 API 路由和 health 检查
      if (req.path.startsWith("/api") || req.path.startsWith("/health")) {
        return next();
      }
      
      // 跳过静态资源文件（已经有 express.static 处理）
      const ext = path.extname(req.path);
      const staticExtensions = [".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".json"];
      if (ext && staticExtensions.includes(ext.toLowerCase())) {
        return next(); // 让 404 处理
      }
      
      // 如果已经发送了响应（比如静态文件已匹配），直接返回
      if (res.headersSent) {
        return;
      }

      if (!(await guardProtectedClawSpa(req, res))) {
        return;
      }
      
      // index.html 的缓存策略
      if (isProduction) {
        // 生产环境：index.html 短期缓存（1小时），确保 SPA 更新能及时生效
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("ETag", `"${Date.now()}"`); // 简单的 ETag，实际应该基于文件内容
      } else {
        // 开发环境：index.html 不缓存
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
      
      const indexPath = path.join(clientDistPath, "index.html");
      if (!fs.existsSync(indexPath)) {
        console.error("[SPA Fallback] index.html not found at:", indexPath);
        return next();
      }
      
      res.sendFile(indexPath, (err) => {
        const isClientAbort = (err as any)?.code === "ECONNABORTED" || /request aborted/i.test(String((err as any)?.message || ""));
        logIosLoadDebug("spa_sendfile_done", {
          path: req.path,
          ms: Date.now() - spaStartedAt,
          statusCode: res.statusCode,
          error: err ? String((err as any)?.message || err) : "",
          headersSent: res.headersSent,
        });
        if (err) {
          if (isClientAbort) return;
          console.error("[SPA Fallback] Error sending index.html:", err);
          if (!res.headersSent) next(err);
        }
      });
    });
  } else {
    console.warn("[Static Files] Frontend build not found at", clientDistPath, "- skipping static file serving");
    
    // 开发环境：如果静态文件不存在，对于非 API 请求提供友好提示或重定向
    if (!isProduction) {
      app.get("*", (req, res, next) => {
        // 跳过 API 路由和 health 检查
        if (req.path.startsWith("/api") || req.path.startsWith("/health")) {
          return next();
        }
        
        // 开发环境提示：前端由 Vite 开发服务器提供
        if (!res.headersSent) {
          res.status(200).send(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>开发服务器提示</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .container {
      text-align: center;
      padding: 2rem;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 1rem;
      backdrop-filter: blur(10px);
      max-width: 600px;
    }
    h1 { margin-top: 0; }
    .info {
      background: rgba(255, 255, 255, 0.2);
      padding: 1rem;
      border-radius: 0.5rem;
      margin: 1rem 0;
    }
    a {
      color: #fff;
      text-decoration: underline;
    }
    code {
      background: rgba(0, 0, 0, 0.3);
      padding: 0.2rem 0.5rem;
      border-radius: 0.25rem;
      font-family: 'Monaco', 'Courier New', monospace;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 开发服务器</h1>
    <div class="info">
      <p>这是后端 API 服务器（端口 5174）</p>
      <p>前端开发服务器运行在：<code>http://localhost:5173</code></p>
      <p><a href="http://localhost:5173" target="_blank">点击访问前端页面</a></p>
    </div>
    <div class="info">
      <p><strong>API 端点：</strong></p>
      <p><code>http://localhost:5174/api/trpc</code></p>
      <p><code>http://localhost:5174/health</code></p>
    </div>
  </div>
</body>
</html>
          `);
        }
      });
    }
  }

  // 全局错误处理中间件（必须在所有路由之后）
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("[Server Error]:", err);
    
    // 确保响应是 JSON 格式
    if (!res.headersSent) {
      res.status(err.status || 500).json({
        error: err.message || "内部服务器错误",
      });
    }
  });

  // 404 处理（必须在所有路由之后，包括静态文件服务）
  app.use((req: Request, res: Response) => {
    if (!res.headersSent) {
      res.status(404).json({ error: "路由不存在" });
    }
  });

  const port = parseInt(process.env.PORT || "5174");
  const bindIp = resolveAppBindIp();
  
  // 检查端口是否可用，如果被占用则直接报错，不自动切换
  try {
    await checkPortAvailable(port, bindIp);
  } catch (error) {
    console.error(`\n❌ 端口 ${port} 已被占用！`);
    console.error(`请停止占用该端口的进程，或修改 .env 文件中的 PORT 环境变量。\n`);
    throw error;
  }

  server.listen(port, bindIp, () => {
    const displayHost = bindIp.includes(":") ? `[${bindIp}]` : bindIp;
    console.log(`✅ Backend API server running on http://${displayHost}:${port}/`);
    console.log(`   API endpoint: http://${displayHost}:${port}/api/trpc`);
    console.log(`   CORS allowed origins: ${allowedOrigins.join(', ')}`);
    const dbWarmupStartedAt = Date.now();
    getDb()
      .then((db) => {
        logIosLoadDebug("db_warmup_done", {
          ok: Boolean(db),
          ms: Date.now() - dbWarmupStartedAt,
        });
        if (db) startAgentMemoryRuntime();
      })
      .catch((error) => {
        console.warn("[Database] Warmup failed:", (error as any)?.message || error);
        logIosLoadDebug("db_warmup_error", {
          error: String((error as any)?.message || error),
          ms: Date.now() - dbWarmupStartedAt,
        });
      });
  });
  startAuditDlqWorker();
  startRecycler();
}
startServer().catch(console.error);
