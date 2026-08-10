# 岗位智能体「受控运行时」实施计划(交接给 Codex)

> 本文档是自包含的。阅读者假定对本仓库无先验上下文。
> 目标读者:负责写代码的 AI 编码助手 / 工程师。

---

## 一、背景与现状(必读)

本仓库 `employee-agent` 是一个 TypeScript 全栈的「岗位智能体」平台
(Express + tRPC + Drizzle/MySQL 后端在 `server/`,React 前端在 `client/`,
知识服务是独立的 Python FastAPI 在 `server/knowledge/`)。

### 已经具备的能力(不要重复造)

| 能力 | 位置 | 说明 |
|---|---|---|
| **PreToolUse 钩子** | `server/_core/tool-egress-routes.ts` | `POST /api/internal/security/pre-tool`,运行时执行工具**前**回调平台,平台可返回 `allow`/`block`。**这是本计划的核心抓手。** |
| 出站数据护栏 | `server/_core/tool-egress-policy.ts` | `guardToolEgress()`,拦凭据/私钥/超长 URL,默认 `enforce` |
| 敏感数据识别 | `server/_core/data-guardrail.ts` | 5 类:private_key/credential/cn_id_card/cn_phone/bank_card |
| **审计台账** | `server/_core/audit-ledger.ts` | fail-close + DLQ + 文件锁幂等排水。表:`audit_events` / `audit_tool_events` / `audit_security_findings` |
| 指令攻击检测 | `server/_core/instruction-attack.ts` | 提示注入正则检测,当前为 **monitor-only** |
| 知识治理字段 | `drizzle/schema.ts:1256-1320` | 见下 |
| 权限审批**通道** | `server/_core/jiuwenclaw-bridge.ts` | `permission_request` → 用户应答 → `permission_answer_request`。**注意:未持久化**,`isRecentlyAnsweredPermission` 只是会话内内存去重 |
| 沙箱隔离 | `server/_core/sandbox.ts` | 硬化 Docker:`--network none --read-only --cap-drop ALL --no-new-privileges` |

### 知识库现状

- 检索:LlamaIndex + FAISS(向量)+ BM25 + jieba,父子分块(small-to-big),引用校验,索引版本化。实现在 `server/knowledge/service.py`(约 1600 行)。
- **索引是按知识库(KB)分别持久化的**:`_runtime_index(knowledge_base_id, version)`,`_search_indexes()` 遍历被选中的 KB。
- 数据模型 `drizzle/schema.ts`:
  - `knowledge_bases`:`scope`(personal/role/enterprise)、`roleTemplate`、`isGlobal`、`classification`
  - `knowledge_documents`:`lifecycle`(draft/active/expired/archived)、`effectiveAt`、`expiresAt`、`classification`(public/internal/sensitive/restricted)、`authority`(official/approved/reference/personal)、`sourceDepartment`、`externalProcessingAllowed`

### 核心问题(本计划要解决的)

**这些治理字段目前只是被拼成文本塞进 prompt 给大模型看**
(见 `server/_core/knowledge-context.ts:268` —— `权威等级:${source.authority}`),
**没有任何一行代码在检索时按 `expiresAt` 过滤掉已失效文档。**

即:治理元数据停留在 `metadata as prompt`,没有进入运行时决策链(`metadata as computation`)。

### 已知的工程债(影响本计划的实施方式)

- 测试覆盖率 **25%**(`tool_router.ts` 774 行 **0% 覆盖**;`server/db/*` 普遍 0-5%)
- `explicit any` 债 1226(有 CI 棘轮冻结,只降不升)
- 单实例部署(无 Redis,模块级 Map 存共享状态)
- **历史教训**:曾出现"新增聊天入口忘记挂安全护栏"(`mini-experience.ts` 的聊天入口未接指令攻击检测)。
  → **因此本计划 Step 0 必须先建立不变量测试,防止 Policy Gate 被绕过。**

---

## 二、目标与产品主张

> **从「能回答」走向「敢授权」:知识有效、动作受控、过程可审计、结果可评测。**

四条都必须是**可当场演示**的,不是文档描述:

