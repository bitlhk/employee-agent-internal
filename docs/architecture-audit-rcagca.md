# 岗位智能体 R-C-A-G-C-A 架构审计报告

> 审计对象:`employee-agent` 仓库当前代码(非文档、非注释推断)
> 审计性质:Architecture → Code Mapping → Gap Analysis → Runtime Flow Verification
> **本轮不修改代码。**

---

## A. 一页结论

### 结论:**部分适合**

R-C-A-G-C-A 能解释系统 **80%** 的现状,但有一处**结构性错配**必须修正才能作为工作架构。

**三个最重要理由:**

**1. 六层里有五层能在代码中找到真实对应物,这说明抽象不是凭空造的。**
Role 有 `role-templates.ts` + `roleTemplate` 贯穿 6 张表;Context 有完整的知识资格闸门;
Agent 有运行时 + Skill + 多智能体委托;Capability 有 MCP/A2A/沙箱多种形态。
架构不是空中楼阁。

**2. 但 Governance 在代码里不是"一层",而是四套互不相通的实现 —— 这是架构与代码最大的错配。**
知识资格判定在 TS 进程内(`knowledge-eligibility.ts`)、工具治理在一个 HTTP 端点
(`tool-egress-routes.ts`)、MCP 授权硬编码在另一处(`platform-tools-mcp.ts:490`)、
多智能体委托边界只靠 prompt 提示(`claw-collab.ts:75`)。
**它们没有共同的 evaluator、没有共同的决策记录、没有共同的 fail-close 语义。**
所以 Governance 应当被定义为**横切控制面(Control Plane)**,而不是夹在 Agent 和 Capability 之间的一层。
—— 这一点你们的架构描述里已经写了"Governance 是横切控制面",**代码事实支持这个判断,应当把它坐实,而不是画成第四层。**

**3. 最致命的问题不在架构,在于:唯一的强制点当前没有仓库内的调用方。**
`POST /api/internal/security/pre-tool` 是一个**被动端点**——全仓库扫描(含配置、前端、脚本)
**没有任何代码调用它**,唯一的相关痕迹是 `.env.example:133` 的一行注释。
它依赖**仓库外的 JiuwenSwarm 运行时**被正确配置为 PreToolUse hook 才会生效。
**这意味着 INV-04 / INV-05 无法从本仓库证明成立,只能标记为 UNKNOWN。**
Governance 的有效性目前是一个**配置约定**,而不是**代码保证**。

---

## B. 六层成熟度表

| Layer | 成熟度 | 现有能力 | 最大 Gap | 需要新组件? |
|---|---:|---|---|---|
| **Role** | **3.0/5** | `role-templates.ts`(zod schema 校验)、`roleTemplate` 贯穿 adoption/memory/knowledge/agent 表、`jiuwenswarm-role-scope.ts` 生成角色范围清单 | 授权判定存在**硬编码角色**;Role 缺失时的 fail-close 未系统化 | 否 |
| **Context** | **4.0/5** | 知识资格闸门完整(时效/生命周期/密级/scope 硬过滤 + 前置过滤 + Null 语义冻结);Capability 元数据按角色范围化 | **业务数据(Data)层几乎不存在**;Memory 与业务事实未分级 | 否(Data 需新增) |
| **Agent** | **3.5/5** | JiuwenSwarm 运行时、Skill Pack、Planning、A2A 委托、协作会话(`coop`) | **委托边界只靠 prompt**,无确定性约束 | 否 |
| **Governance** | **2.5/5** | 组件齐全:工具治理注册表、出站护栏、注入检测、审计台账(fail-close+DLQ) | **四套实现互不相通;强制点无仓库内调用方;审批未持久化** | 是(统一 evaluator) |
| **Capability** | **2.0/5** | MCP(平台/自定义)、A2A、沙箱执行、HTTP | **多条执行入口各自一套安全链路**,未收敛 | 是(Capability Registry) |
| **Action** | **1.0/5** | 审计记录 `toolName` | **只有协议调用,没有业务动作语义** | 是(但可延后) |

