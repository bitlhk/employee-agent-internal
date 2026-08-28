# EA Skill Quality Evaluation Phase 0 / Phase 1

本目录保存 Skill 质量评测 Phase 0 的独立契约与试点资产。它不属于任何已审批 Skill Artifact，也不会改变用户安装、岗位预装或生产 Agent 的活跃版本。

## 当前状态

> Phase 0 Engineering Complete
>
> Phase 1A Controlled Harness Complete / Diagnostic Executed
>
> Phase 1B Native Skill + SSE Gates Hardened / Three-arm Read-only Smoke Verified / Full Suite Pending / Pilot Expert Validation Pending

已冻结并可机器校验：

- `SkillEvalSuiteV1`
- `SkillEvaluationRunSnapshotV1`
- `SkillScorecardProfileV1`
- `JudgeProfileV1`
- 递归严格字段校验，未知字段不能被静默裁剪后绕过 fingerprint
- 基线版本身份、SemVer 顺序和 baseline mode 唯一性校验
- Profile 硬门禁目录、Suite 覆盖声明和 assertion/runner 执行来源绑定
- 配置指纹与单次运行证据指纹的分离规则
- 财富经理与 GoldenCoach 试点版本清单及只读 Approved Skill Inventory

Phase 1A 已具备：

- 固定版本 Promptfoo Node Runner；
- 目标版、上一版、无目标 Skill 三执行臂；
- 每轮独立的 Harness Workspace，以及逻辑 Adoption/Session 标识；
- 不可变 Artifact 装载、Harness Artifact Identity 校验和基线污染检查；
- `Snapshot → Trace → Evidence → Report` 完整证据链；
- 确定性断言、Runner 硬门禁、重复运行、时延和 Token 诊断；
- 关闭缓存、结果共享和远程红队生成；
- 成功与失败的原始模型输出、摘要、时延和 Token 证据；
- 实验臂对模型完全盲化，输出必须是唯一 JSON 对象；
- 合成事件明确标记为 `synthetic_fixture`，不再冒充原生工具 Trace；
- 按 assertion 与 `runId + hardGateId` 两种口径分别汇总硬门禁。

Phase 1A 的证据边界：

- `Harness Artifact Identity = VERIFIED` 仅表示临时工作区中的 Artifact SHA 与冻结清单一致；
- `SKILL_RUNTIME_IDENTITY = UNVERIFIED`，因为 Phase 1A 不经过真实 EA 安装、加载和 JiuwenSwarm 执行；
- Phase 1A 报告统一标记为 `superseded_non_certifying`，不得用于正式分数、认证、市场徽章或发布门禁。

Phase 1B 已增加真实 Runtime 接入基础：

- 三个独立 `lgj-eval-*` Adoption 分别承载目标版、无目标 Skill 和上一版；
- Runtime Profile 绑定 Adoption、标准 `jiuwen_${adoptId}` Agent 身份、Role、Skill Version、Artifact SHA 与 `SKILL.md` 摘要，并在运行前及聚合时复算 Profile fingerprint；
- 通过真实 `/api/claw/chat-stream` 执行，并采集原生 SSE Run、工具事件和响应；
- 仅内部密钥且仅 `lgj-eval-*` 可关闭自动 Skill 匹配，普通业务请求不受影响；
- EA 响应头只记录执行前注入身份；原生 Runtime 身份由 `skill_tool` 调用与对应结果机器校验，按名称、版本和入口内容摘要绑定冻结 Artifact；
- 目标版 `2.0.1`、无目标 Skill（实际替代 Skill 为 `privbank-previsit@1.3.0`）、上一版 `1.4.0` 已分别通过只读 Runtime Smoke；
- 每轮必须且只能出现一次 `__stream_end`、不得有流错误，且所有 Tool Call 都必须有对应 Result；
- 三份证据可聚合校验为同一 Profile、同一 Suite、不同 Conversation、三臂原生加载身份均 `VERIFIED`；
- 已更新非认证 Smoke 摘要：`phase1b-runtime-smoke-baseline-v1.json`，聚合指纹为 `043bee99af4fe5b08fb4f5bc538da181b7977c90c65e73097838884484d5d689`；
- 当前只证明读操作 Smoke；完整受控 MCP Fixture、原生确认执行和 45 次 Suite 重跑仍待完成。

尚未完成：

- Hermes Judge 模型与专家校准集
- 两套 Eval Suite 的专家确认
- 原生受控 MCP Fixture 与确认/回写隔离执行
- 同一 Suite 的真实 EA Runtime 三臂重跑
- 正式分数、等级和市场徽章

因此当前资产只能证明评测契约与版本边界已经建立，不能证明两个 Skill 已通过质量评测。

## 试点

### 财富经理

- 目标：`wealth-manager-assistant@2.0.1`
- 对照：无目标 Skill、`1.4.0`
- 首批候选案例：5 条
- 执行顺序：先进入离线评测 MVP

