# 内部命名审计与迁移建议

**日期**: 2026-05-11
**范围**: 岗位智能体平台代码仓内部历史命名审计
**目标**: 在不破坏现有上海/新加坡部署的前提下，逐步把旧 `岗位智能体平台 / Lingxia / LingganClaw / linggan-claw` 产品痕迹收口为当前“岗位智能体平台”定位。

---

## 一、结论摘要

当前可见产品名已经基本切到“岗位智能体平台”，但内部仍保留四类历史命名：

1. **仓库与部署名**: `linggan-claw`, `~/linggan-claw`, PM2 `linggan-claw`。
2. **运行时工作区名**: `workspace-lingganclaw`, `lingganclaw:user:*`。
3. **旧产品名/模块名前缀**: `Lingxia`, `lingxia-*`, `useAgentChat`, `.lingxia-policies.json`。
4. **OpenClaw 运行时语义**: `claw`, `/api/claw/*`, `clawAdoptions`, `adoptId`。

其中 **1 可以随 GitHub 仓库改名同步改**，**2 和 4 需要兼容迁移方案**，**3 可以分批安全改**。

不要一把梭替换 `claw`：很多 `claw` 是 OpenClaw 运行时和协议语义，不等于产品旧名。

---

## 二、审计来源

本次扫描命令覆盖：

```bash
grep -RIn \
  -e 'linggan-claw' \
  -e 'lingganclaw' \
  -e 'LINGGAN_CLAW' \
  -e 'LINGXIA_' \
  -e 'Lingxia' \
  -e 'lingxia' \
  -e '子虾' \
  -e '岗位智能体平台' \
  -e '领养' \
  .
```

排除了 `node_modules`, `dist`, `.git`, `*.log`, `*.bak*`。

粗扫命中约 1800 行，其中大量来自 CSS class、历史 smoke 报告、数据 registry 路径和旧文档。真正需要迁移决策的是下面几类。

---

## 三、A 类：可以较安全清理

这些主要影响可读性或测试命名，通常不影响数据库、运行时目录或外部 API。

### A1. 前端 Hook / 类型命名

示例：

```text
client/src/hooks/useAgentChat.ts
client/src/lib/chat-state-reducer.ts
  AgentChatMessage
  reduceAgentChatState
  useAgentChat
```

建议：

- 新增或重命名为 `useAgentChat`, `AgentChatMessage`, `reduceAgentChatState`。
- 可以先保留 re-export 兼容旧 import，避免一次性改所有页面。
- 风险低，适合作为第一批内部重命名。

### A2. CSS class 前缀

示例：

```text
client/src/index.css
  .lingxia-markdown
  .lingxia-codeblock
  .lingxia-toolcard
  .lingxia-input-wrap
```

建议：

- 不急着大改。
- 如果要改，先新增 `.agent-*` class，与旧 `.lingxia-*` 并存一版。
- 纯替换风险在于 JSX 引用和样式遗漏，建议用视觉回归或 smoke 测试配合。

### A3. 测试目录与测试报告命名

正式单测保留在代码仓，历史 smoke harness 和浏览器验证脚本已移出发布仓，仅在本机外置归档中保留。

### A4. 注释和文档残留

示例：

```text
client/src/lib/openclaw-ws.ts 注释
client/src/data/coopTemplates.ts 注释
shared/types/*.ts 注释
setup.sh 末尾 “岗位智能体平台初始化完成”
```

建议：

- 可以直接改为“岗位智能体平台”。
- 只改注释和输出文案，不改结构名。
- 风险低。

### A5. Financial Harness 本地命名

示例：

```text
tools/financial-harness-executor.py
  Lingxia Financial Harness API
  /home/ubuntu/.lingxia/hermes-runtime-skills
  .lingxia-policies.json
  LINGXIA_FIN_HARNESS_ENDPOINT
```

建议：

- 这是新加坡 Hermes 试验场，不建议马上重命名路径。
- 可以先在文档里把 `Lingxia Financial Harness` 改为 `Financial Agent Harness`。
- 环境变量可新增 `FIN_HARNESS_*`，保留 `LINGXIA_FIN_HARNESS_*` fallback。
- `.lingxia-policies.json` 属于 runtime policy 文件，改名要同步 executor、reconcile、测试脚本，建议单独小 PR。

---

## 四、B 类：仓库改名过渡项