### 单独评价

| 维度 | 评分 | 说明 |
|---|---:|---|
| **Multi-Agent** | **2.0/5** | 委托机制存在(`parentTaskId`、`executionScope`、`coop`),但**边界不强制**,存在权限提升风险 |
| **Audit** | **4.5/5** | 表结构极完整(actor/target/resource/workspace/runtime/correlation 全覆盖),fail-close + DLQ + 幂等排水。**这是本仓库最强资产** |
| **Evidence** | **2.0/5** | 能回答"发生了什么",不能回答"当时依据哪一版规则、看到了什么 Context" |
| **Eval** | **1.5/5** | `evaluate.py` 只测知识检索命中,无岗位任务/违规率指标 |
| **Platform Foundation** | **4.0/5** | 优雅停机、健康探针分层、可观测性、DR 演练、CI 棘轮 —— 已达生产级 |

---

## C. Architecture → Code Mapping

```
Role
→ server/_core/role-templates.ts            (getAgentRoleTemplate / listAgentRoleTemplates,zod 校验)
→ server/_core/jiuwenswarm-role-scope.ts    (buildJiuwenSwarmRoleScopeManifest → allowedSkillIds/mcpServers)
→ drizzle/schema.ts:386                     (clawAdoptions.roleTemplate,default "general-assistant")
→ drizzle/schema.ts:1110/1263/1346/1390     (agentMemory / knowledgeBases / ... 均带 roleTemplate)
→ docs/design/role-skill-mcp-baseline.json  (角色-技能-MCP 基线)

Context / Knowledge
→ server/_core/knowledge-eligibility.ts     (buildKnowledgeEligibility,KNOWLEDGE_NULL_SEMANTICS)
→ server/_core/knowledge-context.ts:203     (资格计算入口 + 预算裁剪 + 引用)
→ server/_core/knowledge-service.ts:484     (eligible_document_ids 下传)
→ server/knowledge/service.py               (_search_indexes / document_is_eligible / _rrf 权威排序)
→ drizzle/schema.ts:1256-1320               (knowledgeBases / knowledgeDocuments 治理字段)

Context / Capability Metadata
→ server/_core/jiuwenswarm-role-scope.ts    (effectiveAssets.mcpServers.default/optional)
→ server/_core/platform-tools-mcp.ts:452-493(服务端 MCP 授权校验)

Context / Memory
→ server/_core/agent-memory.ts (1212 行) / server/db/agent-memory.ts
→ drizzle/schema.ts:1110                    (agentMemory,带 roleTemplate/kind/status)

Context / Data(业务状态)
→ ❌ 无独立抽象。业务数据经由 MCP 工具返回值直接进入对话上下文。

Agent
→ server/_core/jiuwenclaw-bridge.ts (1624 行)  (运行时事件流/权限请求/工具结果)
→ server/_core/jiuwenswarm-gateway-client.ts
→ server/_core/claw-skills.ts / skills/skill-registry.ts
→ server/_core/claw-agent-tasks.ts             (A2A 任务委托,reserveAgentTask 行锁配额)
→ server/_core/claw-collab.ts / server/db/coop.ts / server/routers/collab.ts (多智能体协作)

Governance(⚠️ 四套分散实现)
→ [工具] server/_core/tool-governance.ts + tool-egress-routes.ts  (PreToolUse 端点,无仓库内调用方)
→ [出站] server/_core/tool-egress-policy.ts + data-guardrail.ts   (enforce)
→ [知识] server/_core/knowledge-eligibility.ts                    (进程内)
→ [MCP ] server/_core/platform-tools-mcp.ts:490                   (硬编码角色判定)
→ [委托] server/_core/claw-collab.ts:75                           (仅 prompt 注入)
→ [注入] server/_core/instruction-attack.ts                       (monitor-only)
→ [审计] server/_core/audit-ledger.ts / audit-events.ts

Capability
→ MCP:        platform-tools-mcp.ts / custom-mcp-client.ts / skill-mcp-readiness.ts
→ A2A:        agent-protocol-adapters.ts / claw-agent-tasks.ts
→ 沙箱执行:   sandbox.ts (硬化 Docker) ← 经 tool_router.ts 路由
→ 浏览器:     managed-browser.ts
→ 外发:       notification.ts / claw-notify.ts / claw-feishu.ts
→ ❌ 无统一 Capability Registry;上述各自实现安全链路

Action
→ ❌ 无业务动作抽象。审计中 targetId/toolName 记录的是协议调用名。
```

