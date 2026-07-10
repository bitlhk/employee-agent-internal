import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig, loadEnv } from "vite";
import { imagetools } from "vite-imagetools";
import { fontDisplayPlugin } from "./vite-font-display-plugin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 创建 HTML 环境变量替换插件
function htmlEnvPlugin(env: Record<string, string>): Plugin {
  return {
    name: "html-env-replace",
    transformIndexHtml(html) {
      // 检查分析服务环境变量是否存在
      const analyticsEndpoint = env.VITE_ANALYTICS_ENDPOINT;
      const analyticsWebsiteId = env.VITE_ANALYTICS_WEBSITE_ID;

      // 如果分析服务未配置，移除整个脚本标签（使用更灵活的正则匹配）
      if (!analyticsEndpoint || !analyticsWebsiteId) {
        html = html.replace(
          /<script[^>]*src="%VITE_ANALYTICS_ENDPOINT%\/umami"[^>]*><\/script>/g,
          ""
        );
      } else {
        // 替换环境变量
        html = html.replace(/%VITE_ANALYTICS_ENDPOINT%/g, analyticsEndpoint);
        html = html.replace(/%VITE_ANALYTICS_WEBSITE_ID%/g, analyticsWebsiteId);
      }

      // 替换其他环境变量
      html = html.replace(/%VITE_(\w+)%/g, (match, key) => {
        const envKey = `VITE_${key}`;
        return env[envKey] || "";
      });

      return html;
    },
  };
}

export default defineConfig(({ mode }) => {
  // 加载环境变量
  const envDir = path.resolve(__dirname, "..");
  const env = loadEnv(mode, envDir, "VITE_");

  // 获取 API URL，优先使用环境变量，否则使用默认后端端口
  const getApiUrl = () => {
    if (env.VITE_API_URL) {
      return env.VITE_API_URL;
    }
    // 默认后端端口 5174
    return "http://localhost:5174";
  };

  const plugins = [
    react(),
    tailwindcss(),
    imagetools({
      defaultDirectives: (url) => {
        // 默认压缩图片，转换为 WebP 格式（如果浏览器支持）
        if (url.searchParams.has("webp")) {
          return new URLSearchParams("format=webp&quality=80");
        }
        // 默认压缩质量
        return new URLSearchParams("quality=80");
      },
    }),
    fontDisplayPlugin(), // 添加字体加载优化
    htmlEnvPlugin(env),
  ];
  return {
    plugins,
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
        "@shared": path.resolve(__dirname, "..", "shared"),
        "@assets": path.resolve(__dirname, "..", "attached_assets"),
      },
    },
    envDir,
    root: __dirname,
    publicDir: path.resolve(__dirname, "public"),
    build: {
      outDir: path.resolve(__dirname, "..", "dist/client"),
      emptyOutDir: true,
      // 使用 terser 进行更激进的压缩（比 esbuild 压缩率更高）
      minify: "terser",
      // terser 压缩选项 - 增强压缩配置
      terserOptions: {
        compress: {
          drop_console: true, // 移除 console
          drop_debugger: true, // 移除 debugger
          pure_funcs: ["console.log", "console.info", "console.debug", "console.trace"], // 移除特定函数调用
          passes: 3, // 增加到3次压缩以获取更好的压缩率
          dead_code: true, // 移除未使用的代码
          unused: true, // 移除未使用的变量
          collapse_vars: true, // 合并变量
          reduce_vars: true, // 减少变量
          inline: 2, // 内联函数（级别2）
          keep_fargs: false, // 移除未使用的函数参数
          keep_fnames: false, // 移除函数名（减小体积）
          keep_classnames: false, // 移除类名（减小体积）
        },
        mangle: {
          toplevel: true, // 混淆顶级作用域的变量名
          properties: false, // 不混淆属性名（避免破坏代码）
        },
        format: {
          comments: false, // 移除注释
          ascii_only: false, // 允许非ASCII字符（中文等）
        },
      },
      rollupOptions: {
        output: {
          // 手动代码分割
          manualChunks: (id) => {
            // node_modules 单独打包
            if (id.includes("node_modules")) {
              // React 相关库
              if (id.includes("react") || id.includes("react-dom")) {
                return "vendor-react";
              }
              // tRPC 相关库
              if (id.includes("@trpc") || id.includes("@tanstack")) {
                return "vendor-trpc";
              }
              // UI 库
              if (id.includes("@radix-ui") || id.includes("lucide-react") || id.includes("framer-motion")) {
                return "vendor-ui";
              }
              // 其他第三方库
              return "vendor-other";
            }
          },
          // 优化 chunk 命名
          chunkFileNames: "assets/[name]-[hash].js",
          entryFileNames: "assets/[name]-[hash].js",
          assetFileNames: (assetInfo) => {
            // 图片资源使用更短的 hash
            if (/\.(png|jpe?g|gif|svg|webp|avif)$/.test(assetInfo.name || "")) {
              return "images/[name]-[hash:8].[ext]";
            }
            return "assets/[name]-[hash].[ext]";
          },
        },
      },
      // 增加 chunk 大小警告限制（因为我们已经做了代码分割）
      chunkSizeWarningLimit: 1000,
      // 启用 CSS 代码分割
      cssCodeSplit: true,
      // 启用 CSS 压缩
      cssMinify: true,
      // 启用 sourcemap（生产环境可以关闭以减小体积）
      sourcemap: false,
      // 优化资源预加载
      modulePreload: {
        polyfill: true,
        resolveDependencies: (filename, deps) => {
          // 只预加载关键资源
          return deps.filter((dep) => {
            // 预加载主要的 JS 和 CSS
            return dep.includes("vendor-react") || 
                   dep.includes("index") ||
                   dep.includes(".css");
          });
        },
      },
    },
    server: {
      host: true,
      port: parseInt(env.VITE_PORT || "5173"),
      strictPort: true, // 端口被占用时直接报错，不自动切换
      allowedHosts: [
        "localhost",
        "127.0.0.1",
      ],
      fs: {
        strict: true,
        deny: ["**/.*"],
      },
      proxy: {
        // 代理 API 请求到后端服务器
        "/api": {
          target: getApiUrl(),
          changeOrigin: true,
          rewrite: (path) => path, // 保持路径不变
        },
      },
    },
  };
});
