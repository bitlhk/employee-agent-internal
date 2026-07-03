# 员工智能体部署指南

## 架构概览

```
用户浏览器 → 员工智能体 (:5180) → OpenClaw Gateway (:18789) → LLM
                ↓
            MySQL (本地或远程)
```

员工智能体 = Node.js 应用，主聊天依赖 OpenClaw Gateway。

## 方式一：裸机部署（推荐，适合员工智能体 + OpenClaw 同机）

### 一条命令引导安装

全新 Ubuntu 服务器可以先用 bootstrap 脚本完成依赖安装、代码拉取、`.env` 生成、MySQL 初始化、构建和 PM2 启动：

```bash
curl -fsSL -o /tmp/install-employee-agent.sh \
  https://raw.githubusercontent.com/bitlhk/employee-agent/main/scripts/bootstrap-install.sh
bash /tmp/install-employee-agent.sh --host <服务器IP或域名>
```

默认安装目录是当前用户的 `~/employee-agent`，便于和 OpenClaw / Hermes 一样在普通用户目录下运行。

常用参数：

```bash
bash /tmp/install-employee-agent.sh \
  --dir "$HOME/employee-agent" \
  --port 5180 \
  --host 203.0.113.10 \
  --db-mode mysql-auto
```

`bootstrap-install.sh` 只负责系统环境和仓库拉取；仓库内配置仍由 `setup.sh --auto` 完成。

### 手动裸机部署

这是当前推荐的独立部署方式，尤其适合 `ubuntu` / 普通用户运行：

```bash
git clone https://github.com/bitlhk/employee-agent.git
cd employee-agent
bash setup.sh
pnpm build
pm2 start ecosystem.config.cjs
bash scripts/check-local-openclaw-node.sh
```

说明：
- `ecosystem.config.cjs` 由 `setup.sh` 从 `ecosystem.config.cjs.example` 生成，是本机私有 PM2 配置。
- OpenClaw 默认按当前系统用户查找，例如 `ubuntu` 用户对应 `/home/ubuntu/.openclaw`。
- 如果没有配置 SMTP，`setup.sh` 默认写入 `EMAIL_VERIFICATION_REQUIRED=false`，便于先完成独立部署验证。
- 首个管理员可用脚本创建：

```bash
pnpm tsx scripts/init-admin.ts --email=admin@example.com --password='换成强密码' --name='Admin'
```

## 方式二：Docker Compose（仅适合基础平台/数据库）

```bash
git clone https://github.com/bitlhk/employee-agent.git
cd employee-agent
cp .env.example .env
# 编辑 .env，至少设置 DATABASE_URL 和 JWT_SECRET
./setup.sh
docker-compose up -d
```

这会启动 MySQL + 员工智能体。但默认镜像不包含宿主机 OpenClaw 环境，主聊天如需走本机 OpenClaw，优先使用上面的裸机部署方式。

## 方式三：手动部署

### Step 1: 环境准备

```bash
# Node.js 22+
node --version  # v22.x

# MySQL 8.0+
mysql --version

# pnpm
npm install -g pnpm
```

### Step 2: 安装员工智能体

```bash
git clone https://github.com/bitlhk/employee-agent.git
cd employee-agent
pnpm install
```

### Step 3: 配置

```bash
./setup.sh
# 交互式配置：访问方式、数据库、密钥等
# 会自动生成 .env 并迁移数据库
```

或手动：
```bash
cp .env.example .env
# 编辑 .env，设置所有 [必填] 项
pnpm db:push   # 创建数据库表
```

### Step 4: 启动

```bash
pnpm build
pnpm start
# 或使用 PM2:
pm2 start ecosystem.config.cjs
```

访问 http://localhost:5180 验证。

## OpenClaw 安装与配置

员工智能体的主聊天功能依赖 OpenClaw。不安装 OpenClaw，平台可以启动但主聊天不可用。

### 场景 A: 你已有 OpenClaw

只需修改 3 项配置（编辑 `~/.openclaw/openclaw.json`）：