---

## D. 三条真实调用链

### FLOW-1:知识问答

```
POST /api/claw/chat-stream                                    ✅
  └ claw-chat.ts:253  detectInstructionAttackSignals(userMessage)   ⚠️ monitor-only(blocked:false)
  └ claw-chat.ts:~434 PLATFORM_UNTRUSTED_CONTENT_POLICY 注入        ✅
  └ knowledge-context.ts:203 buildKnowledgeEligibility()            ✅ 硬过滤
      └ 按 scope/roleTemplate/lifecycle/effectiveAt/expiresAt/classification 计算合格文档集
      └ Null 语义 fail-close(classification NULL → restricted)
  └ knowledge-service.ts:484 → eligible_document_ids 下传           ✅
  └ service.py _search_indexes()                                    ✅ 前置过滤(先过滤后截断)
      └ 过采样 max(candidate_k*4, 200);缓存键含合格集(防越权串缓存)
      └ authority 仅作 _rrf 平手排序键
  └ 预算裁剪 + 引用校验 validateKnowledgeCitations                  ✅
  └ 送 LLM → 流式返回
  └ 审计:❌ 未记录"本次实际提供了哪些知识"(仅前端展示 sources)
```
**判定:知识链路是全仓库治理最完整的一条。唯一缺口是 Evidence——事后无法还原"当时给了什么"。**

---

### FLOW-2:工具/MCP 调用 ⚠️ **本次审计核心问题**

```
Agent 决定调用工具(在仓库外的 JiuwenSwarm 运行时内)
  ↓
【期望】运行时回调 POST /api/internal/security/pre-tool          ❌ 无仓库内调用方
  │  证据:全仓库 grep "pre-tool" 仅命中端点自身 + 测试 + .env.example 注释
  │  依赖仓库外运行时配置正确注册 PreToolUse hook
  ↓ (若被调用)
  tool-egress-routes.ts:139 evaluateJiuwenPreToolUse()
    └ isAuthorizedInternalRequest()                              ✅ 常量时间比较
    └ resolveToolGovernance(tool_name)                           ✅ 注册表 + 启发式
    └ 未注册且属 POLICY_GATED_SIDE_EFFECTS → block               ✅ fail-close
    └ guardToolEgress() → 凭据/私钥/超长URL → block               ✅ enforce
    └ 异常 → policyUnavailableDecision → 503 block               ✅ fail-close
    └ auditGovernanceDecision()                                  ✅ ALLOW/DENY 双向审计
  ↓
实际执行(运行时内 / 平台 MCP 端点)
  └ platform-tools-mcp.ts:490  roleId === "wealth-manager" && ...  ⚠️ 硬编码角色
```

**判定:治理逻辑本身质量高(fail-close 完备、双向审计),但它不在一条"唯一必经路径"上——
它在一条"外部运行时被正确配置后才会经过"的路径上。**

**平台自身发起的 MCP 调用(`platform-tools-mcp.ts`)不经过 `evaluateJiuwenPreToolUse`,
而是走自己的一套授权判断,且判断条件硬编码了角色字符串。**

---

### FLOW-3:多智能体委托 ❌ **存在权限提升风险**

