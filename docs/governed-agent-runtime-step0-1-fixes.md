# Step 0 / Step 1 复审修复清单(交接给 Codex)

> 配套文档:`docs/governed-agent-runtime-plan.md`(总计划,先读它了解背景)
> 本文档针对 Step 0 / Step 1 已提交实现的复审结论。
> **前置状态:TS 165 文件 / 772 用例 + Python 26 用例全绿,`tsc --noEmit` 干净。修复不得破坏这一点。**

---

## 复审结论摘要

实现质量整体良好,**计划中最难的一处(检索前置过滤)做对了**,并且额外想到了缓存键隔离(避免不同权限用户串缓存)——这点是加分项。

以下 3 项必须修复,**其中 FIX-1 必须在开始 Step 2 之前完成**。

| 编号 | 严重度 | 问题 | 必须在 Step 2 前修 |
|---|---|---|---|
| FIX-1 | 🔴 高 | 工具注册表自相矛盾,INV-1 无法成立 | **是** |
| FIX-2 | 🟠 中 | `bash`/`exec_command` 免策略,构成策略旁路 | 建议是 |
| FIX-3 | 🟡 中 | 每次查询 O(总节点数) 全量扫描,性能回归 | 否 |
| OBS-1 | ⚪ 待确认 | 检索触发语义变更(纯向量信号不再触发) | 需确认意图 |
| OBS-2 | ⚪ 低 | 入口清单测试偏弱 | 否 |

---

## FIX-1 🔴 工具注册表自相矛盾:INV-1 无法成立

### 问题

`server/_core/tool-governance.ts:51-62` 中这批工具被标为 `sideEffect: "write"` 但 `policyRequired: false`:

```ts
exact: [
  "edit_file", "write_file", "edit_memory", "write_memory", "todo_create",
  "todo_modify", "evolve_review_task", "evolve_skill_experiences",
  "prepare_skill_evolution", "simplify_skill_experiences",
],
sideEffect: "write",
policyRequired: false,      // ← 与 INV-1 冲突
approvalMode: "never",
```

计划中的 **INV-1** 是:「所有 `sideEffect != read` 的工具,必须经过 Policy Gate」。
注册表里存在一批 `write` 却豁免策略的工具,**这条不变量在语义上就不成立**,测试也无法按原表述编写。

**判断:意图是对的,分类词用错了。** 这些是**智能体工作区内**的文件/记忆写入(受沙箱与工作区路径校验约束),不是**业务动作**,确实不应走业务策略。但不能因此把 `write` 这个分类挖空——否则 Step 2 的 Policy Core 基于 `sideEffect` 做判定时,会把这个矛盾固化进策略引擎。

### 修法

**1. 新增 `workspace_write` 侧效应类型**

```ts
export type ToolSideEffect =
  | "read"
  | "compute"
  | "workspace_write"      // 新增:智能体工作区内的写入,不触达业务系统
  | "write"                // 业务数据写入,必须走 Policy Gate
  | "external_send"
  | "financial_action"
  | "approval_action"
  | "admin_action";
```

**2. 把上述注册表条目改为 `workspace_write`**,保持 `policyRequired: false`、`auditLevel: "strong"` 不变。

**3. 导出一个显式的「受策略管辖」集合**,让不变量有单一事实来源:

```ts
export const POLICY_GATED_SIDE_EFFECTS: ReadonlySet<ToolSideEffect> = new Set([
  "write", "external_send", "financial_action", "approval_action", "admin_action",
]);
```

**4. `shouldBlockWithoutPolicyCore()` 改用该集合**(当前是 `sideEffect !== "read"`,会把 `compute` 也算进去,语义含糊):

```ts
export function shouldBlockWithoutPolicyCore(profile: ToolGovernanceProfile): boolean {
  return !profile.registered && POLICY_GATED_SIDE_EFFECTS.has(profile.sideEffect);
}
```

> ⚠️ **注意行为变化**:`compute` 类型的未注册工具将不再被 fail-close 阻断。
> 若要保持现有严格度,请把 `compute` 也加入 `POLICY_GATED_SIDE_EFFECTS`,
> 或在 `inferredProfile` 里让未注册的 `compute` 归入 `write`。
> **请显式选择一种并写进注释**,不要让它隐式改变。
> 现有测试 `fails closed for a newly introduced side-effect tool` 必须继续通过。

**5. `inferredProfile` 的 `idempotencyRequired` 列表**:`workspace_write` 不需要幂等要求,保持不在列表中。

**6. 保持启发式不变**:`WRITE_NAME_RE` 命中的**未注册**工具(如 `create_portfolio`)仍应推断为业务 `write`。
`workspace_write` **只授予注册表中显式列出的运行时工具**,不允许通过名称启发式推断得出。

### 验收

- `server/_core/governance-invariants.test.ts` 中把 INV-1 改写为精确表述并断言:
  ```
  对注册表全部条目:sideEffect ∈ POLICY_GATED_SIDE_EFFECTS 的,policyRequired 必须为 true
  ```
  该断言在修复前应当失败,修复后通过(先写断言确认它能抓到问题,再改代码)。
