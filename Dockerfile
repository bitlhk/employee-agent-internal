# ── Stage 1: 构建前端 ──
FROM node:22-alpine AS builder

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.34.4 --activate

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

RUN addgroup -g 1001 -S app && adduser -S app -u 1001
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.34.4 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile && \
    rm -rf /root/.cache /tmp/*

# 复制源码（后端用 tsx 直接跑 TypeScript）
COPY --chown=app:app server ./server
COPY --chown=app:app shared ./shared
COPY --chown=app:app drizzle ./drizzle
COPY --chown=app:app drizzle.config.ts tsconfig.json tsconfig.node.json ./
COPY --chown=app:app LICENSE NOTICE THIRD_PARTY_NOTICES.md ASSET_PROVENANCE.md ./

# 前端构建产物
COPY --from=builder --chown=app:app /app/dist/client ./dist/client

RUN chown -R app:app /app

ENV NODE_ENV=production
ENV PORT=5180
ENV APP_BIND_IP=0.0.0.0
EXPOSE 5180

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5180/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

USER app
CMD ["pnpm", "exec", "tsx", "server/_core/index.ts"]