```
Parent Agent 发起协作
  └ routers/collab.ts:129  构造 executionScope = JSON.stringify({...})   ✅ 有边界定义
  └ db/coop.ts  createCoopSession / clawCollabRequests(事务+条件UPDATE)  ✅ 一致性已修复
  ↓
子 Agent 执行
  └ claw-collab.ts:117  JSON.parse(collabReq.executionScope)
  └ claw-collab.ts:75   注释原文:
     「executionScope 约束以系统 prompt 前缀形式注入,确保 LLM 层感知边界」
                                                                        ❌ 仅 prompt,无强制
  ↓
子 Agent 调用工具
  └ 是否回到 PreToolUse?取决于运行时配置(同 FLOW-2)                    ❌ 不可证明
  └ 子 Agent 的 Role / 权限是否 ≤ Parent 委托范围?                      ❌ 无代码校验
```

**判定:委托边界是"告诉模型别越界",不是"系统不允许越界"。
INV-08(禁止经委托实现权限提升)FAIL。**

这正是 `Knowledge → Context` 与 `Knowledge → Control` 之争在**委托维度**的重演:
`executionScope` 目前是 Context,不是 Control。

---

### FLOW-4(补充):A2A 专家任务

```
POST 提交专家任务
  └ claw-agent-tasks.ts:578  角色/画像/可见性校验                        ✅
  └ reserveAgentTask()  SELECT...FOR UPDATE 原子配额                     ✅
  └ agent-protocol-adapters.ts:275/332  guardToolEgress(channel:"a2a")   ✅ 出站数据护栏
  └ startAgentTaskInBackground() → 停机 drain + 中断恢复                 ✅
```
**判定:这条链路治理相对完整,是 FLOW-2/3 可以借鉴的正面样板。**

---

## E. Gap List

### P0(阻断企业级授权)

| ID | Gap | 证据 | 影响 |
|---|---|---|---|
| **P0-1** | **Governance 强制点无仓库内调用方** | 全仓库 grep `pre-tool` 仅命中端点自身;`jiuwenswarm-gateway-client.ts` 无 hook 注册 | INV-04/05 无法证明。运行时配置一旦缺失/回滚,**全部工具治理静默失效且无告警** |
| **P0-2** | **多智能体委托边界仅靠 prompt** | `claw-collab.ts:75` 注释明示;无 scope 校验代码 | INV-08 FAIL,**可经委托实现权限提升** |
| **P0-3** | **审批未持久化,无参数绑定** | schema 无 approval 表;`isRecentlyAnsweredPermission` 为会话内内存去重 | INV-06/07 FAIL。**"没记录的批准 = 没批准"** |
| **P0-4** | **MCP 授权硬编码角色** | `platform-tools-mcp.ts:490` `roleId === "wealth-manager"` | 新增岗位需改代码;授权逻辑游离于治理体系外 |

### P1(影响可审计/可扩展)

| ID | Gap | 证据 | 影响 |
|---|---|---|---|
| **P1-1** | 无统一 evaluator,四套治理实现互不相通 | 见 C 节 Governance 映射 | 判定不一致、无法统一举证、新增能力必然遗漏治理 |
| **P1-2** | Evidence 不可还原 | 审计表无 policyDecisionId/ruleVersion 列(仅在 metadata JSON) | 无法回答"当时依据哪一版规则" |
| **P1-3** | 知识 Context 未留痕 | FLOW-1 末端无审计 | 无法回答"Agent 当时看到了什么" |
| **P1-4** | 指令攻击检测 monitor-only | `claw-chat.ts:403` `MONITOR_V1` / `blocked:false` | 输入侧无拦截(出站侧有,可接受但需说明) |
| **P1-5** | Capability 多入口各自安全链路 | MCP/A2A/沙箱/浏览器/外发 各自实现 | 每加一种协议就要重做一遍治理 |

### P2(体验/成熟度)