> 2026-05-11 更新：已将文档、package 名、新安装默认目录和新安装 PM2 默认名切到 `employee-agent`；bootstrap 保留 `linggan-claw` 仓库 fallback，并在检测到旧安装目录或旧 PM2 进程时继续兼容升级。GitHub 仓库实体已改名为 `bitlhk/employee-agent`。

这些和仓库实体地址、安装目录、进程名绑定。本阶段采用新默认值 + 旧兼容的方式过渡，避免 README、脚本、remote、PM2 和现有机器不一致。

### B1. 仓库与安装目录

示例：

```text
https://github.com/bitlhk/linggan-claw.git
https://raw.githubusercontent.com/bitlhk/linggan-claw/main/scripts/bootstrap-install.sh
~/linggan-claw
package.json name: linggan-claw
```

建议：

- 等 GitHub 仓库从 `linggan-claw` 改为新名后统一替换。
- 推荐候选名：`linggan-agent` 或 `employee-agent`。
- 改完后更新两台服务器 remote：

```bash
git remote set-url origin https://github.com/bitlhk/<new-repo>.git
```

### B2. PM2 进程名和日志名

示例：

```text
ecosystem.config.cjs: PM2_APP_NAME || "linggan-claw"
pm2 logs linggan-claw
/root/.pm2/logs/linggan-claw-*.log
```

建议：

- 仓库改名后，默认 PM2 名可改为 `<new-repo>` 或 `employee-agent`。
- 现有生产进程可继续用旧名，避免监控和操作脚本断裂。
- 新安装机器使用新默认名。

### B3. 同步脚本

示例：

```text
scripts/sync-github.sh
  /home/ubuntu/linggan-claw-oss
  https://github.com/bitlhk/linggan-claw
```

建议：

- 随仓库改名同步更新。
- 同时检查新加坡 mirror 目录是否需要从 `linggan-claw` 迁到新目录。

---

## 五、C 类：需要兼容迁移方案

这些已经进入数据库、运行时工作区、文件路径、API 或会话 key。不能直接改名。

### C1. OpenClaw 工作区目录

示例：

```text
/root/.openclaw/workspace-lingganclaw/<runtimeAgentId>/skills
server/_core/memory-store.ts
server/_core/skills/skill-onboarding.ts
data/skill-registry.json
```

风险：

- 技能 registry 中已经记录了 `sourcePath/runtimePath`。
- 用户已有工作区、记忆、技能、文件都可能在该目录下。
- 直接改会导致技能丢失、工作空间空白、记忆读取失败。

建议迁移策略：

1. 新增配置 `EMPLOYEE_AGENT_WORKSPACE_BASE`，默认仍指向旧 `workspace-lingganclaw`。
2. 新环境默认用新路径，例如 `workspace-employee-agent`。
3. 旧环境读取时同时支持旧路径和新路径。
4. 提供一次性迁移脚本：复制或软链旧目录到新目录，更新 registry 路径。
5. 验证技能列表、工作空间、记忆、定时任务全部正常后再切默认。

### C2. 数据库表和领域模型

示例：

```text
claw_adoptions
claw_profile_settings
clawAdoptions
adoptId
adoption
```

风险：

- `adoptId` 是大量 API、表字段、前端路由、技能、定时、协作、文件接口的核心参数。
- `claw_adoptions` 已有迁移脚本和线上数据。
- 一次改成 `agent_instances` / `agentId` 会是大工程。

建议：

- 短期不要改 DB 表名和字段名。
- 在新代码层增加语义别名，例如 `employeeAgentId` 仅作为前端/服务层变量，落库仍映射到 `adoptId`。
- 长期如果要改：新增表或视图、双写、回填、切读、停旧字段，分 4-5 个版本迁移。

### C3. API 路径

示例：

```text
/api/claw/ws
/api/claw/skills
/api/claw/cron
/api/claw/files
/api/claw/business-chat-stream
```

风险：

- 前端、smoke、第三方脚本、渠道回调都依赖这些路径。
- `claw` 这里一部分是 OpenClaw runtime 语义，不完全是产品旧名。

建议：

- 先保留 `/api/claw/*`。
- 如果要对外更中性，可以新增 `/api/agent/*` 作为 alias，内部仍转发到现有 handler。
- 等前端和脚本全部切到 `/api/agent/*` 后，再考虑 deprecate 旧路径。

### C4. 会话 key 与缓存 key

示例：

```text
lingganclaw:user:${userId}:adopt:${adoptId}
agent:{runtimeAgentId}:{channel}:{conversationId}
```

