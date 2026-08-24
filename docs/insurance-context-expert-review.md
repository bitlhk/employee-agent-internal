# Insurance Context Contract Expert Review

## Goal

将 10 个 Insurance Context Need 从工程 `proposed` 升级为专家确认的业务契约。审核只确认业务 Ground Truth，不批准 Runtime、Binding 或 Provider 上线。

**Result:** 10/10 Context Need 与 15/15 Golden Case 已由 `IA-EXPERT-01` 确认。

## Required reviewer record

- `reviewerId`
- `reviewerRole`
- `reviewedAt`
- `reviewComment`
- `groundTruthVersion`

## Decision dimensions

每个 Need 必须确认：

1. 是否与现有 canonical Context 语义相同；
2. required / optional 是否符合对应任务；
3. 是否应该与其他岗位共享同一物理 Production Binding；
4. 缺失时应为 BLOCKED、DEGRADED，还是不影响任务；
5. Memory 类 Context 的 Role / Purpose / Customer scope 是否足够严格。

语义复用与物理 Binding 复用分别确认，二者不要求相等。

## Batch 1 - Shared business and knowledge Context

| Need | Proposed semantic decision | Proposed binding decision | Requiredness summary |
|---|---|---|---|
| `customer_profile` | Reuse | Shared after enterprise customer-master confirmation | IA-GT-01/02 required; IA-GT-04 optional |
| `available_products` | Reuse contract | Role/channel-specific source allowed | IA-GT-02/03 required; IA-GT-04/05 optional |
| `current_followup_guide` | Reuse contract | Insurance-specific asset/source allowed | IA-GT-04 required; IA-ACT-01 optional |

## Batch 2 - Memory, action and continuity Context

| Need | Proposed semantic decision | Proposed binding decision | Requiredness summary |
|---|---|---|---|
| `customer_relationship_memory` | Reuse | Expert decision required | IA-GT-01/04 optional; Purpose isolation required |
| `governed_followup_payload` | Reuse | Expert decision required | IA-ACT-01 required only after write intent |
| `governed_work_state` | Reuse | Expert decision required | IA-GT-01 optional; Purpose isolation required |
| `current_insurance_previsit_sop` | New insurance Context | Insurance-specific | IA-GT-01 required |

## Batch 3 - Insurance-specific Context

| Need | Proposed semantic decision | Proposed binding decision | Requiredness summary |
|---|---|---|---|
| `current_insurance_sales_policy` | New insurance Context | Insurance-specific | IA-GT-02..06 required where declared |
| `insurance_product_exam_points` | New insurance Context | Insurance-specific | IA-GT-03/05 optional |
| `current_insurance_escalation_guide` | New insurance Context | Insurance-specific | IA-GT-06 required |

## Golden Set review

10 个 Need 确认后，继续审核 15 条 proposed Golden Case：

- Version correctness: 2
- Eligibility: 4
- Context need / failure semantics: 6
- Retrieval location: 3

只有全部 Case 进入 `expert_confirmed`，且 reviewer 字段完整，才能冻结 `Insurance Context Contract V1`。任何争议进入 `needs_resolution`，不得为了达到复用率或通过率修改业务结论。