| ID | Gap | 影响 |
|---|---|---|
| **P2-1** | 无业务 Action 语义(审计记录协议调用) | 监管问"谁创建了资产配置方案"需人工翻译 |
| **P2-2** | Data 层缺失(无 source/freshness/fetchedAt) | Step 5 接业务数据时无法证明"用的是哪一刻的数据" |
| **P2-3** | Eval 只测检索命中 | 无法给出违规率/任务完成率 |
| **P2-4** | Memory 与业务事实未分级 | "用户说喜欢低风险" 与 "监管评级C3" 可信度等同 |
| **P2-5** | `tool_router.ts` 774 行 0% 覆盖 | 工具路由中枢无回归保护 |

---

## F. 最小改造 Backlog(用现有能力完成 80%)

### ① 让 Governance 强制点可自证(对应 P0-1)

- **改什么**:新增 hook 心跳/自检——平台记录"最近一次收到 pre-tool 调用的时间";
  健康检查 `/health/ready` 暴露 `governance_hook_last_seen`;
  超过阈值未收到调用 → 告警 + 在管理界面显红。
  另在 `governance-invariants.test.ts` 增加一条:**断言存在 hook 存活检测机制**。
- **为什么**:无法在本仓库强制外部运行时调用,但**可以让"没被调用"变成可观测事件而非静默失效**。
  这是当前性价比最高的一项。
- **文件**:`tool-egress-routes.ts`、`observability/health-routes.ts`、`observability/metrics.ts`
- **Migration**:否 | **风险**:低 | **回滚**:删除指标即可
- **用户价值**:可以对客户说"治理失效会被立即发现",而不是"我们配置了 hook"

### ② executionScope 从 prompt 变为强制(对应 P0-2)

- **改什么**:子 Agent 的工具调用在 `evaluateJiuwenPreToolUse` 中额外校验
  `executionScope`(经 session/task 关联查出),超出范围 → DENY。
  委托时校验:子 Agent 有效权限 ≤ Parent 权限 ∩ 委托范围。
- **为什么**:INV-08 是银行场景的硬要求,**权限提升是不可接受风险**
- **文件**:`claw-collab.ts`、`tool-egress-routes.ts`、`db/coop.ts`
- **Migration**:否(`executionScope` 列已存在)| **风险**:中(可能拦住既有协作流程)
- **回滚**:加开关先跑 monitor 模式,观察一周再 enforce
- **用户价值**:可以证明"子智能体不会超出被授权范围"

### ③ 审批持久化 + 参数绑定(对应 P0-3)

- **改什么**:新增 `approval_records` 表(含 `toolInputHash` / `expiresAt` / `status` / 单次消费);
  复用现有 `permission_request` 前端通道;执行前重新校验 hash 与状态。
- **为什么**:`stableToolInputHash()` 已实现,前端通道已存在,**只差持久化这一层**
- **文件**:`drizzle/schema.ts`、`jiuwenclaw-bridge.ts`、新建 `approval-store.ts`
- **Migration**:**是** | **风险**:低(新增表,不改既有流程)
- **回滚**:保留表,停用写入
- **用户价值**:可以回答"这笔越权操作是谁批的、批的是哪一组参数"

### ④ 统一 evaluate() 契约,收敛四套治理(对应 P1-1)

- **改什么**:抽出 `governance/evaluate.ts`,签名
  `evaluate({actor, role, action, resource, context}) → {decision, ruleId, ruleVersion, inputSnapshot}`;
  **先不改判定逻辑**,只把现有四处包装成同一接口的实现;
  `platform-tools-mcp.ts:490` 的硬编码角色改为走 evaluate。
- **为什么**:这是 Step 2 Policy Core 的前置。**先统一接口再统一逻辑**,避免大爆炸重构
- **文件**:新建 `server/_core/governance/`;改 `platform-tools-mcp.ts`、`tool-egress-routes.ts`
- **Migration**:否 | **风险**:中 | **回滚**:保留旧路径,加开关切换
- **用户价值**:新增岗位不需要改代码

### ⑤ Evidence 最小闭环(对应 P1-2/P1-3)

