# 岗位智能体平台 / Workforce Agent Platform

面向企业岗位的智能体平台，为不同岗位配置模型、工具、频道、协作和外部 Agent 能力。

<p align="center">
  <img src="client/public/images/workforce-agent.svg" width="120" alt="岗位智能体平台 Logo" />
</p>

## 适合做什么

- 给每个岗位或员工申请一个隔离的智能体实例，用于日常对话、资料处理、文件生成和任务执行。
- 统一接入 JiuwenSwarm、A2A 或自定义 HTTP Agent，前端和管理后台不需要随运行时重写。
- 把企业内部工具、MCP 服务、专业技能、岗位权限和审计记录接入一个可管理的平台。
- 做企业岗位助手、金融投研工具、客户经理助手、办公自动化和团队协作类原型。

推荐默认部署形态：

```text
浏览器 / iOS 壳
  -> 岗位智能体平台 Web 服务 (React + Node.js)
  -> JiuwenSwarm / A2A / HTTP Runtime Adapter
  -> 本机 workspace / sandbox / tools
  -> MySQL
```

## 核心亮点

**按岗位配置智能体**

每个岗位或用户可以申请自己的智能体实例。实例有独立身份、工作区、技能配置、工具权限和会话历史，适合企业内按岗位、人员或团队逐步放开。

**多 Agent Runtime 接入**

平台支持 JiuwenSwarm、A2A 和自定义 HTTP runtime。平台侧负责用户、岗位、技能市场、MCP 授权、审计和协作；运行时侧负责模型推理、工具调用和文件执行。当前企业岗位智能体推荐优先使用 JiuwenSwarm，外部专业 Agent 推荐通过 A2A/HTTP 接入。

**更顺滑的主对话体验**

主对话已做流式稳定性和前端渲染优化：流式 watchdog、断线兜底、流结束历史对账、稳定 React key、passive scroll、tab 保活、输入法防误发、图片粘贴压缩、Markdown 链接和图片安全过滤。

**工具和技能可治理**

支持技能市场、私有技能、平台工具和 MCP 工具展示。工具能力可以逐步按岗位、用户或智能体授权，并同步到不同 runtime 的注册和 allowlist，适合企业从“先跑通能力”过渡到“可审计、可管控”。

**协作和办公工作区**

内置协作任务、办公空间、文件上传、历史会话、定时任务和渠道通知。前端不只是聊天框，也能承载任务工作台和团队协作工作流。

**管理和审计**

提供 `/admin` 管理入口，用于用户、智能体、技能、工具、系统状态和审计类能力的管理。适合在企业环境中做权限分配、问题排查和使用情况追踪。

## 页面入口

```text
/              -> 首页：登录、申请岗位智能体、进入工作台
/claw/:adoptId -> 岗位智能体工作台：对话、技能、频道、记忆、协作、工作区、定时任务
/admin         -> 管理后台：智能体、组织协作、技能市场、系统设置、审计和统计
/login         -> 登录 / 注册
```

## 技术栈

| 层级 | 技术 |
|---|---|
| 前端 | React 19, Vite, TailwindCSS 4, Radix UI, tRPC |
| 后端 | Node.js 22, Express, tRPC, tsx |
| 数据库 | MySQL 8.0, Drizzle ORM |
| 运行时 | JiuwenSwarm；A2A；HTTP Adapter 可选 |
| 进程管理 | PM2 |

## 快速部署

推荐系统：Ubuntu 22.04+ / 24.04。

先准备至少一个 Agent Runtime。推荐准备 JiuwenSwarm；外部专业 Agent 可通过 A2A/HTTP 接入。然后执行：

```bash
curl -fsSL https://raw.githubusercontent.com/bitlhk/employee-agent/main/scripts/bootstrap-install.sh | bash
```

脚本会自动完成：

- 安装 Node.js 22、pnpm、PM2、MySQL 依赖
- 拉取 `bitlhk/employee-agent`
- 生成 `.env`
- 初始化数据库配置
- 执行 `setup.sh --auto --yes`
- 执行 `pnpm check` 和 `pnpm build`
- 用 PM2 启动 `employee-agent`

安装完成后，初始化管理员：

```bash
cd ~/employee-agent
corepack pnpm tsx scripts/init-admin.ts \
  --email=admin@example.com \
  --password='换成强密码' \
  --name='Admin'
```

然后打开：

```text
http://服务器IP:5180
```

## 可审计安装

如果希望先下载脚本再检查：

```bash
curl -fsSL -o /tmp/bootstrap-install.sh \
  https://raw.githubusercontent.com/bitlhk/employee-agent/main/scripts/bootstrap-install.sh

bash /tmp/bootstrap-install.sh --host 你的服务器IP
```

常用参数：

```bash
bash /tmp/bootstrap-install.sh \
  --repo https://github.com/bitlhk/employee-agent.git \
  --branch main \
  --dir "$HOME/employee-agent" \
  --host your-server-ip \
  --port 5180
```

| 参数 | 说明 |
|---|---|
| `--repo <url>` | Git 仓库地址，默认 GitHub main 仓库 |
| `--branch <name>` | 分支，默认 `main` |
| `--dir <path>` | 安装目录，默认 `$HOME/employee-agent` |
| `--port <port>` | 服务端口，默认 `5180` |
| `--host <ip-or-host>` | 用于生成 `FRONTEND_URL`，不传则自动探测 |
| `--db-mode <mode>` | `mysql-auto` / `existing` / `compose`，默认 `mysql-auto` |
| `--skip-mysql` | 不安装 MySQL，适合使用外部数据库 |
| `--skip-start` | 只拉代码和初始化，不构建/启动 |
| `--overwrite-env` | 已存在 `.env` 时强制重建 |
| `--dry-run` | 只打印将执行的动作 |

## 许可证

[MIT](LICENSE)
