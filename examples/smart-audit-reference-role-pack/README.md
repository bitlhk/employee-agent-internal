# 灵感银行 · 智能审核 Reference Role Pack V1

本目录是 `credential-compliance` 岗位的 Reference Role Pack。它组合现有 Role、Knowledge、Skill、MCP、Policy、Governance 和 Eval，不引入第二套运行时配置。

## 当前阶段

当前已完成 Reference Knowledge、受控主 Skill、三项确定性 Policy、六项 Golden Task Eval、Context Evidence、隔离 Demo 人工复核写入和岗位包注册，状态为 `Reference Ready`。外部凭证服务仍处于 Demo/Shadow 边界，因此不能描述为银行生产就绪。

## V1 边界

- 聚焦银行信贷与凭证材料的受理、提取、完整性、相关性、一致性和人工复核；
- 最终通过、拒绝、授信和例外批准必须由有权人员作出；
- 材料内容来自当前任务附件或授权案件系统，不得写入静态 Knowledge；
- 当前有效规则与历史规则必须通过版本和替代关系区分；
- `group-insurance-audit` 是可选行业扩展，不属于银行首版核心 Gate；
- 外部凭证能力未完成可信身份、材料级授权和 SLA 前，只能标记 `Demo/Shadow Ready`。

## 组成

- `knowledge/manifest.json`：十份岗位 Knowledge 及版本治理元数据；
- `knowledge/documents`：员工风格操作指导书、检查表、规则和异常处理指引；
- `skills/smart-audit-assistant`：依赖工作区材料适配器、平台确定性审核 Policy 和隔离演示复核写入的受控主路由；
- `scripts/install-smart-audit-reference-pack.ts`：发布主 Skill，并将旧凭证提示词和团险审核能力调整为按需安装；
- `eval`：六项 Golden Task 的正常、拒绝、降级、来源与确认用例；
- `demo-case`：固定演示案件材料、预期冲突、现行规则和人工复核等级；
- `smart-audit-policy.ts`：材料完整性、现行规则资格和人工复核门禁；
- `demo_create_audit_review_task`：确认后写入隔离演示表的人工复核任务。

企业部署时使用银行自己的制度、材料清单、字段口径和案件系统替换 Reference Asset，不要求重写原文，只需补充岗位、版本、权限和生命周期元数据。

## 固定演示链路

1. 上传 `demo-case` 中五份材料，运行材料分类与完整性检查；
2. 核验 V2.0 现行规则，并明确排除 V1.0 历史规则；
3. 识别账户主体和申请金额冲突，执行 `evaluate_audit_human_review`，结果应为 L4；
4. 只生成复核任务草稿，用户确认后调用 `demo_create_audit_review_task`；
5. 回答必须展示材料引用、规则版本、人工门禁和执行回执，不得形成自动审批结论。

浏览器验收使用：

```bash
SMART_AUDIT_BROWSER_USER_EMAIL=<user> \
SMART_AUDIT_BROWSER_ADOPT_ID=<adopt-id> \
pnpm rolepack:audit:browser-e2e
```
