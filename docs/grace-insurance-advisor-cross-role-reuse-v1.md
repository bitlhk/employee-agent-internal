# GRACE Insurance Advisor Cross-role Reuse V1

## Status

**Gate A Semantic Freeze: Expert Confirmed / Gate B: Core Validation PASS / Environment Dependency Blocked / No Production Promote**

Gate A 冻结保险顾问业务语义；Gate B 已在隔离组织创建 3 个 enterprise-shared Shadow Binding，并验证 Shared Identity、Purpose Isolation、Eligibility 与双岗位 Golden Task。`customer_profile` 尚未被两个岗位真实 Provided，因此未改变保险或财富生产 Runtime。

Gate A 冻结结果：

- Context Need：10/10 expert confirmed；
- Context Golden Case：15/15 expert confirmed；
- Contract fingerprint：`614f23f799bdab24db8bce424e7550d463afdc5e599da6dbe9e297f905964837`；
- `pnpm context:insurance:verify`：PASS；
- `pnpm context:insurance:freeze`：PASS；
- Gate B 环境 Shadow 达到 Shared Binding Identity `3/3`，但 Candidate Provided 仍为 `2/3`，不得描述成 Production Promote 或跨岗位 Runtime 复用通过。

## Baseline facts

- 保险顾问现有契约测试通过：6 个 Golden Task、25 个 Case、84 个断言。
- 保险顾问已冻结 IA-GT-01..06 与 IA-ACT-01 的 `ContextNeedPlanV1`。
- 上海生产当前有 7 个财富经理 Production Binding，没有保险顾问 Production Binding。
- 保险客户与产品 MCP 当前是 Demo/Mock，尚未达到 Enterprise Production Ready。
- `ContextSourceBindingV1` 已增加 `role_pack | enterprise_shared` Scope；Resolver 已实现 exact role Binding 优先、shared fallback，生产数据迁移默认保持 `role_pack`。

机器可读矩阵见 `examples/insurance-advisor-reference-role-pack/context-reuse-matrix.v1.json`。

Gate A 的 proposed 资产包括：

- `context-catalog-extension.v1.json`：4 个专家确认的保险专属 canonical Context；
- `context-needs.json`：IA-GT-01..06 与确认写入子计划 IA-ACT-01；
- `eval/context-golden-set.v1.json`：15 条专家确认的 Context Golden Case。

`IA-ACT-01` 单独表达“确认后创建跟进任务”的条件必需 Context，避免把 `governed_followup_payload` 错设为所有 IA-GT-01 访前请求的静态必需项。

## Static matrix

| Insurance Context Need | Existing canonical ID | Same asset/source now | Same Production Binding now | Decision |
|---|---:|---:|---:|---|
| 客户画像 | `customer_profile` | No | No | Reuse canonical |
| 当前可用产品 | `available_products` | No | No | Reuse canonical |
| 现行客户跟进指引 | `current_followup_guide` | No | No | Reuse canonical |
| 客户关系记忆 | `customer_relationship_memory` | No | No | Reuse canonical |
| 受治理跟进任务载荷 | `governed_followup_payload` | No | No | Reuse canonical |
| 受治理工作状态 | `governed_work_state` | Yes | No | Reuse canonical |
| 现行保险续保访前 SOP | New | No | No | Insurance-specific |
| 现行保险销售制度 | New | No | No | Insurance-specific |
| 保险产品考点 | New | No | No | Insurance-specific |
| 现行保险升级转人工指引 | New | No | No | Insurance-specific |

## Metrics

### Existing Logical Context Reuse Ratio

```text
6 direct canonical reuses / 10 unique Insurance Context Needs = 60%
```

该指标达到冻结目标下限，但只证明语义设计具备复用空间，不证明运行时已经复用。

### Current Production Shared Context Binding Identity Rate

```text
0 fully identical Production Bindings / 3 expert-confirmed identity-eligible shared Contexts = 0%
```

“完全相同”必须同时满足：

1. canonical Logical Context ID 相同；
2. Enterprise Asset 或 Runtime Source Identity 相同；
3. Production Binding ID 相同；
4. Resolver / Eligibility 主链相同。

