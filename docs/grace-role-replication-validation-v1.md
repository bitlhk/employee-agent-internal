# GRACE Role Replication Validation V1

## 1. 目标

本验收证明 GRACE 不是财富经理单岗位实现，而是可以用同一套运行契约交付不同企业岗位的生产与治理平台。

本轮只复用现有 Role、Knowledge、Skill、MCP、Policy、Evidence 和 Eval 资产，不增加第二套岗位运行时配置源。

## 2. 验收基线

| 验收项 | 财富经理 | 保险顾问 | 风控经理 | 判定 |
|---|---|---|---|---|
| Reference Role Pack | `linggan-bank.wealth-manager` | `linggan-insurance.insurance-advisor` | `linggan-bank.post-loan-risk-control` | PASS |
| Golden Task Contract | 6 个任务、24 个用例 | 6 个任务、25 个用例 | 6 个任务、24 个用例 | PASS |
| Controlled Scenario | 14 个确定性场景 | 6 个确定性场景 | 6 个确定性场景 | PASS |
| Context Receipt | 财富知识、客户、产品、记忆 | 保险客户、产品、培训考点 | 企业、贷款、风险数据 | PASS |
| Response Evidence | 服务端 Citation Finalization | 同一实现 | 同一实现 | PASS |
| Business Receipt | Demo 跟进写入 | 复用同一 Demo 跟进写入 | 复用同一 Demo 跟进写入 | PASS |
| Task Receipt Bundle | 服务端生成阶段顺序 | 同一实现 | 同一实现 | PASS |
| UI | 通用 `ContextReceiptPanel` | 不增加保险分支 | 不增加风控分支 | PASS |
| Governance Contract | 通用 Principal、Readiness、PEP、Approval、Idempotency | 同一实现 | 同一实现 | PASS |

执行验收：

```bash
pnpm rolepack:wealth:contracts
pnpm rolepack:wealth:scenarios
pnpm rolepack:insurance:contracts
pnpm rolepack:insurance:scenarios
pnpm rolepack:risk:contracts
pnpm rolepack:risk:scenarios
pnpm rolepack:replication:validate
```

`rolepack:replication:validate` 同时检查共享 Evidence、UI 和 Governance 文件不得出现 `WM-GT-*`、`IA-GT-*`、`RC-GT-*` 或岗位名。岗位任务标签、Outcome 文案和能力映射只能位于岗位资产或业务适配器。

## 3. 共用运行链

```text
Runtime Principal
  -> Role Asset Scope
  -> Knowledge / Business Data / Memory
  -> Skill / Agent Runtime
  -> Capability Intent
  -> Governance Decision + PEP
  -> Capability Execution
  -> Context Receipt / Response Evidence / Business Receipt
  -> Server TaskReceiptBundle
  -> Shared UI
```

平台只信任带 `_meta.eaMetadataIssuer = employee-agent` 的证据元数据。远端 Custom MCP 或 Enterprise MCP 返回的同名字段会先被删除，不能伪造 Context Receipt。

模型可见 `content` 只保留业务推理所需信息；Receipt、Bundle 和 Interaction Grant 只走平台 `_meta` 或服务端事件通道。

## 4. 岗位差异放置规则

允许岗位特化的位置：

- Reference Knowledge 与治理元数据；
- Skill、Golden Task 和 Eval；
- MCP / Capability 绑定；
- 岗位任务证据 Profile，包括任务 ID、业务标签和结果文案；
- 确定性业务 Policy Adapter。

禁止岗位特化的位置：

- `ContextReceiptV1`、`ResponseEvidenceV1`、`TaskReceiptBundleV1`；
- Receipt 签发和信任判断；
- Enterprise MCP Gateway 的 PEP、Approval、Idempotency 和 Audit 主链；
- `ContextReceiptPanel` 与历史消息解析；
- Runtime Principal 和通用 Readiness 计算。

## 5. 两个 Reference Role Pack

### 财富经理

目录：`examples/wealth-manager-reference-role-pack`

闭环覆盖客户访前、资产配置、现行政策、风险错配、客户跟进写入和到期经营。客户与产品动态事实通过 MCP 获取，写入必须经过确认和幂等保护。

### 保险顾问

目录：`examples/insurance-advisor-reference-role-pack`

闭环覆盖续保访前、保障缺口与产品匹配、产品解释、异议处理、销售陪练和合规转人工。客户、产品与培训考点通过保险 MCP 获取；跟进写入复用平台隔离 Demo 能力。

保险客户与产品 MCP 当前仍是无鉴权 Mock 服务，只能标记为 `Demo/Shadow Ready`。本轮 PASS 证明岗位复制和治理接线成立，不代表该远端服务达到生产数据接入标准。升级 `Production Ready` 前仍需 JWKS 验签、用户/租户隔离和客户行级过滤。

### 风控经理

目录：`examples/post-loan-risk-control-reference-role-pack`

闭环覆盖企业贷后全景、财务还款、押品担保、外部风险、确定性预警和复评跟踪。动态事实来自 `post_loan_risk_data`；预警分级由 `POST_LOAN_RISK_ESCALATION` 确定性执行，写入继续复用通用确认、幂等和回执链。

## 6. 发布判定

以下任一项失败，Role Pack 不得发布：

- Golden Task Contract 或 Controlled Scenario 失败；
- Capability 缺少真实实现和测试证据；
- Side-effect Capability 无确定性 PEP；
- Receipt 元数据不是 EA 服务端签发；
- 写入缺少 Approval、Idempotency 或 Business Receipt；
- 共享 Evidence/UI/Governance 出现岗位硬编码；
- 当前资产指纹与已验收 Release Candidate 不一致。

## 7. 结论

GRACE Role Replication Validation V1 的产品判定是：

> 财富经理、保险顾问与风控经理使用不同岗位资产和企业数据入口，但复用同一套身份、上下文、治理、执行、证据和 UI 契约。

因此 Role Pack 是可安装、可验证的岗位交付单元，GRACE 是其统一受控运行平台，而不是单一 Agent 应用。
