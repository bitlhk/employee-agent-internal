# 灵感保险 · 保险顾问 Reference Role Pack V1

本目录是 `insurance-advisor` 岗位现有 Role、Knowledge、Skill、MCP、Governance 和 Eval 资产的参考交付单元，不引入第二套运行时配置。

## V1 边界

- 当前业务样板聚焦车险客户经营、产品讲解、销售沟通和培训陪练。
- 客户与产品事实必须通过 `insurance_customer_profile` 和 `insurance_product_exam_points` MCP 动态获取。
- 八份文档是可替换的 Reference Knowledge，不代替客户企业自己的制度和操作手册。
- 两个 MCP 当前为无鉴权 Mock 服务，只能标记 `Demo/Shadow Ready`。
- `save_product` 保持停用；投保、报价、核保、理赔和投诉结案不在 V1 执行范围内。
- 客户跟进写入复用平台 `wealth_governance_demo` 中的通用 Demo 跟进工具，必须经过操作确认、幂等和业务回执；不连接真实 CRM。
- 生产升级必须完成 JWKS 验签、租户/用户身份校验、客户行级过滤、数据责任人与 SLA 确认。

## 组成

- `knowledge/manifest.json`：八份 Reference Knowledge 及治理元数据。
- `skills/auto-insurance-advisor`：车险岗位任务编排 Skill，复用现有外呼与陪练 Skill。
- `eval/ia-gt-01..06-cases.json`：六项岗位标杆任务的正常、拒绝、降级和来源验收。
- `scripts/install-insurance-advisor-reference-pack.ts`：发布 Skill、更新岗位基线并刷新指定岗位实例。
- `scripts/import-demo-knowledge.ts --pack=insurance-advisor`：导入、索引和授权岗位知识。

## 安装顺序

```bash
pnpm rolepack:insurance:install
pnpm rolepack:insurance:install -- --apply --adopt-id=<lgj-id>
pnpm knowledge:rolepack -- --validate --pack=insurance-advisor
pnpm knowledge:rolepack -- --pack=insurance-advisor --adopt-id=<lgj-id>
pnpm mcp:markers:configure
```

第一条只输出计划；只有带 `--apply` 才会更新技能商店和外部岗位基线。