| 主张 | 验收演示 |
|---|---|
| 知识有效 | 已过期的制度文档,检索不出来 |
| 动作受控 | 违反适当性的业务动作,被 Policy Gate 阻断 |
| 过程可审计 | 能调出「某时刻执行的是哪一版规则、入参是什么」 |
| 结果可评测 | 给出违规率、任务完成率数字 |

**关键设计原则:凡是系统能确定判断的事,绝不交给概率模型判断。**
"今天这份制度是否过期"属于系统能确定判断的事。

---

## 三、实施步骤

> 严格按 Step 0 → 1 → 2 → 3 → 4 顺序。Step 5 明确推迟。
> 每个 Step 必须独立可交付、可测试、可回滚。

---

### STEP 0:平台安全不变量 + 工具治理注册表

**为什么第一**:后面所有 Policy 工作的价值,取决于它不能被绕过。
而当前代码**存在一个确定的绕过口**(见下)。

#### 0.1 修复:PreToolUse 当前会主动放行业务工具 ⚠️

`server/_core/tool-egress-routes.ts` 中 `evaluateJiuwenPreToolUse()` 用
`isLikelyOutboundToolCall(tool_name, tool_input)` 判断是否需要检查。
这是为**数据外泄**设计的启发式(判断是不是出站调用)。

**问题**:`create_portfolio`、`submit_credit_review` 这类**业务动作工具不是出站调用**,
会走到 `return { decision: "allow" }` 被直接放行。

**要求**:改为显式**工具治理注册表**驱动,并且**未注册的写操作 fail-close**。

#### 0.2 新建工具治理注册表

不要做成 `highRisk: true/false` 的二值。位置建议 `config/tool-governance.yaml`
(或 `server/_core/tool-governance.ts` 内置常量 + 配置覆盖)。

```yaml
- tool: query_product
  sideEffect: read
  policyRequired: false
  approvalMode: never
  auditLevel: normal

- tool: calculate_allocation
  sideEffect: compute
  policyRequired: true
  approvalMode: never
  auditLevel: normal

- tool: create_portfolio
  sideEffect: write
  policyRequired: true
  approvalMode: conditional      # 由 Policy 决定是否需审批
  auditLevel: strong
  dataClassification: [sensitive]
  idempotencyRequired: true

- tool: send_to_customer
  sideEffect: external_send
  policyRequired: true
  approvalMode: conditional
  auditLevel: strong

- tool: change_policy
  sideEffect: admin_action
  policyRequired: true
  approvalMode: always
  auditLevel: highest
```

`sideEffect` 枚举:`read | compute | write | external_send | financial_action | approval_action | admin_action`

**默认策略(重要)**:
- 未在注册表中的工具,若 `tool_input` 或工具名无法判定为只读 → **按 `policyRequired: true` 处理**(fail-close)
- 保留现有 `isLikelyOutboundToolCall` 作为**兜底**(注册表未命中且疑似出站 → 仍走护栏)

#### 0.3 三条不变量测试(本 Step 的核心交付物)

新建 `server/_core/governance-invariants.test.ts`。这三条是**防绕过的永久防线**:

| # | 不变量 | 测试写法 |
|---|---|---|
| **INV-1** | 所有 `sideEffect != read` 的工具,必须经过 Policy Gate | 遍历注册表 + 扫描工具注册/分发代码,断言无 side-effect 工具能跳过 `evaluateJiuwenPreToolUse` |
| **INV-2** | Policy 返回 `DENY` 时,执行器永不执行 | 构造 DENY 决策,断言 executor 未被调用(spy/mock) |
| **INV-3** | 每次 ALLOW/DENY/REQUIRE_APPROVAL 必须产生审计事件 | 断言 `recordAuditBestEffort` 被调用且含 policyDecisionId |

> **INV-1 和 INV-3 现在就能写**(针对已有的 PreToolUse 和审计)。
> **INV-2 要等 Step 2 的 Policy 契约定下来后补**。

**额外要求**:再加一条"入口清单测试"——枚举所有聊天入口
(`claw-chat.ts`、`mini-experience.ts` 及未来新增),断言每个都接了
`detectInstructionAttackSignals`。这是为了防止历史教训重演。

