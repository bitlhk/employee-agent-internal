# 财富经理 Skill 2.1 内部 Pilot 决策 V1

> 状态：Single-adoption Diagnostic Executed / Candidate Rolled Back
>
> 日期：2026-08-29
>
> 候选：`wealth-manager-assistant@2.1.0`

## 决策

当前没有可用的独立人类财富专家。该限制继续阻止正式质量等级、专家认证标识和财富经理岗位默认版本替换，但不阻止非认证的单实例内部 Pilot。

## Pilot 边界

- 仅允许隔离实例或每个环境一个财富经理实例；
- 不修改财富经理岗位默认预装版本；
- 不展示正式评分、等级或“专家认证”标识；
- 必须加载固定的 `2.1.0` 候选摘要，保留 `2.0.2` 评测基线，
  并在实际 Pilot 前备份该实例的当前运行版本作为回滚点；
- Pilot 证据只能表述为 AI 专家盲评和 Judge 留出验证，不得表述为人类专家 Ground Truth。

## 已验证证据

- 候选源码 SHA-256：`d36ac98aa2a137ba1e22dc43b5bb21e519dcfe855193b5bfb207222400c5e59b`；
- 原生 Runtime Smoke：`d8678cd226ec3acaa2b21d5eab19d0e5f62737d4fcbdd4f159303ca96d5fb46a`；
- v3 留出校准结果：`db41ba397073babc07c7960b96f6b995175a9bfc05080371cce4dc5b18659854`；
- AI 专家目标版偏好：`4/4`；
- Judge 与 AI 专家方向一致：`4/4`；
- 换序分歧：`0`。

## 未满足项

- 独立人类财富专家 Ground Truth 不可用；
- 正式评分与等级不可用；
- 全量岗位默认发布未获批准。

## 上海单实例 Pilot 结果

2026-08-29 在 `lgj-lihongkun` 执行了一次可回滚的 `2.1.0`
单实例诊断。这次执行不是岗位默认版本发布。

已证明：

- 企业版原生 `skill_tool` 加载了固定的 `2.1.0` 候选摘要；
- 旧客户编号 `C005` 可由客户画像与持仓两个受治理 Provider
  一致解析为 canonical ID `CUST-000005`；
- 补齐经确认的近期联系摘要后，客户画像、持仓和当前访前制度均进入
  `Provided Context`；
- Doubao Seed 2.1 Pro 与 DeepSeek 两条实际流均正常结束，
  没有绕过授权、产品推荐或写入门禁。

未通过：

- Doubao 将原始客户层级码 `2` 翻译为无来源的“2星”，并将
  `C4` 误写为“进取型”；
- DeepSeek 将 `C4` 扩写为无当前映射证据的“中等偏进取”，并自行设定
  `3%` 回撤情景；
- 上述行为违反“不得编造客户标签、比例或金额”的事实完整性门禁，
  因此不将这次 Pilot 记为 PASS。

处置：

- `lgj-lihongkun` 已回滚到 `wealth-manager-assistant@2.0.1`；
- 该账号的模型偏好已恢复为 `deepseek-v4-flash`；
- `2.1.0` 仍为内部候选，不替换岗位默认版本；
- Runtime 中的旧客户编号安全解析与文件工具降级修复保留，
  它们是独立的平台兼容性修复。

## 环境证据

- 上海 Runtime 版本：`545a3e31f8ea1128e7843cfaee5ffcc97a4e281e`；
- Doubao 客户上下文恢复后的流证据 SHA-256：
  `34663f06839fdc58c6ff5f7bcf97d4f44646a3d6a4756757b5bfba7452958d9f`；
- Doubao 默认模型复验 SHA-256：
  `4bb286acfa31f0fb2044d4fcc2b53540c31db2ed92ce8806b3656c4d2fc53333`；
- DeepSeek 对照流 SHA-256：
  `0ac4b6576284e8eab4f92cc476f84583fdc65eebc0182a3d4667a0c8520a8fdd`；
- 回滚后企业版原生 `2.0.1` 加载证据 SHA-256：
  `5a1a4755449c8f841cd8e7ceb3e9d758d2467eac93c8fd2976bc245a55d0eb49`。
