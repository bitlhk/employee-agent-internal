# 客户经理财富助手

中队专区财富经理岗位主技能。V2 在保留 GRACE 客户画像、现行制度、确定性适当性、确认门禁和 Receipt 治理链的前提下，吸收李文华维护的上游财富技能包中的九类业务场景，并继续以一个稳定技能身份发布。

## 包含场景

- 客户 KYC 画像
- 客户经营日报/周报
- 资产配置诊断
- 单产品深度分析
- 多产品客观对比
- 产品搜索与适当性匹配
- 推荐理由生成
- 推荐话术生成
- 合规风控问答

此外，主技能继续支持到期客户经营，以及经用户确认后创建方案草稿或跟进任务。

## 依赖 MCP

- `wealth_assistant_context_probe`
- `wealth_assistant_customer_list`
- `get_governed_customer_profile`（统一、按岗位用途裁剪的客户画像）
- `wealth_assistant_customer_detail`
- `get_wealth_policy_basis`（获取当前有效制度依据）
- `prepare_wealth_maturity_context`（生成受限、可追溯的到期经营清单）
- `prepare_wealth_allocation_context`（具体客户的正式产品候选必须使用）
- `wealth_assistant_product_search`
- `wealth_assistant_product_info`
- `wealth_assistant_fund_info`
- `wealth_assistant_nav_history`
- `wealth_assistant_wealth_product`
- `wealth_assistant_market_news`

平台侧统一托管 MCP 与 token，Skill 包不包含密钥。

## 上游来源与适配边界

- 上游维护者：李文华
- 上游仓库：`https://gitcode.com/customer_manager_assistant/skills/tree/master/skill`
- 本次接收快照 SHA-256：`793b087bf30ffe67e6b570500ac93f3b7ef7feafe0823cf14dc9c089fcd01b21`
- V2 只吸收技能说明，不包含 MCP 部署包、演示文档、测试脚本、密钥、硬编码地址或 `RenderEchart` 依赖
- 正式客户推荐继续以 `prepare_wealth_allocation_context` 返回的 `eligibleProducts` 为唯一候选集合
