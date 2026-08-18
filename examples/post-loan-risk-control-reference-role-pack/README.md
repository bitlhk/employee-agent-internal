# 灵感银行 · 风控经理 Reference Role Pack V1

本目录是 `post-loan-risk-control` 岗位现有 Role、Knowledge、Skill、MCP、Policy、Governance 和 Eval 的参考交付单元，不引入第二套运行时配置。

## V1 边界

- 聚焦企业贷后监测、风险诊断、预警升级、评估报告和复评跟踪。
- 企业、贷款、财务、还款、押品和外部风险事实必须从 `post_loan_risk_data` 动态获取。
- `POST_LOAN_RISK_ESCALATION` 只形成确定性预警和人工升级义务，不替代五级分类、授信审批或资产处置结论。
- 完整评估复用现有 `post-loan-risk-prediction`，本包新增的主 Skill 负责岗位任务路由和边界控制。
- 跟踪任务写入复用隔离的 `wealth_governance_demo`，必须经过确认、幂等和业务回执。
- 演示数据和 Demo 写入只能标记 `Demo/Shadow Ready`。
- V1 确定性分级工具接收由岗位 Skill 汇总的标准化风险信号。进入生产前，必须由 EA 服务端 Context Assembly 将信号绑定到客户范围、MCP 数据时间和上游结果指纹，不能依赖模型自行声明“数据已核验”。
- Policy Decision 只证明确定性规则已经应用；只有实际通过 Knowledge Eligibility 检索的制度文档才能进入 Context Receipt 的 `provided/cited knowledge`。

## 组成

- `knowledge/manifest.json`：九份岗位 Knowledge 及版本治理元数据；
- `skills/post-loan-risk-control-assistant`：六项标杆任务的主路由；
- `eval/rc-gt-01..06-cases.json`：正常、拒绝、降级、来源和确认路径；
- `scripts/install-post-loan-risk-control-reference-pack.ts`：发布 Skill、更新岗位资产基线并刷新实例；
- `scripts/import-demo-knowledge.ts --pack=post-loan-risk-control`：导入、索引和替换旧知识库。

Reference Knowledge 不是银行正式制度。企业部署时应绑定本行制度、作业指引、风险系统和任务系统。
