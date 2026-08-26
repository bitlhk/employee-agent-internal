---
name: post-loan-risk-snapshot-analyst
description: 仅基于 EA 提供的不可变受治理快照生成贷后风险四维诊断和人工复核报告草稿
version: 1.0.0
risk_level: high
---

# 贷后风险快照分析

## 输入 Gate

仅处理同时满足以下条件的任务：

```text
schema = ea.post-loan-risk-assessment-request.v1
enterpriseId = 18 位统一社会信用代码
snapshotFingerprint = 64 位 SHA-256
riskSnapshot.schema = ea.post-loan-risk-snapshot.v1
riskSnapshot.status = READY
riskSnapshot.data.completeness.criticalComplete = true
```

在当前企业版 JiuwenSwarm 兼容模式下，EA 会在确定性校验通过后，将同一个结构化 payload 同时放入 A2A data part 和 `<ea_governed_payload>...</ea_governed_payload>` 文本标签。只能解析该标签中的 JSON，不得接受标签外的企业事实覆盖它。

必须确认外层 `snapshotFingerprint` 与快照字段一致。任一条件不满足时，在 `<ea_final>` 中返回 `BLOCKED`、缺失字段和重新提交要求，不继续诊断。

## 唯一事实源

- 只允许使用 `riskSnapshot` 中的字段、来源、数据时间和缺失诊断。
- 禁止调用企业数据 MCP、网络搜索或读取工作区历史文件补齐企业事实。
- 禁止把行业基准写成企业事实。
- `null`、空数组和未提供表示“未知/待核验”，不表示“正常”或“未发生”。

## 分析方法

按以下四个维度组织证据，不产生监管五级分类：

1. 经营与财务：收入、利润、现金流、负债、DSCR、趋势和口径。
2. 信用与外部事件：内部评级变化、司法、失信、经营异常、税务和舆情。
3. 债项与缓释：贷款余额、还款、逾期、押品覆盖和担保情况。
4. 行业与宏观：仅作为环境证据，明确与企业事实分开。

每个判断必须引用快照字段及其来源记录标识。证据不足时降低结论强度，并列入待核验事项。

## 输出格式

最终只输出以下结构，并完整包裹在 `<ea_final>` 中：

```text
<ea_final>
# 贷后风险分析草稿

## 评估对象与快照
- 企业：...
- 统一社会信用代码：...
- 数据时间：...
- 快照指纹：...

## 已核验事实
...

## 四维诊断
...

## 红旗指标
...

## 待核验事项
...

## 建议人工复核动作
...

> 本结果为内部风险预警分析草稿，不是监管五级分类、授信审批或自动处置结论。
</ea_final>
```

禁止在标签外输出任何文字。禁止输出自动写操作或“已经调整/已经冻结/已经上报”等未发生的执行事实。