```jsonc
{
  "gateway": {
    // 1. 认证 token — 必须与员工智能体 .env 的 CLAW_GATEWAY_TOKEN 一致
    "auth": { "token": "你的token" },
    
    // 2. 绑定地址 — 必须是 "lan"，不能是默认的 "loopback"
    "bind": "lan",
    
    // 3. CORS 白名单 — 加入员工智能体的访问地址
    "controlUi": {
      "allowedOrigins": [
        "http://localhost:5180",    // 本机访问
        "http://你的IP:5180",       // 内网访问（如需要）
        "https://你的域名"           // 域名访问（如需要）
      ]
    }
  }
}
```

然后重启 gateway：`openclaw gateway restart`

### OpenClaw 运行时补丁

部分环境对 OpenClaw / Codex runtime 做了下游补丁，当前包括：

- WSS assistant delta 流式输出补丁；
- `openclaw.json` 中配置的 MCP servers 注入 Codex runtime 的补丁。

安装、升级或重建 OpenClaw 前，必须先阅读并核对：

```text
docs/OPENCLAW_RUNTIME_PATCHES.md
```

否则可能出现 WSS 能连接但输出不流式，或 MCP 工具页面可见但 Codex agent 实际不可调用的问题。

### 场景 B: 全新安装

```bash
# 1. 安装
npm install -g openclaw

# 2. 交互式配置（选择 LLM provider，填入 API Key）
openclaw setup

# 3. 同步 OpenClaw gateway 配置
# 如仍需 OpenClaw gateway，请按场景 A 手工修改已有配置。

# 4. 确保 gateway token 与灵虾一致
# 查看员工智能体的 token:
grep CLAW_GATEWAY_TOKEN .env
# 设置到 openclaw.json 的 gateway.auth.token

# 5. 启动
openclaw gateway start
```

### 验证 OpenClaw 连接

```bash
# 检查 gateway 是否在运行
curl http://localhost:18789/health

# 在员工智能体日志中确认连接
pm2 logs employee-agent | grep "WS.*ready"
# 应该看到: [WS] ready: xxx session: xxx
```

## 添加业务 Agent（可选）

员工智能体支持通过 admin 后台添加自定义业务 Agent。每个 Agent 只需要：
- 一个对外暴露 HTTP API 的后端服务
- 在 admin 后台填写：名称、API 地址、认证 token、System Prompt

不需要修改员工智能体代码。

### 支持的 Agent 协议

| 协议 | 适用场景 | API 格式 |
|------|----------|----------|
| OpenClaw | OpenClaw Gateway 托管的 agent | POST /v1/chat/completions |
| Hermes | Hermes Agent Gateway | POST /v1/runs + SSE events |
| 自定义 HTTP | 任何 HTTP 服务 | 自定义 |

### 示例：添加一个 Agent

1. 部署你的 Agent 后端服务（比如一个 Python FastAPI 应用，暴露在 :8080）
2. 登录员工智能体 admin 后台
3. 智能体管理 → 添加
4. 填写：
   - ID: `my-agent`
   - 名称: `我的助手`
   - 类型: `remote`
   - API 地址: `http://127.0.0.1:8080`
   - System Prompt: `你是一个专业的XX助手...`
5. 启用 → 刷新页面 → 在 TaskPanel 中可见

## 访问方式配置

| 场景 | FRONTEND_URL | CORS_ORIGIN | COOKIE_DOMAIN | OpenClaw allowedOrigins |
|------|-------------|-------------|---------------|------------------------|
| 本机 | http://localhost:5180 | http://localhost:5180 | (留空) | ["http://localhost:5180"] |
| 内网 | http://192.168.1.100:5180 | http://192.168.1.100:5180 | (留空) | ["http://192.168.1.100:5180"] |
| 域名 | https://ai.company.com | https://ai.company.com | .company.com | ["https://ai.company.com"] |

## 常见问题

### 主聊天无法连接
- 检查 OpenClaw gateway 是否运行: `openclaw health`
- 检查 CLAW_GATEWAY_TOKEN 是否与 openclaw.json 一致
- 检查 openclaw.json 的 `gateway.bind` 是否为 `"lan"`
- 检查 `controlUi.allowedOrigins` 是否包含员工智能体访问地址

### 注册/登录失败
- 检查 MySQL 是否可达: `mysql -u linggan -p -h localhost linggan`
- 检查 JWT_SECRET 是否设置（不能为空）

### 业务 Agent 不显示
- 检查 business_agents 表是否有数据且 enabled=1
- 检查 Agent 后端服务是否可达
