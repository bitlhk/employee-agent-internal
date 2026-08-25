---
name: wealth-product-matching
description: >-
  基于受治理客户画像、当前有效制度和确定性适当性 Policy，为指定客户生成正式产品候选。
  仅允许使用 prepare_wealth_allocation_context 返回的 eligibleProducts。
version: 2.0.0
author: 李文华
category: 财富管理
---

# 产品适当性匹配

## 核心门禁

针对具体客户形成正式候选产品时，必须调用 `prepare_wealth_allocation_context`。原始产品搜索、单产品分析和多产品对比只能提供资料，不能替代正式匹配。

## 执行步骤

1. 调 `wealth_assistant_context_probe` 确认当前身份和数据范围。
2. 用户未提供可验证客户时，调 `wealth_assistant_customer_list`，并使用返回的稳定客户标识。
3. 调 `get_governed_customer_profile` 获取当前用途允许的客户画像。
4. 调 `prepare_wealth_allocation_context` 获取当前有效制度下的匹配结果。
5. 只从 `eligibleProducts` 形成候选列表；保留工具返回的适当性依据、数据时间和风险提示。
6. 使用 `excludedProducts` 解释为什么未进入候选，但不得把被排除产品作为替代推荐。
7. 没有合格候选或必需客户事实缺失时，明确返回降级/阻断原因和下一步，不使用模型常识补选产品。

## 输出格式

### 产品候选 | {客户显示名称}

- 客户适当性摘要：仅展示当前任务需要的已授权字段。
- 候选产品：名称、代码、风险等级、匹配依据、流动性/期限注意事项。
- 排除说明：只展示业务可理解的原因，不堆叠内部 Policy Code。
- 风险提示：历史业绩不代表未来表现，候选不构成代客决策。

## 证据边界

Policy Code、Decision ID 和规则版本属于执行证据，应进入 Receipt，不在业务回答中展开。正式推荐理由和推荐话术必须继续基于同一次受治理候选集合，不能绕回原始产品搜索结果。

## 禁止事项

- 不用模型自行实现风险等级匹配规则。
- 不使用固定加权评分替代 `prepare_wealth_allocation_context` 的确定性 Policy。
- 不承诺收益，不暗示保本，不替客户作购买决定。
