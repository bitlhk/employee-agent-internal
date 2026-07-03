# 岗位智能体平台组织协作协议 v1.0

> **用户文档入口**：左侧菜单「文档」页 → 第十一节「组织协作」，普通用户请从那里开始。
> **本协议**：面向平台维护者和二次开发者，含完整技术规范与 Roadmap。

> **定稿日期**：2026-03-31  
> **状态**：生效中  
> **适用范围**：plus / internal 级别 agent 之间的任务委托协作  

---

## 一、核心原则

1. **任务委托，非会话直通** — 协作底层是 `claw_collab_requests` 记录，不是 `sessions_send` 直通。对方永远无法进入你的私有 session。
2. **隐私铁律** — 聊天记录、私有记忆、usage 明细、session_id、token 类字段，在任何协作模式下均不可被访问或返回。此规则不可被任何配置覆盖。
3. **主人可控** — 每个 agent 的主人独立决定：是否可被发现、是否接受任务、是否需要逐次审批。
4. **可审计** — 每条协作请求完整记录：谁发、发给谁、什么任务、用什么审批模式、执行约束是什么、返回了什么。

---

## 二、请求结构（CollabRequest）

```typescript
CollabRequest {
  // 标识
  id: bigint
  requesterAdoptId: string      // 发起方 adoptId
  targetAdoptId: string         // 目标方 adoptId
  requesterUserId: int
  targetUserId: int

  // 任务
  taskType: string              // 见第四节 taskType 能力表
  taskSummary: string           // 人类可读任务描述，max 1000字
  inputPayload: JSON            // 经过字段过滤后的输入，见第三节

  // 状态机
  status: pending | approved | rejected | running | completed | failed | cancelled

  // 审计
  approvalMode: "auto" | "manual"
  approvedBy: userId | null      // auto 模式为 null
  riskLevel: "low" | "medium" | "high"
  executionScope: JSON           // 见第五节
  constraintsApplied: JSON       // 实际生效的约束快照

  // 结果
  resultSummary: string          // 结果摘要，max 2000字，经过禁止词扫描
  resultMeta: JSON               // { dataType, confidence, sourceCount }

  // 时间
  createdAt / approvedAt / completedAt / updatedAt
}
```

---

## 三、输入字段过滤规则

### 永久黑名单（所有模式）

以下字段名（含子串匹配）**无论什么模式一律剔除**：

```
chat_history, memory, session, sessionKey, messages, history,
context, user_data, personal_data, private
```

### auto 模式：严格白名单

auto 模式下，只允许以下字段通过，其他全部剔除：

```
input, query, file, url, keyword, date_range, filters, target
```

### manual 模式：黑名单过滤

manual 模式使用永久黑名单过滤，其他字段允许传入。

---

## 四、taskType 能力表

| taskType | 中文名 | 允许输入字段 | 允许 auto | 允许跨 owner | 默认风险等级 |
|---|---|---|---|---|---|
| `data_analysis` | 数据分析 | query, date_range, filters, target | ✅ | ✅ | low |
| `contract_review` | 合同审阅 | input, file, url | ❌（需审批）| ✅ | medium |
| `research` | 研究调查 | query, keyword, url | ✅ | ✅ | low |
| `report` | 报告生成 | input, query, date_range, filters | ❌（需审批）| ✅ | medium |
| `general` | 通用协作 | input, query | ❌（需审批）| ✅ | medium |

> **注意**：`contract_review` 和 `report` 类型因涉及可能包含敏感商业信息的文件，强制要求人工审批，不允许 auto 模式。

---

## 五、执行上下文约束（executionScope）

每条协作请求创建时，平台自动注入以下执行上下文，**未来 agent 执行时必须读取并注入为系统约束**：

```json
{
  "mode": "collaboration",
  "forbidAccess": [
    "chat_history",
    "memory_files",
    "session_context",
    "usage_logs",
    "private_notes"
  ],
  "allowedOutputTypes": [
    "result_summary",
    "data",
    "analysis"
  ],
  "forbidOutput": [
    "session_ids",
    "memory_ids",
    "internal_refs",
    "user_pii"
  ],
  "maxOutputLength": 2000
}
```

**执行链接入方式**（待实现，见第八节 Roadmap）：  
在目标 agent 处理协作任务时，将 executionScope 作为系统 prompt 前缀注入，使 LLM 在执行层感知边界约束。

---

## 六、风险评级规则

当前版本（v1.0）风险因子：

| 因子 | 条件 | 风险提升 |
|---|---|---|
| 跨 owner | requesterUserId ≠ targetUserId | → medium |
| 跨 owner + 长描述 | 跨 owner 且 taskSummary > 500字 | → high |
| 同 owner | requesterUserId = targetUserId | low |

**high 风险强制措施**：无论 acceptTask 设置是否为 auto，high 风险请求自动降级为 `pending`，必须人工审批。

**计划扩展（v1.1）**：
- taskType 是否敏感（contract_review 自动 +1级）
- 输入是否包含 file/url
- 目标 agent 是否标注为敏感角色
- 请求频率异常检测

---

## 七、结果安全规则

### 禁止词扫描（submitResult 时强制执行）

以下词汇出现在 resultSummary 中时，平台拒绝提交（400 错误）：

```
session_id, memory_id, agent_id, user_id:, adoptId:, sessionKey,
token:, password, secret
```

### 结果字段规范

```
resultSummary    用户可见的任务结论（max 2000字，经禁止词扫描）
resultMeta       结构化元信息（dataType / confidence / sourceCount）
```

**计划扩展（v1.1）**：  
拆分为 `userVisibleSummary`（给用户看）/ `auditSummary`（给审计看）/ `internalExecutionMeta`（给系统看）。

---

## 八、状态机

```
pending → approved → completed
        ↘ rejected
                   ↘ failed
                   ↘ cancelled
```

- `pending`：创建后等待目标方审批
- `approved`：审批通过（manual 审批 或 auto 模式低风险）
- `rejected`：目标方拒绝
- `running`：执行中（当前版本由 agent 手动标记，未来自动化）
- `completed`：任务完成，resultSummary 已填写
- `failed`：执行失败
- `cancelled`：发起方取消

---

## 九、权限层级

| 层级 | 可加入协作 | 可发起请求 | 可接受任务 | auto 模式 |
|---|---|---|---|---|
| starter | ❌ | ❌ | ❌ | ❌ |
| plus | ✅ | ✅ | ✅（主人配置）| ✅（主人配置）|
| internal | ✅ | ✅ | ✅ | ✅ |

---

## 十、Roadmap

### v1.1（下一步）
- [ ] executionScope 真正进入执行链（系统 prompt 注入）
- [ ] taskType 对应结构化输出 schema（限制返回字段）
- [ ] 风险规则引擎扩展（更多因子）
- [ ] 结果视图三层分离（user / audit / internal）

### v1.2（中期）
- [ ] 协作请求队列 + 超时自动取消
- [ ] SLA 配置（每个 agent 可设置响应时效）
- [ ] 协作频率限制（防止 DDoS 式任务轰炸）
- [ ] 组织级协调 agent（internal 级别的 orchestrator）

### v2.0（长期）
- [ ] multi-agent orchestration（并行任务 + 结果聚合）
- [ ] 协作计费模型
- [ ] 跨平台 agent 协作（标准化 API）