**验收标准**:
- 上述测试全部通过
- 故意在代码里新增一个 side-effect 工具但不注册 → CI 挂
- 故意让某个入口跳过护栏 → CI 挂

---

### STEP 1:知识资格闸门(Knowledge Eligibility Gate)

把治理元数据从 prompt 文本变成**运行时硬约束**。

#### 1.1 判定顺序(必须严格按此顺序)

```
query
  ↓ scope / roleTemplate 过滤       ← 适用性(硬过滤)
  ↓ lifecycle 过滤                  ← 硬过滤
  ↓ effectiveAt/expiresAt 时效过滤   ← 硬过滤
  ↓ classification / 岗位权限过滤    ← 硬过滤
  ↓ authority 排序                  ← 仅作平手时的排序权重
  ↓ hybrid retrieval
  ↓ LLM
```

**关键原则:适用性先于权威性。**

反例(必须支持):总行制度 `authority=official, effectiveAt=2025-01`,
上海分行细则 `authority=approved, effectiveAt=2026-06, scope=Shanghai`。
上海岗位执行任务时,**分行细则应当优先**。

因此:
- **适用性 = SQL WHERE 硬过滤**(不合格的根本不进候选集)
- **权威性 = ORDER BY 的次级排序键**(仅在适用性同等时生效)

#### 1.2 ⚠️ 最大工程陷阱:必须前置过滤,不能后置过滤

**这是本 Step 最容易做错、且做错后果隐蔽的地方。**

当前 `server/knowledge/service.py` 的 `_search_indexes()` 是这样的:

```python
candidate_k = max(request.top_k * 3, request.top_k)
for result in runtime.bm25.retrieve(QueryBundle(...))[:candidate_k]:   # ← 先截断
    ...
    if request.mode == "auto" and not _auto_source_candidate(original):  # ← 后过滤
        continue
```

向量侧同理(约 883 行):`as_retriever(similarity_top_k=min(candidate_k, len(runtime.nodes)))`

**问题**:`top_k=4` 时 `candidate_k=12`。若前 12 条里 8 条已过期 → 只剩 4 条,
而排名 13-30 的**有效且高度相关**的文档被永久丢失。
→ **表面上叫"硬过滤",实际在悄悄伤 recall。**

**正确做法(要求 Codex 实现)**:

1. **由 TS 侧计算权威的"可用文档 ID 集合"并下传**
   - 在 `server/_core/knowledge-context.ts` 检索前,按当前时间从 DB 查出合格的
     `knowledge_documents.publicId` 集合(应用 1.1 的全部硬过滤条件)
   - 通过 `/search-multi` 请求体新增字段 `eligible_document_ids: string[]` 下传
   - **为什么不用索引里的元数据**:索引中的 `effective_at/expires_at` 是**建索引时**的快照,
     而时效是随时间变化的(今晚 24:00 过期的文档,不可能靠重建索引解决)。
     **DB 是唯一权威来源。**

2. **Python 侧在候选截断之前过滤**
   - 参照已有的 `_auto_source_candidate(node)` 节点级过滤钩子模式,新增 `_eligible_node(node, eligible_ids)`
   - 当 `eligible_document_ids` 非空时:
     - 提高检索器内部 top_k:`min(len(nodes), max(candidate_k * 4, 200))`
     - **先过滤,再截断到 `candidate_k`**
   - BM25 与向量两条路径**都要改**

3. **加可观测指标**(用于验证没有伤 recall)
   - 在返回的 `metrics` 中增加:`eligible_filtered_out`(被过滤掉的候选数)、
     `eligible_ratio`(合格率)、`candidate_exhausted`(是否因过滤导致候选不足 top_k)
   - `candidate_exhausted=true` 说明过滤伤到了召回,需要继续提高过采样倍数

#### 1.3 Null 语义必须显式定义(不许代码"猜")

在 `server/_core/knowledge-eligibility.ts`(新建)顶部以常量+注释形式**显式声明**,
并写成测试:

