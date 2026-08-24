# ADR: Enterprise-shared ContextSourceBinding Scope V1

## Status

**Approved for Shadow Implementation / Expert Semantic Gate Complete**

本 ADR 不修改生产 Runtime。实现必须独立提交、Shadow 验证并经过受影响岗位 Golden Task Gate。

## Context

Insurance Context Contract V1 已由业务专家确认：

- 10 个唯一 Context Need；
- 6 个复用现有 canonical Context；
- 4 个保险专属 Context；
- 3 个 Context 应共享物理 Binding：`customer_profile`、`customer_relationship_memory`、`governed_work_state`。

当前 `ContextSourceBindingV1`、数据库唯一键和 Resolver 都按 `rolePackId` 严格隔离，因此 Logical Context 可以复用，但同一 Production Binding 不能服务多个 Role Pack。当前 Shared Binding Identity Rate 为 `0/3`。

语义复用率与物理 Binding 复用率不要求相等。`available_products`、`current_followup_guide` 和 `governed_followup_payload` 已确认只复用 Context Contract，不强制共享物理来源。

## Decision

为 Binding 增加明确 Scope：

```text
role_pack
enterprise_shared
```

兼容表达：

```text
bindingScope = role_pack
rolePackId   = linggan-bank.wealth-manager

bindingScope = enterprise_shared
rolePackId   = *
organizationId 必须是具体组织，不能是 *
```

`rolePackId = "*"` 只作为 shared scope 的持久化占位；业务代码必须同时校验 `bindingScope`，不能仅凭星号推断 Scope。既有记录迁移时默认 `bindingScope = role_pack`，行为不变。

Binding 继续只回答“从哪里取得”。不得增加 `allowedRoles`、密级、Owner、Asset Lifecycle 或权限规则。

## Deterministic resolution

对同一 Organization、Logical Context、Context Type 和 Stage：

```text
1. 查找当前 Role Pack 的精确 Binding
2. 精确 Binding 不存在时，查找 enterprise_shared Binding
3. 都不存在时，`NO_BINDING`；共享层已启用但当前 Need 无共享映射时为 `NO_SHARED_BINDING`
```

精确层多个可用 Binding 返回 `AMBIGUOUS_BINDING`，共享层多个可用 Binding 返回 `AMBIGUOUS_SHARED_BINDING`。本 ADR 不引入 Source Selection Policy。

### Explicit override behavior

只要存在当前 Role Pack 的精确 Binding 记录，该层就遮蔽 shared fallback：

- 精确 Binding active：使用精确 Binding；
- 精确 Binding disabled：返回 `EXACT_BINDING_DISABLED`；
- 精确 Binding capability mismatch：返回 `EXACT_BINDING_CAPABILITY_MISMATCH`；
- 精确 Binding ambiguous：返回 `AMBIGUOUS_BINDING`。

显式禁用或错误配置不得静默回退到 shared Binding，否则会绕过岗位级运维和安全意图。

## Eligibility order

Shared Binding 不改变现有安全顺序：

```text
Context Need
  -> exact/shared Binding resolution
  -> Runtime Principal + Role + Organization + Purpose
  -> Asset/Data Eligibility
  -> eligibleDocumentIds / eligible data scope
  -> Provider Retrieval
```

Shared Binding 只表示 Source Identity 相同，不表示返回数据相同。Provider 必须接收受信 Runtime Principal 或 Eligibility push-down 结果。

## Memory and work-state isolation

`customer_relationship_memory` 和 `governed_work_state` 即使共享 Binding，也必须使用：

```text
organizationId
principalId
roleTemplate
purpose
subject/customer
status/lifecycle
```

约束：

- 私人备注不得因客户相同跨岗位开放；
- 未确认内容不得进入正式 Memory；
- 已关闭事项不得作为 active work 返回；
- 不允许通过空 Purpose 扩大查询范围；
- DENY 不泄露受限记录是否存在。

## Receipt semantics

Context Receipt 对 shared Context 必须记录：

- 相同 `bindingId`、`bindingVersion` 和 Binding Snapshot fingerprint；
- `bindingScope = enterprise_shared`；
- 当前 Role Pack 与 Purpose；
- Eligibility 结果或范围 fingerprint；
- Retrieved / Provided / Cited 继续分离。

Principal 明文或敏感过滤条件不进入面向员工的 Receipt；审计层只保存受控 fingerprint 和必要事实。

## Promotion safety

Shared Binding 的变更影响多个岗位。Promotion Gate 必须：

1. 从 Logical Context Catalog 和 Role Context Need 找出全部消费者；
2. 对每个受影响 Role Pack 运行对应 Golden Task / Golden Set；
3. 验证每个候选任务实际 Provided 了候选 Binding Context；
4. 全部 PASS 后，在同一事务内创建 shared Production Binding，并移除受影响岗位同 Context 的精确 Production 映射；
5. 任一岗位失败则不允许发布。

单一岗位 PASS 不足以 Promote enterprise-shared Binding。
被移除的精确映射必须保存在不可变 Promotion Snapshot 中；Rollback 删除 shared 映射并原子恢复原精确映射。仅新增 shared 映射而保留精确映射不算 Promote 成功，因为 Resolver 会继续选择精确层。

## Shadow rollout

首轮只验证专家确认的 3 个共享 Context：

```text
customer_profile
customer_relationship_memory
governed_work_state
```

Shadow 必须记录：

- exact/shared 选择结果；
- canonical ID、bindingId、provider/resource fingerprint；
- 财富经理与保险顾问的 Principal / Purpose 差异；
- Eligible 范围 fingerprint；
- Required/Optional 状态和 reason code；
- Resolver P95；
- Shared Binding Identity Rate。

目标：应共享的 3 个 Context 达到 `3/3 = 100%` Binding Identity，同时 Eligibility violation 为 0。

## Rejected alternatives

### Duplicate role-scoped bindings pointing to the same Source

拒绝。Binding ID 不同，生命周期和 Promotion 可能漂移，只能证明 ResourceRef 相似，不能证明同一受治理 Binding。

### Put allowed roles into Shared Binding

拒绝。会把 Binding 变成第二套权限事实源。Role、Purpose、Classification 和数据范围继续由 Eligibility 管理。

### Reclassify Source Projection Identity as Binding Identity

拒绝。可以作为诊断指标，但不能替代已冻结的 Shared Binding Identity 口径。

### LLM selects shared or role-specific Source

拒绝。选择顺序必须确定性、可测试、可审计。

## Implementation gate

进入代码实现前必须完成：

1. ADR 审核通过；
2. `bindingScope` 兼容迁移设计确认；
3. Resolver exact-over-shared 契约测试设计确认；
4. disabled/capability mismatch 不回退测试确认；
5. Memory Purpose Isolation 测试矩阵确认；
6. Shared Binding 多岗位 Promotion Gate 影响分析确认。

实现后先标记 `Engineering Complete / Shadow Pending`。只有 Shadow Diff、保险 Golden Set、财富 Golden Task 和 Receipt 全部通过，才能标记 `Insurance Advisor Cross-role Reuse: Validated`。