### GoldenCoach

- 目标：`goldencoach-stage-evaluation@1.0.1`
- 对照：无目标 Skill
- 当前案例状态：`proposed`
- 执行顺序：先由销售专家冻结 Ground Truth，再进入运行评测

## 校验

```bash
# 结构与引用校验，允许当前机器未挂载 Skill Store
pnpm skills:quality:phase0:verify

# Phase 0 冻结、CI 和发布环境正式门禁，要求本地 Artifact 全部可复算
pnpm skills:quality:phase0:verify:strict

pnpm exec vitest run server/_core/skill-quality-evaluation.test.ts

# 查看冻结的财富经理三组评测计划，不调用模型
pnpm skills:quality:phase1:plan

# 执行 5 案例 × 3 执行臂 × 3 次的离线诊断
pnpm skills:quality:phase1:wealth

# Phase 1B 全流程固定使用隔离 EA Runtime 地址
export EA_SKILL_EVAL_RUNTIME_BASE_URL=http://127.0.0.1:5199

# 显式创建本地隔离 Eval Adoption（只允许回环 Runtime）
EA_SKILL_EVAL_ALLOW_LOCAL_PROVISION=1 pnpm skills:quality:phase1b:provision -- --apply

# 验证真实 EA Runtime Profile 与安装身份
pnpm skills:quality:phase1b:verify

# 为临时 EA Runtime 生成隔离的 Jiuwen 配置，不修改现有配置
pnpm skills:quality:phase1b:jiuwen-config

# 在独立终端启动隔离 EA Runtime；不会替换现有 5180 服务
pnpm skills:quality:phase1b:runtime

# 启动隔离 AgentServer；命令会在配置加载前安全注入临时环境变量
pnpm skills:quality:phase1b:agentserver

# 通过真实 /api/claw/chat-stream 执行三臂只读 Smoke
pnpm skills:quality:phase1b:smoke

# 环境诊断：只执行指定执行臂；结果不能替代三臂完整 Smoke
pnpm skills:quality:phase1b:smoke -- --smoke-arm=target_skill

# 三个执行臂分别完成后，将三份单臂证据聚合为机器可验证的非认证基线
pnpm skills:quality:phase1b:aggregate -- \
  --report=<target-report.json> \
  --report=<without-target-skill-report.json> \
  --report=<previous-version-report.json>
```

Phase 1A 运行产物写入被 Git 忽略的
`reports/skill-quality-evaluation/<evaluation-id>/`。每次运行分别保存
`snapshot.json`、`trace.json` 和 `evidence.json`，汇总生成 `report.json` 与
`report.md`。模型输出或基线硬门禁失败属于诊断结果；只有证据未完整生成才标记
`DIAGNOSTIC_INCOMPLETE`。

Phase 1B 的独立报告写入
`reports/skill-quality-evaluation-runtime/<timestamp>/`，三臂聚合报告写入同目录下的
`aggregate-<timestamp>/`，均不会覆盖 Phase 1A 报告。当前 Runtime Smoke 仍是
`runtime_integration_non_certifying`，不能生成正式分数或等级。

通用 CI Runner 如果没有挂载只读 Skill Store，只能运行结构校验，不能据此宣告 Phase 0 冻结通过。正式 CI/发布环境必须提供 `SKILL_STORE` 并运行 `verify:strict`；缺少任一 Artifact 时直接失败。

校验会检查：

- 四项契约的 Zod Schema；
- Suite、Scorecard、Judge、Approved Skill Inventory 和 Pilot Manifest fingerprint；
- Eval Suite 与不可变 Skill Identity / Version / SHA 的绑定；
- Inventory 与本机不可变 Artifact 的目录 SHA256 和大小；
- 仓库内 Benchmark 和 Golden Task 来源文件的内容摘要；
- Scorecard 指标引用和权重；
- Profile 硬门禁是否由 Suite 声明，并由具名 assertion 或 Runner Check 覆盖；
- `previous_version` 低于目标版本且身份/SHA 不同、`specified_skill` 不复用目标 Artifact、baseline mode 不重复；
- 试点基线与案例声明的一致性；
- 所有仓库路径均在读取前完成边界校验；
- Judge 未配置和 Profile 未校准时禁止正式等级的语义。

## 指纹边界

`evaluationConfigFingerprint` 绑定影响结果的评测条件，包括案例、执行臂、模型、权限、工具、超时、重试、并发、工具调用上限、Token 预算和网络出口策略。相同条件的重复运行必须一致。重复序号、`runId`、Eval Adoption、Session、Workspace、Trace ID 和时间戳不进入该指纹。

`runEvidenceFingerprint` 绑定单次运行身份、完整规范化 Trace 的 SHA256、Judge 状态、输出和产物。即使配置相同，不同运行也必须生成不同证据指纹。