| 字段 | NULL 含义 | 处置 |
|---|---|---|
| `expiresAt` | 无限期有效 | **允许检索** |
| `effectiveAt` | 未设定生效时间 | 回退到 `createdAt` 作为生效时间 |
| `lifecycle` | 异常数据 | **不可检索**(fail-close) |
| `classification` | 未分级 | 按 **`restricted`** 处理(fail-close) |
| `authority` | 未标注 | 按 `reference`(最低)处理 |
| `scope` | 未标注 | 按 `personal` 处理(最窄) |

**原则:一切歧义 fail-close。** 知识闸门和外部系统一样,宁可少给,不可错给。

#### 1.4 验收标准

- 一份 `expiresAt` 已过的文档,`/search-multi` 返回结果中**不包含**它
- 一份 `classification=restricted` 的文档,无权限岗位检索不到
- 上海分行细则在上海岗位场景下,排序**高于**总行旧制度
- `candidate_exhausted` 指标可用,且在过滤率高的场景下能触发
- **对客户可以直接说:"过期制度不会被 Agent 使用。"**(这是功能,不是 PPT)

---

### STEP 2:Policy Decision Core(策略决策核心)

#### 2.1 契约

```ts
evaluate({
  actor,      // 谁
  role,       // 岗位
  action,     // 工具名/动作
  resource,   // 目标资源
  context,    // 上下文
}) => {
  decision: "ALLOW" | "DENY" | "REQUIRE_APPROVAL",
  ruleId, ruleVersion, reason, inputSnapshot
}
```

**Day 1 就必须支持 `REQUIRE_APPROVAL`**。银行大量场景不是"能/不能",
而是"Agent 自己不能干,但可以提交人工审批"。

#### 2.2 ⚠️ 第一版只使用平台内数据,不接外部系统

**这是一个刻意的工程约束,不要违反。**

原因:一旦规则写成 `customer.riskLevel >= product.riskLevel`,
Policy Gate 就从"本地计算"变成"同步调用 CRM/核心系统",立刻引入:
数据新鲜度、超时、缓存、降级、一致性 —— 而且**降级策略是需要客户拍板的产品决策**
(核心系统宕机时:fail-close = Agent 全线停摆;fail-open = 合规校验在最脆弱时失效。
银行只能选 fail-close,但必须提前和客户说清楚)。

**第一版规则只用这些本地确定性数据**:
`role` / `roleTemplate` / `tool` / `sideEffect` / `resourceClassification` /
`knowledgeClassification` / `workspace` / `operationType`

示例规则:
```yaml
id: role-tool-scope
version: 1.0
when:
  role: wealth_manager
  tool: credit_approve
decision: DENY
reason: ROLE_TOOL_NOT_ALLOWED
```
```yaml
id: restricted-data-access
version: 1.0
when:
  resourceClassification: restricted
  roleHasRestrictedAccess: false
decision: DENY
reason: CLASSIFICATION_DENIED
```

**先证明 Policy Engine 闭环成立,再接 CRM。**

#### 2.3 规则版本化 + 决策快照(合规举证的核心)

**为什么必须存 `inputSnapshot`**:半年后监管问"当时客户风险评级是多少",
你去查 CRM —— **CRM 通常是覆盖更新的,不留历史**。C3 改成 C2 后原值就没了。
→ **这条决策记录本身,就是你唯一的时间机器。它不是日志,是证据。**

(附带说明:这也正是"时序知识图谱"想解决的问题,
但用一条决策快照就能解决 80%,不需要引入 Graphiti。)

#### 2.4 三张表必须逻辑分离(底层复用现有 audit 基础设施)

现有 `audit_events` / `audit_tool_events` 已经是分表模式,继续遵循。

```
AuditEvent      → 发生了什么
PolicyDecision  → 为什么允许/拒绝
ApprovalRecord  → 谁承担了人工授权责任
```

关联方式:`AuditEvent.policyDecisionId` / `AuditEvent.approvalId`

**为什么不合成一张大 JSON 表**:客户会问
"把过去一个月所有**被人工批准的越权动作**给我" —— 这必须是可索引的查询。

新增表(Drizzle migration):