建议：

- 新的 `agent:{runtimeAgentId}:{channel}:{conversationId}` 是正确方向，继续使用。
- 旧 `lingganclaw:user:*` key 如果还在用，先新增读取兼容，不直接删除。
- 缓存类 key 可设置 TTL 后自然淘汰；持久类 key 需要迁移脚本。

### C5. 环境变量

示例：

```text
LINGXIA_PORT / LINGXIA_HOST / LINGXIA_DB_MODE
LINGXIA_INTERNAL_BASE_URL
LINGGAN_CLAW_BASE_DOMAIN
LINGGAN_CLAW_ENTRY_SCHEME
CLAW_PROVISION_MODE / CLAW_CHAT_MODE / CLAW_GATEWAY_TOKEN
```

建议：

- `CLAW_*` 如果表达 OpenClaw runtime，保留。
- `LINGXIA_*` 和 `LINGGAN_CLAW_*` 可新增 `EMPLOYEE_AGENT_*` 或 `AGENT_PLATFORM_*` 等新变量名。
- 实现顺序：读取新变量，fallback 到旧变量；文档只写新变量；两个版本后再移除旧变量。

---

## 六、D 类：应当保留的 OpenClaw 语义

不是所有 `claw` 都应该改。下面这类建议保留：

```text
OpenClaw runtime adapter
x-openclaw-* headers
openclaw.json
check-local-openclaw-node.sh
OpenClaw gateway / workspace / model
```

原因：

- 这些指向底层 OpenClaw 产品或协议，是技术事实。
- 岗位智能体平台可以支持 OpenClaw，也可以支持 Hermes、MCP、A2A；保留 OpenClaw 命名有助于区分 runtime。

建议只改“产品层旧名”，不要把 runtime 供应商名也抹掉。

---

## 七、建议迁移顺序

### 阶段 1：安全清理

目标：不碰数据库、不碰路径、不碰 API。

- `useAgentChat` 增加 `useAgentChat` alias。
- `AgentChatMessage` 增加 `AgentChatMessage` alias。
- 注释、README、测试标题里的 Lingxia 改为 Workforce Agent Platform / 岗位智能体平台。
- setup 输出末尾残留“岗位智能体平台初始化完成”改为“岗位智能体平台初始化完成”。
- Financial Harness 文案从 `Lingxia Financial Harness` 改为 `Financial Agent Harness`。

### 阶段 2：仓库改名同步

目标：GitHub 仓库、安装目录、PM2 默认名、文档命令一致。

- 改 GitHub 仓库名。
- 改 bootstrap 默认 repo URL。
- 改 README / HELP 安装命令。
- 改 `package.json name`。
- 新安装默认目录从 `~/linggan-claw` 改到新目录。
- 保留旧目录升级说明。

### 阶段 3：API alias

目标：对外新路径更中性，但旧路径不立刻断。

- 新增 `/api/agent/*` alias。
- 前端逐步改用 `/api/agent/*`。
- smoke 覆盖新旧路径。
- 旧 `/api/claw/*` 标记 deprecated。

### 阶段 4：运行时路径迁移

目标：新环境用新 workspace，旧环境可迁移。

- 新增 `EMPLOYEE_AGENT_WORKSPACE_BASE`。
- 工作区读取支持旧/新双路径。
- skill registry 增加路径 reconcile。
- 提供 dry-run 迁移脚本。
- 跑 smoke 验证技能、文件、记忆、定时任务。

### 阶段 5：数据库领域模型迁移

目标：只有在产品稳定后再考虑。

- 保留 `claw_adoptions` 表，先在代码层增加 `employeeAgent` 语义封装。
- 如果必须改表名，采用新增表 + 双写 + 回填 + 切读 + 删除旧字段的方式。
- 这不是近期优先事项。

---

## 八、当前推荐动作

下一步建议只做阶段 1：

1. 改注释和脚本文案残留。
2. 新增 `useAgentChat` / `AgentChatMessage` alias，不强制大规模 rename。
3. Financial Harness 文案去 `Lingxia`，但路径和 env 先兼容。
4. smoke harness 已移出发布仓；正式回归以 `pnpm test` 和核心构建检查为准。

暂时不要动：

- `workspace-lingganclaw`
- `claw_adoptions`
- `adoptId`
- `/api/claw/*`
- `LINGXIA_*` env
- `linggan-claw` repo/install/PM2 名

这些等仓库改名和迁移方案成熟后再做。