- 新增用例:`resolveToolGovernance("create_portfolio").sideEffect === "write"` 且 `policyRequired === true`
- 新增用例:`resolveToolGovernance("write_file").sideEffect === "workspace_write"`
- 现有 4 条不变量测试全部继续通过

---

## FIX-2 🟠 `bash` / `exec_command` 免策略,构成策略旁路

### 问题

`server/_core/tool-governance.ts:43` 把代码执行类工具归为 `compute` 且 `policyRequired: false`:

```ts
exact: ["ask_user", "bash", "code", "exec_command", "execute_command", "load_tools", "skill_tool", "task_tool"],
prefixes: ["a2a_", "expert_"],
sideEffect: "compute",
policyRequired: false,
```

**风险**:Step 2 上线业务规则后,**任何业务动作只要能用 bash 脚本完成,就完全绕过 Policy Gate**。

当前被沙箱 `--network none --read-only --cap-drop ALL` 兜住(脚本无法出网、无法触达业务系统),
**所以现在不是活漏洞**。但这是策略层的天然旁路,必须在 Step 2 之前标记出来。

另:`a2a_` / `expert_` 前缀是**对外部智能体的出站调用**,归为 `compute` 与其实际语义不符
(`claw-agent-tasks.ts:315` 另有 `guardToolEgress` 兜底,所以不算漏,但分类不一致)。

### 修法

**1. 代码执行类改为 `policyRequired: true`,保持 `registered: true`**

```ts
{
  exact: ["bash", "code", "exec_command", "execute_command"],
  sideEffect: "compute",
  policyRequired: true,        // Step 2 起纳入策略评估
  approvalMode: "never",
  auditLevel: "strong",
  idempotencyRequired: false,
},
{
  exact: ["ask_user", "load_tools", "skill_tool", "task_tool"],
  sideEffect: "compute",
  policyRequired: false,
  approvalMode: "never",
  auditLevel: "normal",
  idempotencyRequired: false,
},
```

> **零运行时风险**:`shouldBlockWithoutPolicyCore` 要求 `!registered`,
> 而这些工具 `registered === true`,因此当前不会产生任何阻断行为变化。
> `policyRequired: true` 在此仅作为 Step 2 的元数据标记。

**2. `a2a_` / `expert_` 前缀单独成条,改为 `sideEffect: "external_send"`**,`policyRequired: true`。
同样因 `registered === true`,当前无阻断行为变化。

**3. 在文件顶部加一段注释,记录待办**,供 Step 2 落规则时执行:

```ts
// Step 2 待办:沙箱内代码执行(bash/code/exec_command)不得触达业务系统。
// 当前依赖沙箱 --network none 隔离;Policy Core 上线后需补一条显式规则,
// 防止业务动作经由脚本绕过 Policy Gate。
```

### 验收

- `resolveToolGovernance("bash").policyRequired === true`
- `resolveToolGovernance("a2a_expert_call").sideEffect === "external_send"`
- 全量测试保持全绿,**且无任何新增阻断**(可用现有 `tool-egress-routes.test.ts` 覆盖确认)

---

## FIX-3 🟡 每次查询 O(总节点数) 全量扫描

### 问题

`server/knowledge/service.py:929`:

```python
vector_policy_allowed = all(
    bool(node.metadata.get("external_processing_allowed", True))
    for _, runtime in targets for node in runtime.nodes if document_is_eligible(node)
)
```

两个问题:

1. **性能回归**:原实现是 `all(runtime.external_query_allowed for _, runtime in targets)`,读的是索引 manifest 里的**预计算值**,复杂度 O(知识库数)。现在变成遍历**每个索引的每个节点**,复杂度 O(总节点数),**且每次查询都跑一遍**。几千节点规模上是可感知开销。
2. **默认值 fail-open**:`.get(..., True)` 在键缺失时默认放行。该键在早前提交已存在,风险较小,但与本项目「一切歧义 fail-close」原则不一致。

> 说明:改为按**合格文档**判定,在语义上其实是一个**改进**
> (不合格文档不该影响向量检索是否可用),这个方向是对的,只是实现方式代价过高。

### 修法

**在索引加载时预聚合成文档级映射,查询时只遍历文档(数量远小于节点)。**

1. 给 `RuntimeIndex` 增加字段:
   ```python
   document_external_allowed: dict[str, bool]
   ```

2. 在 `_runtime_index()` 构造时一次性计算(此处本来就已加载全部节点,不增加额外 I/O):
   ```python
   document_external_allowed: dict[str, bool] = {}
   for node in nodes:
       doc_id = str(node.metadata.get("document_id") or "")
       if not doc_id:
           continue
       allowed = bool(node.metadata.get("external_processing_allowed", False))  # 缺失 → 拒绝
       document_external_allowed[doc_id] = document_external_allowed.get(doc_id, True) and allowed
   ```

3. 查询时改为遍历文档级映射:
   ```python
   def _vector_policy_allowed(targets, eligible_document_ids) -> bool:
       for _, runtime in targets:
           for doc_id, allowed in runtime.document_external_allowed.items():
               if eligible_document_ids is not None and doc_id not in eligible_document_ids:
                   continue
               if not allowed:
                   return False        # 短路
       return True
   ```

