# 财富经理 Skill 2.1 内部 Pilot 决策 V1

> 状态：Approved for Single-adoption Internal Pilot
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
- 必须加载固定的 `2.1.0` 候选摘要并保留 `2.0.2` 回滚点；
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
