# 架构概览

岗位智能体平台是面向企业岗位的智能体控制层。平台负责用户、岗位、权限、技能、MCP、频道、协作、审计和文件管理；模型推理与工具执行由运行时承担。

## 核心分层

```text
client/                 React + Vite 前端控制台
server/_core/           Express API、运行时适配、频道、协作、审计
server/routers/         tRPC 管理接口
server/tools/           平台工具和业务 MCP 工具
server/agents/          外部 Agent 定义与适配配置
shared/                 前后端共享类型与品牌配置
drizzle/                数据库 schema 与迁移
```

## 请求路径

```text
浏览器
  -> Workforce Agent Platform API
    -> JiuwenSwarm / OpenClaw / HTTP or A2A Agent
      -> 模型、MCP 工具、文件与任务执行
    <- 流式事件、工具结果、异步 Agent 结果
  <- 会话渲染、任务卡片、频道通知
```

## 运行时

- **JiuwenSwarm**：当前推荐运行时，承载主对话、岗位工具和频道回调。
- **A2A / HTTP Agent**：用于接入外部业务 Agent，例如异步专项任务 Agent。
- **OpenClaw**：兼容旧部署和部分历史运行时能力，新增场景优先走 JiuwenSwarm 或标准 Agent 接口。

## 数据与权限

- 用户、岗位、协作空间、频道绑定、定时任务和审计记录存储在 MySQL。
- 岗位能力通过角色资产授权控制，MCP 服务仍需在服务端做真实用户级数据校验。
- 外部 Agent 任务写入 `agent_tasks`，前端以任务卡片跟踪状态，完成后回写原会话。

## 部署

生产部署通常使用：

```bash
pnpm install --frozen-lockfile
pnpm run build
pm2 start ecosystem.config.cjs
```

详细安装、环境变量和运行时配置见 [README.md](README.md) 与 [docs/DEPLOY.md](docs/DEPLOY.md)。