Runtime Principal 和岗位用途允许不同。仅使用同名 Context、相同 Provider 类型或相同工具名称不能计为 Binding Identity。

3 个 identity-eligible Context 是 `customer_profile`、`customer_relationship_memory` 和 `governed_work_state`。`available_products` 允许岗位/渠道投影使用不同来源，`current_followup_guide` 允许岗位专属资产，`governed_followup_payload` 可能写入不同 CRM 或任务系统，因此三者不强制计入同源 Binding 目标。

## Contract review findings

### 1. Canonical reuse is plausible, but runtime reuse is not implemented

`customer_profile` 和 `available_products` 的定义允许不同岗位按授权范围消费同一种企业事实，但当前财富与保险分别连接不同 Demo 来源。它们可以保留同一个 canonical ID，不能因此声称同 Asset 或同 Binding。

### 2. Insurance-specific knowledge must remain explicit

保险续保访前、保险销售合规、产品考点和核保/理赔升级语义不能通过财富制度 alias 复用。强行合并会提高复用率，但破坏业务语义。

### 3. The frozen Binding Identity target is now expressible in Shadow

共享 Scope 使用具体 Organization、`rolePackId = "*"` 和单一 Binding ID 表达。Resolver 只在岗位精确 Binding 不存在时回退共享层；精确层 disabled、capability mismatch 或 ambiguity 都 fail closed，不得回退。

工程 Shadow 已验证以下选择：

- 3 个共享 Context 的 Binding Identity 为 `3/3`；
- 财富与保险使用不同 Principal、Purpose 和 Eligibility scope fingerprint；
- Work State 在同一共享 Binding 下继续按 Organization、User 和 Adoption 隔离；
- 禁止记录进入 Provided Context 会使 Shadow Gate 失败；
- Shared Promote 必须提供多岗位 Golden Task、Candidate Provided 和 Purpose Isolation 证据。

工程 Fixture 报告指纹由每次执行生成；其 `evidenceMode = engineering_fixture`，不替代真实组织环境 Shadow 记录。

**Recommended decision:** 保持 Binding 仍是薄路由记录，增加受治理的 enterprise-shared scope（例如 `rolePackId = "*"`），由 Resolver 采用“岗位精确 Binding 优先、共享 Binding 回退”的确定性规则；Eligibility 继续依据 Runtime Principal 在 Retrieval 前执行。只有专家确认同源的 3 个 Context 使用共享 Binding，岗位专属产品、动作系统与知识继续保留 role-scoped Binding。该方案需要独立 ADR、Resolver 契约测试和 Shadow Diff，不能随保险 Role Pack 一起隐式上线。

### 4. Existing insurance providers are not production evidence

`insurance_customer_profile` 和 `insurance_product_exam_points` 当前没有生产可信身份、客户行级过滤和真实数据责任登记。本轮只能作为 Role Pack 契约证据，不能作为 Role Scale 生产验证证据。

## Environment Shadow gate

当前隔离环境已证明：

1. 3 个 shared Shadow Binding Candidate 的 Identity 为 `3/3`；
2. 关系记忆和工作状态对两个岗位均真实进入 Provided Context；
3. Purpose Isolation PASS，Cross-role Leakage 为 `0`；
4. Eligibility violation 为 `0`；
5. 财富与保险 Golden Task 全部 PASS；
6. Exact Binding 异常不会回退 Shared Binding。

当前 `customer_profile` 因财富 Customer Provider 上游不可用、保险 Principal 未获正式授权而未进入 Provided Context，两个岗位的 Candidate Provided 均为 `2/3`。稳定阻断证据见 `eval/shared-binding-gate-b-blocked.v1.json`。恢复服务与授权评审必须分开处理；授权状态变化后生成新 Gate validation snapshot，并完整重跑 Gate B。达到 Candidate Provided `3/3` 且通过多岗位 Promote Gate 后，才能升级为 `Insurance Advisor Cross-role Reuse: Validated`。当前状态不允许 Production Promote。