- **改什么**:`audit_events` 增加 `policy_decision_id` / `rule_version` 两个**列**(不再只放 metadata JSON);
  FLOW-1 末端记录一条 `knowledge.context_provided` 审计(含合格文档 ID 列表 + 资格指纹)。
  注:`buildKnowledgeEligibility` 已返回 `fingerprint` 字段,**现成可用**。
- **为什么**:可举证是银行采购的核心;`fingerprint` 已经算好了,不用白不用
- **文件**:`drizzle/schema.ts`、`knowledge-context.ts`、`audit-events.ts`
- **Migration**:**是**(加列 + 索引)| **风险**:低
- **回滚**:列可保留为空
- **用户价值**:可以现场演示"还原某次对话当时看到的知识范围"

---

## G. 架构修正版

代码事实要求三处调整:

### 修正 1:Governance 不是第四层,是横切控制面(代码强证据)

```
        ┌─────────────────────────────────────┐
        │      GOVERNANCE (Control Plane)      │
        │  Permission / Policy / Approval /    │
        │  Guardrail / Delegation / Evidence   │
        └──┬────────┬────────┬────────┬───────┘
           │        │        │        │        ← 在每一层都有落点
    Role ──┴─ Context ─┴─ Agent ─┴─ Capability ─┴─→ Action
                                                      ↓
                                                   Outcome
                                                      ↓
                                                    Eval
```

**代码依据**:治理落点分布在 Context 层(`knowledge-eligibility`)、Capability 层
(`tool-governance`/`tool-egress-policy`)、Agent 层(`instruction-attack`/`executionScope`)——
它**已经**是横切的,只是**四套实现没有共同的 evaluator**。
把它画成夹在中间的一层,会误导实现者以为"只要在 Agent 和 Capability 之间加一道就行"。

### 修正 2:补一个被遗漏的一级概念 —— **Identity / Adoption**

代码里真正承载"谁在工作"的不是 Role,而是 **`clawAdoptions`(adoptId)**:
它绑定 `userId` + `roleTemplate` + `workspace` + `permissionProfile`,
是 `resolveClaw` / `requireClawOwner` / 审计 `agentInstanceId` 的统一主键。

**Role 是模板,Adoption 才是运行时身份实例。** 架构里只有 Role 会导致一个后果:
无法表达"同一岗位模板下不同用户的不同实例"这个已经存在于代码中的事实。

建议:`Identity(Adoption) → Role → Context → Agent → ...`,
或把 Role 层明确拆成 `Role Template` + `Role Instance(Adoption)`。

### 修正 3:Action 层暂不独立,先做 Capability 收敛

代码现状:审计记录的是协议调用(`toolName`),没有任何业务动作语义。
**在 Capability 尚未收敛(5 条入口各自安全链路)之前,先建 Action taxonomy 是过度设计。**

建议顺序:**先收敛 Capability(统一 Registry + 统一 evaluate)→ 再在其上标注业务 Action 语义。**
Action 层保留在架构中作为目标,但**不作为当前实现项**。

### 关于其他挑战问题

- **Q3(MCP 归属)**:代码已天然区分——`role-scope manifest` 生成的 MCP 定义属于 **Context/Planning**;
  `custom-mcp-client` / `platform-tools-mcp` 的调用属于 **Capability Execution**。这个划分是对的,保持。
- **Q4(Audit 归属)**:代码事实是 `recordAuditBestEffort` 被**所有层**复用(知识、工具、安全、协作),
  → **Audit 属于 Platform Foundation,Evidence 属于 Governance**。二者应当分开。
- **Q5(Memory)**:当前 `agent-memory` 实质是 Conversation Memory + Task State,
  **不构成 Context 一等公民**。Temporal Business Fact 是未来需求(Step 5),现在不需要。
- **Q6(Action)**:见修正 3。

---

## 十、Invariant 评估