4. **保留 `runtime.external_query_allowed` 字段**(仍被 `metrics` 使用),不要删除。

### 验收

- 新增 Python 用例:某文档 `external_processing_allowed=False` 但**不在**合格集合中 → `vector_policy_allowed` 仍为 `True`
- 新增 Python 用例:该文档**在**合格集合中 → `vector_policy_allowed` 为 `False`
- 新增 Python 用例:节点缺失 `external_processing_allowed` 键 → 判定为**不允许**(fail-close)
- 现有 26 个 Python 用例继续全绿

---

## OBS-1 ⚪ 需确认:检索触发语义发生了变更

`server/knowledge/service.py` 新增的 `_auto_trigger_decision()`:

```python
if bm25_signal and vector_signal: return True,  "bm25+vector"
if bm25_signal:                   return True,  "bm25"
if vector_signal:                 return False, "vector-rejected"   # ← 变更点
```

**变更前**:`triggered = forced or bm25_signal or vector_signal`,纯向量信号**可以**触发检索。
**变更后**:纯向量信号**不再触发**;对应地结果集合并处也改成了 `if bm25_signal and vector_signal`。

**影响:纯语义匹配、与文档无字面词重合的查询,将检索不到知识。** 这是一次召回行为变更,
**不属于 Step 0 / Step 1 的计划范围**(推测可能来自早前「减少无关知识自动注入」的调优)。

### 需要做的

- **若为有意调优**:在 `_auto_trigger_decision` 上方加注释说明理由,并补一条测试固化该行为(纯向量信号不触发)。
- **若为顺手改动**:评估是否恢复 `vector_signal` 单独触发,或改为**更保守的中间态**
  (例如纯向量信号触发但降低 `top_k`)。

**请先确认意图再动手,不要默认删改。**

---

## OBS-2 ⚪ 入口清单测试偏弱

`governance-invariants.test.ts` 最后一条用例靠字符串匹配硬编码两个文件:

```ts
expect(chat).toContain("detectInstructionAttackSignals(userMessage)");
expect(mini).toContain("/api/claw/chat-stream");
```

**问题**:**新增第三个聊天入口时,这条测试不会失败**——而这正是它要防的场景
(历史教训:`mini-experience.ts` 曾漏挂护栏)。

> 附:本次把小程序入口改为转发到 `/api/claw/chat-stream` 主链路继承护栏,
> 这个修法是正确的(在架构层面消除问题,而非逐个补挂),请保持。

### 建议修法(择一)

- **方案 A(推荐)**:扫描 `server/` 下所有注册了聊天类路由的位置
  (grep 路由注册模式,如 `chat`/`stream` 相关的 `app.post`),断言每个要么直接调用
  `detectInstructionAttackSignals`,要么转发至 `/api/claw/chat-stream`。
- **方案 B**:维护一份显式的「聊天入口清单」常量,测试断言实际路由集合与清单一致;
  新增入口若不更新清单则 CI 失败。

---

## 执行顺序与约束

```
1. FIX-1   ← 必须在 Step 2 之前完成(否则矛盾会固化进 Policy Core)
2. FIX-2   ← 建议同批完成,零运行时风险
3. 确认 OBS-1 意图并处理
4. FIX-3   ← 可独立提交
5. OBS-2   ← 可延后
```

**约束:**
- 每项独立提交,附带测试
- `pnpm run check` + `pnpm run test` + `pnpm run knowledge:test` 必须全绿
  (Python 测试请使用 `$HOME/.venvs/employee-agent-knowledge/bin/python`,
  **不要用系统 `python3`**,后者缺 `fastapi` 依赖会误报失败)
- 不要触发 CI 棘轮:`lint:type-debt`(explicit any 只降不升)、`lint:module-size`
- **不要顺手做的事**:不要重构检索算法、不要调整阈值参数、不要动 `_rrf` 排序逻辑、
  不要开始 Step 2 的 Policy Core

---

## 附:本次复审确认做对、请勿改动的部分

以下实现经复审确认正确,后续修改不要破坏:

1. **检索前置过滤顺序**:先 `document_is_eligible` 过滤,后 `accepted_for_base >= candidate_k` 截断;
   过采样 `governed_candidate_k = max(candidate_k * 4, 200)`;BM25 与向量两条路径都已覆盖。
2. **缓存键包含合格文档集合** —— 防止不同权限用户串用缓存(越权),**这是关键安全属性**。
3. **`eligible_document_ids` 的 `None` / `[]` 语义区分** —— `None` 兼容旧调用方,`[]` 表示显式零授权。
4. **`KNOWLEDGE_NULL_SEMANTICS` 冻结常量 + 安全语义注释**,未知 classification 归 `restricted`。
5. **`authority` 仅作 `_rrf` 平手排序键**,不参与硬过滤(适用性先于权威性)。
6. **`stableToolInputHash`** 键排序实现 —— Step 2 的审批参数绑定将直接复用,不要改动其序列化方式
   (否则历史审批记录的 hash 会失配)。
7. **小程序入口转发至主链路**继承护栏的修法。
