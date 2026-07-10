# ── Stage 1: 构建前端 ──
FROM node:22-alpine AS builder

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY client ./client
COPY shared ./shared
COPY server ./server
COPY drizzle ./drizzle
COPY vite.config.ts tsconfig.json tsconfig.node.json components.json drizzle.config.ts ./

RUN pnpm run build:client

# ── Stage 2: 生产镜像 ──
FROM node:22-alpine AS production

RUN addgroup -g 1001 -S linggan && adduser -S linggan -u 1001
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile && \
    rm -rf /root/.cache /tmp/*

# 复制源码（后端用 tsx 直接跑 TypeScript）
COPY --chown=linggan:linggan server ./server
COPY --chown=linggan:linggan shared ./shared
COPY --chown=linggan:linggan drizzle ./drizzle
COPY --chown=linggan:linggan drizzle.config.ts tsconfig.json tsconfig.node.json ./
COPY --chown=linggan:linggan LICENSE NOTICE THIRD_PARTY_NOTICES.md ./

# 前端构建产物
COPY --from=builder --chown=linggan:linggan /app/dist/client ./dist/client

RUN chown -R linggan:linggan /app

ENV NODE_ENV=production
ENV PORT=5180
EXPOSE 5180

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5180/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

USER linggan
CMD ["pnpm", "exec", "tsx", "server/_core/index.ts"]
