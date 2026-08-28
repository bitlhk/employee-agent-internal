# EA Skill Quality Evaluation Phase 0

本目录保存 Skill 质量评测 Phase 0 的独立契约与试点资产。它不属于任何已审批 Skill Artifact，也不会改变用户安装、岗位预装或生产 Agent 的活跃版本。

## 当前状态

> Phase 0 Engineering Complete / Pilot Expert Validation Pending

已冻结并可机器校验：

- `SkillEvalSuiteV1`
- `SkillEvaluationRunSnapshotV1`
- `SkillScorecardProfileV1`
- `JudgeProfileV1`
- 配置指纹与单次运行证据指纹的分离规则
- 财富经理与 GoldenCoach 试点版本清单

尚未完成：

- Promptfoo 和 EA Provider 执行器
- 专用 Eval Adoption / Workspace 的实际运行
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
pnpm skills:quality:phase0:verify
pnpm exec vitest run server/_core/skill-quality-evaluation.test.ts
```

校验会检查：

- 四项契约的 Zod Schema；
- Suite、Scorecard、Judge 和 Pilot Manifest fingerprint；
- Eval Suite 与不可变 Skill Identity / Version / SHA 的绑定；
- 仓库内 Benchmark 和 Golden Task 来源文件的内容摘要；
- Scorecard 指标引用和权重；
- 试点基线与案例声明的一致性；
- Judge 未配置和 Profile 未校准时禁止正式等级的语义。

## 指纹边界

`evaluationConfigFingerprint` 只绑定影响结果的评测条件，相同条件的重复运行必须一致。`runId`、Eval Adoption、Session、Workspace、Trace ID 和时间戳不进入该指纹。

`runEvidenceFingerprint` 绑定单次运行身份、实际 Trace、输出和产物。即使配置相同，不同运行也必须生成不同证据指纹。
