# 岗位智能体平台部署指南

## 架构概览

```text
用户浏览器
  -> 岗位智能体平台 Web 服务 (:5180)
  -> JiuwenSwarm / A2A / HTTP Runtime
  -> MySQL
```

平台负责用户、岗位、技能、频道、协作、定时任务、审计和工作区。Agent Runtime 负责模型推理、工具调用和专业任务执行。新环境推荐优先接入 JiuwenSwarm；外部专业 Agent 推荐通过 A2A 或 HTTP adapter 接入。

## 一键部署

推荐系统：Ubuntu 22.04+ / 24.04。

```bash
curl -fsSL https://linggan.top/install.sh | bash
```

默认安装目录是当前用户的 `~/employee-agent`。

常用参数：

```bash
bash /tmp/employee-agent-install.sh \
  --dir "$HOME/employee-agent" \
  --port 5180 \
  --host 203.0.113.10 \
  --mirror auto \
  --db-mode mysql-auto
```

`--mirror auto` 会按网络情况在本次安装进程中选择下载源；可用 `cn` 强制启用国内镜像，或用
`official` 禁用脚本注入的镜像。镜像选择不会改写系统现有的 npm、pip 或 APT 配置文件，也不会覆盖企业自定义私有源。

脚本会自动创建管理员，随机密码保存在安装目录的 `.bootstrap-admin-password`。首次对话前，登录管理后台的
“系统设置”，分别测试并保存 Agent 模型和 EA 平台模型。

## 手动部署

```bash
git clone https://github.com/bitlhk/employee-agent.git
cd employee-agent
bash setup.sh
pnpm build
pm2 start ecosystem.config.cjs
```

如果没有配置 SMTP，`setup.sh` 默认写入 `EMAIL_VERIFICATION_REQUIRED=false`，便于先完成部署验证。

## Docker Compose

Docker Compose 适合快速启动基础平台和数据库：

```bash
git clone https://github.com/bitlhk/employee-agent.git
cd employee-agent
cp .env.example .env
# 编辑 .env，至少设置 DATABASE_URL 和 JWT_SECRET
./setup.sh
docker-compose up -d
```

新安装默认使用 `employee_agent` 数据库和用户。旧版 Docker 部署升级时应保留原 `.env` 中的
`DATABASE_URL`、`MYSQL_DATABASE` 和 `MYSQL_USER`；不要为了匹配新默认值重命名已有数据库。

一键脚本默认使用宿主机进程部署 EA JiuwenSwarm Runtime；外部 A2A / HTTP Runtime 仍需按业务需要单独部署。

## Runtime 接入

### JiuwenSwarm

新环境推荐接入 JiuwenSwarm。平台侧需要能访问 JiuwenSwarm AgentServer，并在角色/技能配置中为岗位实例分配对应 runtime。

常见配置项：

```bash
WORKFORCE_AGENT_INTERNAL_BASE_URL=http://127.0.0.1:5180
```

具体 JiuwenSwarm 运行时配置以实际部署环境为准。

### A2A / HTTP Agent

外部专业 Agent 可以通过 A2A 或 HTTP adapter 接入。适合把耗时、专业、强隔离的业务能力放到独立机器或独立 runtime 中，由岗位智能体平台负责提交任务、跟踪状态和回写结果。

## 环境变量命名

新配置优先使用 `WORKFORCE_AGENT_*`：

```bash
WORKFORCE_AGENT_HOST=203.0.113.10
WORKFORCE_AGENT_PORT=5180
WORKFORCE_AGENT_DB_MODE=mysql-auto
WORKFORCE_AGENT_INTERNAL_BASE_URL=http://127.0.0.1:5180
```

历史 `LINGXIA_*` 变量仍作为兼容 fallback 保留，但新部署不建议继续使用。

## 运维检查

```bash
pm2 status employee-agent
pm2 logs employee-agent
curl http://127.0.0.1:5180/health
curl http://127.0.0.1:5180/api/brand
```

重新构建和重启：

```bash
cd ~/employee-agent
corepack pnpm check
corepack pnpm build
pm2 restart employee-agent
```

## 常见问题

**首页或登录页仍是旧文案**

重新 build 前端并重启服务，同时检查数据库 `system_configs` 中是否存在旧 `brand_*` 覆盖值。

**聊天一直没有响应**

先确认当前岗位实例绑定的 runtime 是否在线，再查看 PM2 日志和对应 runtime 日志。

**飞书或其他频道收不到消息**

进入“频道”页面重新测试绑定状态，并确认平台能访问对应通知服务。
