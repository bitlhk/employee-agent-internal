# 客户经理财富助手

中队专区财富经理岗位主技能，由李文华提供业务能力，平台侧整理为一个统一入口。

## 包含场景

- 客户经营日报/周报
- 资产配置诊断
- 产品搜索与匹配
- 推荐理由生成
- 推荐话术生成
- 合规风控问答

## 依赖 MCP

- `wealth_assistant_context_probe`
- `wealth_assistant_customer_list`
- `wealth_assistant_customer_detail`
- `prepare_wealth_allocation_context`（具体客户的正式产品候选必须使用）
- `wealth_assistant_product_search`
- `wealth_assistant_product_info`
- `wealth_assistant_fund_info`
- `wealth_assistant_nav_history`
- `wealth_assistant_wealth_product`
- `wealth_assistant_market_news`

平台侧统一托管 MCP 与 token，Skill 包不包含密钥。