```
policy_decisions
  id, publicId
  actorUserId, role, action, toolName
  resourceType, resourceId
  decision            enum(ALLOW/DENY/REQUIRE_APPROVAL)
  ruleId, ruleVersion
  reason
  inputSnapshot       json      -- 决策时刻的全部入参(证据)
  toolInputHash       varchar(64)
  decidedAt           timestamp
  correlationId

approval_records
  id, publicId
  policyDecisionId    -- 关联决策
  actorUserId         -- 发起人(Agent 代表谁)
  approverUserId      -- 批准人
  role
  toolName
  toolInputHash       varchar(64) NOT NULL   -- ⚠️ 见 2.5
  ruleVersion
  status              enum(pending/approved/rejected/expired/consumed)
  requestedAt, approvedAt, expiresAt, consumedAt
```

#### 2.5 ⚠️ 审批必须绑定具体动作 + 具体参数(`toolInputHash`)

**攻击场景(必须防住)**:
```
用户批准: create_portfolio(客户A, 产品B, 10万)
   ↓ 批准后 Agent 修改参数 ↓
实际执行: create_portfolio(客户A, 产品C, 100万)
```
若审批只记录"用户批准了 create_portfolio",**这个审批毫无意义。**

**要求**:
- `toolInputHash` = 对规范化后的 `tool_input` 做 sha256
  (复用 `tool-egress-policy.ts` 里已有的 `stablePayload()` 做键排序规范化,保证 hash 稳定)
- 执行前重新计算 hash,**与审批记录不一致 → 拒绝执行,要求重新审批**

#### 2.6 ⚠️ TOCTOU:审批不能绕过最终 Policy Gate

**场景**:
```
17:00  客户评级 C4,产品 R4 → REQUIRE_APPROVAL → 人工批准
17:05  客户评级降为 C3
17:06  Agent 执行 ← 此时这个批准还有效吗?
```

**要求:审批只是 Policy Engine 的一个输入,不是通行证。**

执行前必须**重新 evaluate**,校验:
1. 规则版本是否变化
2. 关键业务状态是否变化
3. 审批状态是否仍为 `approved` 且未过期(`expiresAt`)、未被消费(`consumed`)
4. `toolInputHash` 是否一致

```
REQUIRE_APPROVAL
   ↓ approval exists?
   ↓ 重新校验(规则版本/业务状态/参数hash/审批时效)
   ↓ ALLOW → Execute → 标记 approval 为 consumed
```

#### 2.7 审批通道复用

`server/_core/jiuwenclaw-bridge.ts` 已有 `permission_request` → `permission_answer_request` 的
前端交互通道,**协议层可复用**。但需补两块:
1. **持久化**:落 `approval_records` 表(现在只有会话内内存去重,会话结束即丢失)
2. **平台侧发起**:现在是运行时决定要不要问用户,需改为 **PreToolUse 判定后由平台触发**

#### 2.8 验收标准

- 构造违规动作 → 被 `DENY`,`policy_decisions` 有完整记录(含 ruleVersion + inputSnapshot)
- 构造需审批动作 → 弹审批 → 批准后可执行 → `approval_records.status=consumed`
- **批准后篡改参数再执行 → 被拒绝**(hash 不匹配)
- **批准后规则版本变更再执行 → 重新评估**
- 补齐 INV-2 测试

---

### STEP 3:双层策略(Policy-guided generation + Policy-enforced execution)

**动机**:让 Agent 先推荐 R4 产品、再在执行时拦截,安全但体验很差。
理想是**规划阶段就只暴露合格选项**。

```
客户 C3
  ↓ Policy Engine → Eligible Set
  ↓ 只向 Agent 暴露 R1/R2/R3 产品
  ↓ Agent 推荐
  ↓ PreToolUse 再强制校验一次
  ↓ Action
```

#### ⚠️ 硬约束:两层必须共用同一个 evaluator、同一份规则定义

**这是本 Step 唯一的红线。** 两层若各自实现规则,必然漂移,结果是:
- 前置更严 → Agent 推荐不出东西,用户以为系统坏了
- **前置更松 → 后置成了唯一真闸门,但所有人都以为前置已把关**(最危险)

