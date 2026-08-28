# EA Skill Quality Evaluation Phase 0 / Phase 1

本目录保存 Skill 质量评测 Phase 0 的独立契约与试点资产。它不属于任何已审批 Skill Artifact，也不会改变用户安装、岗位预装或生产 Agent 的活跃版本。

## 当前状态

> Phase 0 Engineering Complete
>
> Phase 1 Diagnostic Runner Complete / Pilot Expert Validation Pending

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

Phase 1 已具备：

- 固定版本 Promptfoo Node Runner；
- 目标版、上一版、无 Skill 三执行臂；
- 每轮独立 Eval Adoption、Session 和 Workspace；
- 不可变 Artifact 装载、运行身份校验和基线污染检查；
- `Snapshot → Trace → Evidence → Report` 完整证据链；
- 确定性断言、Runner 硬门禁、重复运行、时延和 Token 诊断；
- 关闭缓存、结果共享和远程红队生成；
- 模型输出失败时保留原始响应和摘要指纹。

尚未完成：

- Hermes Judge 模型与专家校准集
- 两套 Eval Suite 的专家确认
- 正式分数、等级和市场徽章

因此当前资产只能证明评测契约与版本边界已经建立，不能证明两个 Skill 已通过质量评测。

## 试点

### 财富经理

- 目标：`wealth-manager-assistant@2.0.1`
- 对照：无 Skill、`1.4.0`
- 首批候选案例：5 条
- 执行顺序：先进入离线评测 MVP

### GoldenCoach

- 目标：`goldencoach-stage-evaluation@1.0.1`
- 对照：无 Skill
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
```

Phase 1 运行产物写入被 Git 忽略的
`reports/skill-quality-evaluation/<evaluation-id>/`。每次运行分别保存
`snapshot.json`、`trace.json` 和 `evidence.json`，汇总生成 `report.json` 与
`report.md`。模型输出或基线硬门禁失败属于诊断结果；只有证据未完整生成才标记
`DIAGNOSTIC_INCOMPLETE`。

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
