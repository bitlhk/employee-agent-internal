import express from "express";
import { strictLimiter } from "./security";
import { createContext } from "./context";
import { getClientIp } from "./ip-utils";
// DB functions are dynamically imported inside the handler via `await import("../db")`

export function registerIframeRoutes(app: express.Express) {
  // 场景体验 iframe 页面（在新标签页中打开，包含 iframe）
  // 应用严格速率限制和输入验证
  app.get("/api/scenarios/iframe/:experienceId", strictLimiter, async (req, res) => {
    try {
      // 检查场景体验功能是否启用
      const { isFeatureEnabled } = await import("../db");
      const isEnabled = await isFeatureEnabled("scenario_experience");
      if (!isEnabled) {
        res.status(403).json({ error: "场景体验功能已关闭" });
        return;
      }

      // 验证用户登录状态（允许未登录用户访问，但需要检查访问次数）
      const context = await createContext({ req, res, info: {} as any });

      // 已登录用户：不受访问限制，直接允许访问
      if (context.user) {
        console.log(`[Iframe] Access allowed - Logged in user (ID: ${context.user.id})`);
        // 继续处理，不检查访问限制
      } else {
        // 未登录用户：检查访问次数限制
        // 使用统一的IP获取函数，确保与记录时使用的IP一致
        const clientIP = getClientIp(req);

        const { getIpAuthAccessCountToday, getSystemConfigNumber } = await import("../db");

        // 获取今日体验按钮点击次数
        const todayCount = await getIpAuthAccessCountToday(clientIP);
        const dailyLimit = await getSystemConfigNumber("unregistered_daily_limit", 10);

        // 调试日志
        console.log(`[Iframe] Access check - IP: ${clientIP}, count: ${todayCount}, limit: ${dailyLimit}`);

        // 检查是否超过限制
        // 如果限制为0，直接拒绝访问
        if (dailyLimit === 0) {
          res.status(403).json({
            error: `今日访问次数已达上限（${dailyLimit}次），请明天再试或注册账号后继续使用`
          });
          return;
        }
        // 注意：如果当前次数等于限制，也应该允许访问
        // 因为这是最后一次允许的访问（点击时已经允许了，记录后变成 limit 次）
        if (todayCount > dailyLimit) {
          res.status(403).json({
            error: `今日访问次数已达上限（${dailyLimit}次），请明天再试或注册账号后继续使用`
          });
          return;
        }
      }

      const { experienceId } = req.params;

      // 从数据库获取配置
      const { getExperienceConfig } = await import("../db");
      const experienceConfig = await getExperienceConfig(experienceId);

      if (!experienceConfig) {
        res.status(404).json({ error: "体验不存在" });
        return;
      }

      if (experienceConfig.status !== "active") {
        res.status(403).json({ error: "该体验正在开发中" });
        return;
      }

      // 测试环境可选：按 experienceId 动态映射到 demo 子域名（不写库）
      // DEMO_HOST_MAP_ENABLED=true
      // DEMO_HOST_MAP=demo-assistant=assistant.demo.example.com,analysis-tool=analysis.demo.example.com
      // DEMO_HOST_MAP_SCHEME=http|https (默认 http)
      let targetUrl = experienceConfig.url;
      const hostMapEnabled = process.env.DEMO_HOST_MAP_ENABLED === "true";
      const hostMapRaw = process.env.DEMO_HOST_MAP || "";
      if (hostMapEnabled && hostMapRaw) {
        const mapping = new Map<string, string>();
        hostMapRaw.split(/[\n,]/g).map(s => s.trim()).filter(Boolean).forEach(pair => {
          const idx = pair.indexOf("=");
          if (idx > 0) {
            const k = pair.slice(0, idx).trim();
            const v = pair.slice(idx + 1).trim();
            if (k && v) mapping.set(k, v);
          }
        });

        const mappedHost = mapping.get(experienceId);
        if (mappedHost) {
          try {
            const original = new URL(experienceConfig.url);
            const scheme = (process.env.DEMO_HOST_MAP_SCHEME || "http").toLowerCase();
            const protocol = scheme === "https" ? "https:" : "http:";
            const mapped = new URL(`${protocol}//${mappedHost}`);
            mapped.pathname = original.pathname || "/";
            mapped.search = original.search || "";
            targetUrl = mapped.toString();
          } catch (e) {
            console.warn(`[ScenarioIframe] DEMO_HOST_MAP parse failed for ${experienceId}:`, e);
          }
        }
      }

      // 获取 session token（从 cookie）
      const { COOKIE_NAME } = await import("@shared/const");
      const { parse: parseCookieHeader } = await import("cookie");

      // 解析 cookie
      const cookieHeader = req.headers.cookie;
      const cookies = cookieHeader ? parseCookieHeader(cookieHeader) : {};
      const sessionToken = cookies[COOKIE_NAME] || null;

      // 准备认证信息（只传递必要的、非敏感信息）
      // 未登录用户时，userId、userName、userEmail 为 null
      const authInfo = {
        sessionToken: sessionToken || null,
        userId: context.user?.id || null,
        userName: context.user?.name || null,
        userEmail: context.user?.email || null,
        timestamp: Date.now(),
      };

      // 获取目标 origin（用于 postMessage 验证）
      const targetUrlObj = new URL(targetUrl);
      const targetOrigin = targetUrlObj.origin;

      // 转义 URL，防止 XSS
      const escapedUrl = targetUrl
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#x27;");

      // 转义 origin，防止 XSS
      const escapedOrigin = targetOrigin
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(/&/g, "\\u0026");

      // 转义认证信息，防止 XSS
      const escapedAuthInfo = JSON.stringify(authInfo)
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(/&/g, "\\u0026");

      // 转义 sessionToken（用于设置 cookie）
      const escapedSessionToken = (sessionToken || "")
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(/&/g, "\\u0026")
        .replace(/"/g, "\\u0022")
        .replace(/'/g, "\\u0027");

      // sandbox 策略（可配置）
      // system_config key: iframe_sandbox_overrides
      // value 示例（JSON）：
      // {
      //   "default": "strict", // strict | relaxed | none
      //   "insurance-advisor": "none",
      //   "finance-skill": "relaxed"
      // }
      const { getSystemConfigValue } = await import("../db");
      const sandboxConfigRaw = await getSystemConfigValue("iframe_sandbox_overrides", "");
      let sandboxMode: "strict" | "relaxed" | "none" = "strict";
      try {
        if (sandboxConfigRaw) {
          const cfg = JSON.parse(sandboxConfigRaw) as Record<string, string>;
          const mode = (cfg[experienceId] || cfg.default || "strict").toLowerCase();
          if (mode === "none" || mode === "relaxed" || mode === "strict") {
            sandboxMode = mode;
          }
        }
      } catch (e) {
        console.warn("[ScenarioIframe] Invalid iframe_sandbox_overrides config:", e);
      }

      const sandboxByMode = {
        strict: 'sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-presentation allow-top-navigation-by-user-activation"',
        relaxed: 'sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-presentation allow-top-navigation allow-top-navigation-by-user-activation allow-navigation"',
        none: "",
      } as const;
      const sandboxAttr = sandboxByMode[sandboxMode];

      // 返回包含 iframe 的 HTML 页面，注入 postMessage 通信代码
      const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>场景体验</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    html, body {
      width: 100%;
      height: 100%;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
    }
    iframe {
      width: 100%;
      height: 100%;
      border: none;
      display: block;
    }
    /* Loading 覆盖层 */
    .loading-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: #ffffff;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 9999;
      transition: opacity 0.3s ease-out;
    }
    .loading-overlay.hidden {
      opacity: 0;
      pointer-events: none;
    }
    .error-overlay {
      position: fixed;
      inset: 0;
      background: rgba(255,255,255,.96);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      padding: 20px;
    }
    .error-card {
      width: min(520px, 92vw);
      border: 1px solid #fecaca;
      background: #fff7f7;
      border-radius: 12px;
      padding: 16px 18px;
      color: #7f1d1d;
      box-shadow: 0 8px 20px rgba(0,0,0,.08);
    }
    .error-title {
      font-size: 16px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .error-text {
      font-size: 13px;
      line-height: 1.6;
      color: #7f1d1d;
      margin-bottom: 12px;
    }
    .error-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .error-btn {
      border: 1px solid #fca5a5;
      background: #fff;
      color: #7f1d1d;
      border-radius: 8px;
      padding: 7px 12px;
      font-size: 12px;
      cursor: pointer;
    }
    .error-btn.primary {
      background: #CF0A2C;
      color: #fff;
      border-color: #CF0A2C;
    }
    /* Loading 动画 */
    .loading-spinner {
      width: 48px;
      height: 48px;
      border: 4px solid #f3f4f6;
      border-top-color: #CF0A2C;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
    .loading-text {
      margin-top: 24px;
      font-size: 16px;
      color: #6b7280;
      font-weight: 500;
    }
    .loading-dots::after {
      content: '.';
      animation: dots 1.5s steps(4, end) infinite;
    }
    @keyframes dots {
      0%, 20% {
        content: '.';
      }
      40% {
        content: '..';
      }
      60% {
        content: '...';
      }
      80%, 100% {
        content: '';
      }
    }
  </style>
</head>
<body>
  <!-- Loading 覆盖层 -->
  <div id="loading-overlay" class="loading-overlay">
    <div class="loading-spinner"></div>
    <div class="loading-text">
      正在加载场景体验<span class="loading-dots">...</span>
    </div>
  </div>

  <iframe id="scenario-iframe" src="${escapedUrl}" allowfullscreen ${sandboxAttr}></iframe>

  <div id="error-overlay" class="error-overlay">
    <div class="error-card">
      <div class="error-title">场景加载失败</div>
      <div id="error-text" class="error-text">可能是目标页面拒绝被 iframe 嵌入，或网络暂时不可用。</div>
      <div class="error-actions">
        <button id="retry-btn" class="error-btn primary">重试加载</button>
        <button id="open-direct-btn" class="error-btn">新标签打开</button>
      </div>
    </div>
  </div>

  <script>
    (function() {
      'use strict';

      // 认证信息（从服务器端注入）
      const authInfo = ${escapedAuthInfo};
      const iframe = document.getElementById('scenario-iframe');
      const loadingOverlay = document.getElementById('loading-overlay');
      const errorOverlay = document.getElementById('error-overlay');
      const errorText = document.getElementById('error-text');
      const retryBtn = document.getElementById('retry-btn');
      const openDirectBtn = document.getElementById('open-direct-btn');
      const targetOrigin = '${escapedOrigin}';
      const directUrl = '${escapedUrl}';

      // 隐藏 loading 的函数
      function hideLoading() {
        if (loadingOverlay) {
          loadingOverlay.classList.add('hidden');
          // 延迟移除元素，等待过渡动画完成
          setTimeout(function() {
            if (loadingOverlay && loadingOverlay.parentNode) {
              loadingOverlay.parentNode.removeChild(loadingOverlay);
            }
          }, 300);
        }
      }

      function showError(message) {
        hideLoading();
        if (errorText) {
          errorText.textContent = message || '场景加载失败，请稍后重试。';
        }
        if (errorOverlay) {
          errorOverlay.style.display = 'flex';
        }
      }

      if (retryBtn) {
        retryBtn.addEventListener('click', function() {
          if (errorOverlay) errorOverlay.style.display = 'none';
          window.location.reload();
        });
      }

      if (openDirectBtn) {
        openDirectBtn.addEventListener('click', function() {
          window.open(directUrl, '_blank', 'noopener,noreferrer');
        });
      }

      // 监听来自 iframe 的 postMessage 请求
      window.addEventListener('message', function(event) {
        // 验证消息来源
        if (event.origin !== targetOrigin) {
          return;
        }

        // 处理认证信息请求
        if (event.data && event.data.type === 'REQUEST_AUTH_INFO') {
          // 发送认证信息给 iframe
          iframe.contentWindow?.postMessage({
            type: 'AUTH_INFO',
            data: authInfo,
            timestamp: Date.now()
          }, targetOrigin);
        }
      });

      // iframe 加载完成后，隐藏 loading 并主动发送认证信息
      iframe.addEventListener('load', function() {
        // 隐藏 loading
        hideLoading();

        // 延迟发送，确保 iframe 内的脚本已准备好
        setTimeout(function() {
          iframe.contentWindow?.postMessage({
            type: 'AUTH_INFO',
            data: authInfo,
            timestamp: Date.now()
          }, targetOrigin);
        }, 500);
      });

      // 监听 iframe 加载错误（CSP 限制等）
      iframe.addEventListener('error', function() {
        console.warn('[Iframe] Failed to load iframe, possibly due to CSP restrictions');
        showError('当前场景无法被嵌入（可能由目标站点 CSP/X-Frame-Options 限制导致）。');
      });

      // 超时保护：如果 30 秒后 iframe 仍未加载完成，隐藏 loading
      setTimeout(function() {
        if (loadingOverlay && !loadingOverlay.classList.contains('hidden')) {
          console.warn('[Iframe] Loading timeout');
          showError('加载超时：目标场景响应较慢或被策略拦截，请重试或改用新标签打开。');
        }
      }, 30000);

      // 定期发送认证信息（用于保持连接，可选）
      // setInterval(function() {
      //   iframe.contentWindow?.postMessage({
      //     type: 'AUTH_INFO',
      //     data: authInfo,
      //     timestamp: Date.now()
      //   }, targetOrigin);
      // }, 30000); // 每30秒发送一次
    })();
  </script>
</body>
</html>`;

      // 设置响应头，允许被嵌入到 iframe 中
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      // 移除 X-Frame-Options，允许页面被嵌入（因为我们自己生成的页面）
      res.removeHeader("X-Frame-Options");
      // 设置 CSP frame-ancestors（收紧为可配置白名单）
      // system_config key: iframe_frame_ancestors
      // value 示例："'self' http://203.0.113.10:9528 https://www.example.com"
      const frameAncestors = await getSystemConfigValue(
        "iframe_frame_ancestors",
        `'self' ${req.protocol}://${req.get("host")}`
      );
      res.setHeader("Content-Security-Policy", `frame-ancestors ${frameAncestors};`);
      res.send(html);
    } catch (error) {
      console.error("[ScenarioIframe] Error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "加载失败" });
      }
    }
  });
}