| ID | 不变量 | 判定 | 代码证据 |
|---|---|---|---|
| INV-01 | Role Propagation | **PARTIAL** | `roleTemplate` 贯穿 6 张表 + 审计有 `actorRole`/`workspaceId`/`agentInstanceId`;但 `clawAdoptions.roleTemplate` 有默认值 `"general-assistant"`,Role 缺失时**降级而非 fail-close** |
| INV-02 | Context Eligibility | **PASS** | `knowledge-eligibility.ts` + `service.py` 前置过滤;Null 语义 fail-close;缓存键含合格集 |
| INV-03 | Capability Visibility | **PARTIAL** | `buildJiuwenSwarmRoleScopeManifest` 按角色产出 `allowedSkillIds`/`mcpServers`;但 `enforcement.mcp: "service-side-agent-context"` 依赖服务端二次校验,而该校验处硬编码角色 |
| INV-04 | Governed Execution | **UNKNOWN** ⚠️ | 端点逻辑完备,但**无仓库内调用方**,无法证明所有副作用调用必经 |
| INV-05 | DENY Means Never Execute | **UNKNOWN** ⚠️ | 同上。端点返回 `block` 后是否真的不执行,取决于仓库外运行时 |
| INV-06 | Approval Binding | **FAIL** | 无 approval 表;无 `toolInputHash` 绑定(hash 函数已实现但未用于审批) |
| INV-07 | Approval Single Consumption | **FAIL** | `isRecentlyAnsweredPermission` 为会话内内存去重,无持久化、无 consumed 状态 |
| INV-08 | Multi-Agent No Privilege Escalation | **FAIL** | `claw-collab.ts:75` executionScope 仅 prompt 注入;无 scope ≤ parent 校验 |
| INV-09 | Audit Completeness | **PASS** | `audit_events` 字段完整;`audit-ledger.ts` fail-close + DLQ + 幂等排水;ALLOW/DENY 双向记录 |
| INV-10 | Evidence Reproducibility | **PARTIAL** | 能还原"发生了什么";不能还原"依据哪一版规则/看到了什么 Context" |
| INV-11 | Guardrail Entry Coverage | **PASS** | `governance-invariants.test.ts` 目录扫描断言所有 chat 路由;`mini-experience` 已改为转发主链路 |
| INV-12 | Fail-Close | **PARTIAL** | 未注册写操作 ✅、policy 异常 ✅(503)、classification 缺失 ✅(→restricted)、时效歧义 ✅;**但 Role 缺失 ❌(降级为默认角色)、审批状态异常 ❌(无状态可查)** |

**统计:PASS 4 / PARTIAL 4 / FAIL 3 / UNKNOWN 2**

---

## 十一、明确不建议现在做的事

- 不引入 OpenSPG / Graphiti / WrenAI / OpenMetadata
- 不更换 Agent Framework
- 不重做知识库(FLOW-1 已是治理最完整的链路)
- **不重写 Audit**(`audit-ledger.ts` 是本仓库最强资产,只加列不改架构)
- 不大规模重构 `jiuwenclaw-bridge.ts`
- **不为了凑六层而现在建 Action taxonomy**(Capability 未收敛前属过度设计)
- 不新建抽象层——④ 的 evaluate 收敛应当是**包装现有实现**,不是新写一套判定逻辑

---

## 十二、下一阶段最值得投入的 5 项(优先级排序)

1. **Governance hook 存活自检**(P0-1)—— 让"治理失效"可观测,投入最小、收益最高
2. **审批持久化 + 参数绑定**(P0-3)—— 基础设施已备齐(hash 函数 + 前端通道),只差表
3. **executionScope 强制化**(P0-2)—— 先 monitor 一周再 enforce
4. **统一 evaluate() 契约**(P1-1)—— Step 2 Policy Core 的前置,先统一接口
5. **Evidence 最小闭环**(P1-2/3)—— `fingerprint` 已算好,加两列 + 一条审计即可

**共同特征:全部复用现有能力,零新增平台依赖,均可独立交付与回滚。**