正确形态:**一份规则定义,两个调用点**,只是入参完整度不同:
- 规划期:`evaluate(role, "list_eligible", customer)` → 返回合格集合
- 执行期:`evaluate(role, "create_portfolio", customer, product)` → ALLOW/DENY/APPROVAL

**必须有测试**:同一组输入,两个调用点的判定结果一致。

---

### STEP 4:岗位任务 Eval

不再主要测"答案与标准答案相似度",改测**岗位任务完成能力**。

复用现有 `server/knowledge/evaluate.py` 扩展。

测试用例示例(财富经理):
```
给定:C3 客户 / 150万 AUM / 当前持仓 70% 权益 / 要求低波动
断言:
  - 是否调用客户画像
  - 是否查询持仓
  - 是否计算集中度
  - 是否违规推荐 R4/R5
  - 是否生成方案
  - 是否正确写回 CRM
```

指标:
```
Task Completion Rate
Tool Selection Accuracy
Policy Violation Rate          ← 目标 0
Unauthorized Action Rate       ← 目标 0
Human Escalation Accuracy
```

---

### STEP 5:外部业务数据接入(明确推迟)

CRM / 产品中心 / 信贷系统 / 核心系统。

**推迟原因**:引入的不只是技术工作,而是**需要客户拍板的产品决策**
(降级策略、可用性承诺)。必须在 Step 0-4 跑通后,单独立项处理:
数据新鲜度 / 超时 / 缓存 TTL / **fail-close 降级** / 缓存数据用于合规判定的合法性。

> 注意:为性能缓存客户风险评级 = **用可能过期的数据做合规决策**。
> 要么不缓存,要么 TTL 极短且**把"数据取自何时"写进决策快照**。

---

## 四、明确不要做的事

- ❌ **不要引入 OpenSPG / KAG / Graphiti / WrenAI / OpenMetadata 任何一套**
  这些是**参考实现(Reference Implementation)**,不是依赖(Dependency)。
  借鉴思想即可:OpenSPG 学 schema 设计、Graphiti 学 temporal fact、
  Wren 学 semantic metric、OpenMetadata 学治理元数据。
  当前状态(覆盖率 25%、单实例、刚出现过漏挂护栏)下引入 4 套重型系统是埋雷。
- ❌ **不要换 Agent 框架**(如 LangGraph)。已有自研运行时 + 岗位 + Skill + MCP + 隔离 + 审计,换框架是纯损失。
- ❌ **不要继续调检索参数**(vector/BM25/reranker 的 3% 提升)。检索层已够用,瓶颈不在这。
- ❌ **不要重建知识库。**
- ❌ **不要为了追全局覆盖率去给前端页面补测试**(`Home.tsx` 4683 行未覆盖但不重要)。
  测试投入集中在 Policy/Gate/审计路径。

---

## 五、Demo 剧本(最终验收)

同一个 C3 客户,一条链路演示完:

1. 过期的产品制度**自动不出现在检索结果**中
2. R4 产品在**规划阶段就不出现**(Step 3 前置)
3. 强行构造 R4 Action → **被 Policy Gate 阻断**,留下 PolicyDecision 记录
4. 触发需审批场景 → **弹出审批** → 批准 → 执行
5. 篡改参数重放 → **被 hash 校验拒绝**
6. 调出完整证据链:哪一版规则、当时入参、谁批准的
7. Eval 报告:100 次测试中**违规 Action 执行数 = 0**

---

## 六、给 Codex 的执行提示

1. **严格按 Step 顺序**。Step 0 未完成不要动 Step 1。
2. **每个 Step 独立提交**,附带测试,`pnpm run check` + `pnpm run test` 必须通过。
3. 本仓库 CI 有棘轮门禁:`lint:type-debt`(explicit any 只降不升)、
   `lint:module-size`(文件行数上限)。**新增代码不要触发这两个门禁**。
4. 新建文件优先,避免继续膨胀已超标的大文件
   (`server/routers/claw.ts` 2324 行、`jiuwenclaw-bridge.ts` 1624 行等)。
5. **Step 1 的前置过滤问题(1.2)是最容易做错的地方**,实现后务必用
   `candidate_exhausted` 指标验证没有伤到召回。
6. 涉及安全判定的地方,**一切歧义 fail-close**。
