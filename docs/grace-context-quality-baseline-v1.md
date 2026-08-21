# GRACE Context Quality Baseline V1

本基线冻结 GRACE Context 的质量语义，不新增 Router、Binding 或权限事实源。

## 当前状态

> **Expert Confirmed**

- 确认时间：2026-08-21T13:39:39+08:00
- 专家标识：WM-EXPERT-01
- 专家角色：财富管理制度专家
- Golden Case：16/16 `expert_confirmed`
- 未决争议：0
- Contract Fingerprint：`a7439134abfea0263864d9f37ffe3f8063892e498b49aa3df5c8e545e607c40a`
- 验证：`pnpm context:quality:verify` PASS
- 冻结门禁：`pnpm context:quality:freeze` PASS

## 两个契约

### Logical Context Catalog V1

Catalog 只定义 Context 的规范名称、类型、业务含义、别名和状态。它不保存 Provider、KB ID、Binding、Owner 或资产版本。

现有生产 ID（例如 `customer_profile`、`current_wealth_policy`）继续作为 canonical ID。点式名称仅作为别名，避免为了命名整齐迁移生产 Binding。

### Context Golden Set V1

Golden Set 将知识专家判断沉淀为可回归案例，覆盖：

- 版本正确性：必须采用现行版本，历史版本不得进入 Context；
- Eligibility：岗位、权限、密级或生命周期不满足时不得访问；
- Context Need：必需事实缺失时 BLOCKED，可选事实缺失时 DEGRADED；
- 检索定位：应命中指定文档、版本、章节、页码或位置。

同一份 Golden Set 分层执行：

```text
retrieval          -> Knowledge evaluator
context_resolution -> Resolver / Eligibility verification
task_runtime       -> Role scenario / Golden Task verification
```

知识专家确认前，案例状态为 `proposed`。审核状态只使用以下流转：

```text
proposed -> expert_reviewing -> expert_confirmed
                         \----> needs_resolution
```

`expert_confirmed` 必须记录确认人、专家角色、确认时间、审核意见和 Ground Truth 版本。确认时只更新 review 信息和必要的业务预期，不把模型建议自动升级为企业事实。

## 验证

```bash
pnpm context:contracts:verify
pnpm rolepack:wealth:contracts
pnpm knowledge:test
```

也可以使用统一入口：

```bash
pnpm context:quality:verify
```

该命令验证工程契约，但允许案例保持 `proposed`。全部案例经专家确认后，使用冻结门禁：

```bash
pnpm context:quality:freeze
```

冻结门禁只在 16 条案例全部为 `expert_confirmed` 且审核字段完整时通过。

知识检索评测新增版本准确率和禁止来源率。外部 Provider 未来必须使用同一套 Golden Set 验证，不能以“已实现 Adapter”代替治理契约认证。
