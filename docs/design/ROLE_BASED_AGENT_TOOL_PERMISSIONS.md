# Role-Based Agent Tool Permissions

This document records the proposed design for role-based Skill and MCP permissions in Workforce Agent Platform. It is a design note only; the current code does not yet implement the full role-template flow.

## Goal

When a user applies for a child Agent, the user can select a canonical business role such as `wealth-manager`, `post-loan-risk-control`, `credential-compliance`, `insurance-advisor`, or `investment-researcher`. If no professional role is selected, the Agent uses the explicit `general-assistant` template. The selected role determines which Skills and MCP tools the child Agent can see and use.

Newly created Agents default to the **jiuwenswarm** runtime. OpenClaw remains the compatibility and fallback runtime, especially for existing Agents and runtime-specific validation.

For the current MVP, role selection is self-service with no admin approval. In a bank deployment, the role is auto-mapped by querying the customer's internal IT systems (IAM / HR / AD) rather than manual approval.

The permission model should separate tool access from data access:

```text
Role template -> which tools and Skills this Agent can use
Real user identity -> which business data the tool can return
```

Example: two users can both have the `wealth-manager` role and both use `wealth_assistant_customer`, but the wealth data service must still return only each user's authorized customers.

## Current Code State

Current child Agent creation is driven by `claw.adopt` in `server/routers/claw.ts`. The request accepts only `permissionProfile`, currently `plus` or `internal`.

`claw_adoptions.permissionProfile` stores the legacy permission tier. The tier is still useful for sandbox and collaboration gating, but it is not a business role.

`provisionEmployeeAgentInstance` passes `--profile=<permissionProfile>` into `scripts/claw-provision.sh`.

`scripts/claw-provision.sh` currently maps `plus`, `internal`, `starter`, and `trial` to the same OpenClaw tool profile:

```json
{
  "profile": "coding",
  "deny": ["gateway", "nodes", "browser", "sessions_spawn"],
  "fs": { "workspaceOnly": true },
  "exec": { "ask": "off", "security": "full" }
}
```

The same script currently links every shared Skill from `.openclaw/skills-shared` into every child Agent workspace. This means Skill visibility is not yet role-scoped at provisioning time.

OpenClaw Agent config can already hold a per-agent `skills` array. Existing local configs show child Agents with `skills: [...]`, so Skill scoping can be implemented by writing and maintaining this field plus matching workspace links.

MCP servers are currently registered globally under `openclaw.json`:

```json
{
  "mcp": {
    "servers": {
      "wind_financial_docs": {},
      "wind_stock_data": {},
      "wealth_assistant_customer": {},
      "wealth_assistant_product": {}
    }
  }
}
```

`/api/claw/mcp-tools/status` currently builds its response from the internal MCP catalog plus global OpenClaw MCP config. It does not yet filter the catalog by Agent role.

## OpenClaw MCP Filtering Capability

OpenClaw 2026.6.8 supports per-agent MCP projection for the Codex app-server
path through:

```json
{
  "mcp": {
    "servers": {
      "wealth_assistant_customer": {
        "command": "...",
        "args": ["..."],
        "codex": {
          "agents": ["trial_lgc-xxx"]
        }
      }
    }
  }
}
```

Semantics:

- If `mcp.servers.<name>.codex.agents` is omitted, the server is projected to all Codex app-server Agents.
- If it is present and contains valid Agent ids, the server is projected only to those Agents.
- Empty, blank, or invalid lists fail closed.

This filtering is confirmed in OpenClaw's `buildCodexUserMcpServersThreadConfigPatch` implementation.

Important limitation: the schema says this field affects Codex app-server thread config only. The generic embedded/bundle MCP runtime still appears to merge global `mcp.servers` without the same per-agent filtering. For non-Codex runtimes such as a GLM path, use MCP service-side authorization as a short-term guard, or patch OpenClaw to support a runtime-agnostic per-agent MCP filter.

## Target Model

Introduce a role template layer:

```ts
type AgentRoleTemplate = {
  id:
    | "general-assistant"
    | "wealth-manager"
    | "post-loan-risk-control"
    | "credential-compliance"
    | "insurance-advisor"
    | "investment-researcher";
  label: string;
  industry: "general" | "banking" | "insurance" | "securities";
  status: "mvp" | "planned" | "disabled";
  permissionProfile: "plus" | "internal";
  runtime: "jiuwenswarm" | "openclaw";
  seedSkills: string[];      // bootstrap seed only; DB grants become runtime authority after P2/P3
  seedMcpServers: string[];  // bootstrap seed only; DB grants become runtime authority after P2/P3
};
```

Example:

```ts
const customerManager = {
  id: "wealth-manager",
  label: "财富经理",
  industry: "banking",
  status: "mvp",
  permissionProfile: "internal",
  runtime: "jiuwenswarm",
  seedSkills: [
    "wealth-manager-assistant",
    "wealth-family-advisor",
    "wealth-healthcheck",
    "wealth-goalcalc",
    "portfolio-doctor"
  ],
  seedMcpServers: [
    "wealth_assistant_customer",
    "wealth_assistant_product",
  ]
};
```

The role template should drive three layers consistently:

```text
Frontend display
-> Workforce Agent Platform API authorization/filtering
-> Runtime/MCP exposure
```

## Concrete Role Baseline (v1, 2026-06-16)

This is the single design entry point for the industry / role / Skill / MCP
mapping. The earlier standalone notes (`岗位-技能-MCP映射基线.md`) are consolidated
here. The machine-readable baseline lives at
`docs/design/role-skill-mcp-baseline.json`; this section explains the design
rules and summarizes that baseline.

Design principles (carried from the standalone note):

- New users default to basic general ability only. Finance/insurance专业能力、
  中队专区(squad)、业务 MCP 都不默认暴露。
- A role is the smallest unit of capability/permission allocation:
  `industry + role + skills + mcpServers + model + runtime + dataScopeNote`.
- Skills and MCP are dynamic assets. The JSON template is the bootstrap catalog
  and seed set; after DB grant tables are introduced, the runtime authority is
  the DB role-asset grants, not a second static allowlist.
- Users pick a role identity, not a runtime. The backend template decides
  runtime, model, MCP allowlist, and visible zones.
- Public data MCP is opened minimally per role; internal business MCP must be
  authorized by both role and data scope.

| 行业 | 子岗位 (roleKey) | 状态 | 默认 Skill | 默认 MCP server | 适用场景 |
|---|---|---|---|---|---|
| 通用 | 普通助手 (`general-assistant`) | MVP / 默认 | （无业务 Skill） | （无业务 MCP） | 新用户默认助手、通用问答、普通工作区 |
| 银行 | 财富经理 (`wealth-manager`) | MVP | wealth-manager-assistant, wealth-family-advisor, wealth-healthcheck, wealth-goalcalc, portfolio-doctor, fund-analyst | wealth_assistant_customer, wealth_assistant_product, wind_financial_docs | 客户清单、画像、资产配置、产品推荐、话术；qieman 暂不默认接入 |
| 银行 | 风控经理 (`post-loan-risk-control`) | MVP | post-loan-risk-prediction | post_loan_risk_data, wind_financial_docs | 企业贷后风险评估、预警、处置建议 |
| 银行 | 审核专员 (`credential-compliance`) | MVP | credential-prompt-generator, group-insurance-audit | credential_skills, group_insurance_audit | 凭证/票据/单证/影像/团险材料要素提取与合规检查 |
| 保险 | 保险顾问 (`insurance-advisor`) | MVP | insurance-advisor-pro, insurance-telesales-recommend, goldencoach-stage-evaluation | insurance_kb, insurance_telesales_recommend | 保险咨询、保障规划、产品推荐、外呼话术、销售陪练 |
| 证券 | 投顾分析 (`investment-researcher`) | MVP | wind-mcp-skill, wind-find-finance-skill, equity-investment-thesis, earnings-analysis, market-environment-analysis, bond-quote-parse 等 | wind_financial_docs, wind_stock_data, bond_quote_parse | 股票/基金/债券/公告/财报/估值研究与固收报价支持；指数/板块 MCP 暂不默认接入 |

First MVP roles: `general-assistant`, `wealth-manager`, `post-loan-risk-control`,
`credential-compliance`, `insurance-advisor`, `investment-researcher`.
Default users are created on jiuwenswarm with the `general-assistant` template and no business Skill/MCP.

### Canonical role-key dictionary (must align template ↔ skill role_tag)

The whole mapping assumes the role template key equals the Skill's
`skill_marketplace.role_tag`. As of 2026-06-16 the two have **drifted** and must
be reconciled before role-based provisioning is enabled. The roleKey column
above is the canonical dictionary; the DB `role_tag` values must be migrated to
match.

| 概念 | Canonical roleKey | DB role_tag 现状 | 处理 |
|---|---|---|---|
| 凭证合规 | `credential-compliance` | `compliance` | rename → credential-compliance |
| 销售陪练 | 并入 `insurance-advisor` | `sales-coaching` | map skill grants to insurance-advisor |
| 贷后风控 | `post-loan-risk-control` | `credit-risk`(3) + `post-loan-risk-control`(1) | merge credit-risk → post-loan-risk-control |
| 保险顾问 | `insurance-advisor` | `insurance-advisor`(1) + `insurance-underwriting`(1) + `insurance-telesales`/`sales-coaching` | merge sales/advisor skills → insurance-advisor |
| 保险理赔 | 并入 `credential-compliance` | `insurance-claims`(1) | 当前按审核材料/欺诈检测归入审核专员；后续成规模再拆 |

A DB reconciliation SQL should be reviewed before running on Shanghai. Until the
keys are unified, do not auto-map Skills to roles by `role_tag`.

### Open items folded in from review

- Landing gaps (schema + provisioning) are already covered by *Current Code
  State* and *Implementation Plan* below: `claw_adoptions` has only
  `permissionProfile` (no `role`/`industry` column), and `claw-provision.sh`
  links every shared Skill into every workspace. Role-based delivery requires the
  schema field (Implementation Plan step 2) and provisioning filter (step 5).
- Naming: the JSON uses `bond_quote_parse` (underscore); some `openclaw.json`
  entries use `bond-quote-parse` (hyphen). Normalize to one form.
- Qieman tools in `role-skill-mcp-baseline.json` should use the actual tool
  names exposed by the server (`SearchFunds`, `BatchGetFundsDetail`, ...), not
  synthetic `qieman__*` prefixes.
- `defaultVisibleZones` values (squad/finance) align with the `origin` enum
  (opensource/finance/squad); note the value domain explicitly in the JSON.
- Verified OK: MCP server names match real registrations
  (wealth_assistant_customer/product = 18007/18008, wind_*, insurance_kb,
  post_loan_risk_data); referenced default/optional Skills exist in both Shanghai
  and local skill-market.

## Role Lifecycle: Apply, Change, Migration

This section covers the end-user goal: pick a role at apply time and get the
right Skills/MCP automatically; a general assistant gets no business Skill/MCP;
and changing role later (e.g. 客服 → 客户经理) auto-migrates the toolset.

### Apply (initial provisioning)

- User picks a role at adopt time. Backend writes the `roleTemplate` field and
  provisions Skills/MCP from that template (Implementation Plan steps 2–6).
- `general-assistant` is the explicit default role in
  `role-skill-mcp-baseline.json`: basic general ability only, **no finance/insurance
  Skill, no business MCP**, `defaultVisibleZones: ["opensource"]`. This makes
  "普通助手" a real deny-by-default template rather than a prose convention.
- New child Agents are created on `jiuwenswarm` unless the selected role or an
  admin override explicitly requests the `openclaw` fallback runtime.

### Change / migration (role reassignment)

> **范围更新（2026-06-17）**：MVP 阶段简化为「**换岗 = 按新模板重装**」（见 *Enterprise Readiness &
> Scope Decisions*）。下文 L1/L2/L3 + 停用不删的精细 reconcile **暂缓**，等用户大量自装业务技能后再引入。
> 离职/停用的反向收权（停用 agent、杀会话、收回数据访问）为必补项，见同节。

MVP role change is a **role reset**: recompute the effective role grants and
overwrite the active Skill/MCP set for the Agent. This is intentionally simpler
than fine-grained reconcile and avoids carrying old business tools across roles.

Deferred fine-grained reconcile (not MVP) would split installed assets into
three layers:

| Layer | 来源 | 换岗时处理 |
|---|---|---|
| L1 role baseline | 旧/新模板的 skills+MCP | 按新模板换：删旧基线独有、装新基线独有、保留交集 |
| L2 admin exception | 后台给该用户单独 pin 的 | 保留（不随岗位走，带审计） |
| L3 user self-installed | 用户自己从市场装的 | 通用(`origin=opensource`)→保留且激活；业务(`origin=squad/finance`)且不属新岗位→**停用不删**（移出激活集、市场隐藏、停止触发，文件保留） |

Skills:

- Reconcile three things together: workspace skill links, OpenClaw
  `agents.list[].skills`, and marketplace visibility. **可见性按新岗位的 zones 过滤，
  与"已安装集合"是两个层，只改可见性不够**——必须同时调谐已安装/已激活集合，否则新角色
  仍保留旧角色的工具在跑。
- Hidden prerequisite: each installed Skill must carry a `source` tag
  (`baseline | admin | self`) so reconcile knows what to remove vs keep. **Not
  present today.**

MCP:

- Clean overwrite. Recompute the allowlist (`mcp.servers.*.codex.agents`
  projection + `tools.alsoAllow`) from the new template and re-apply. MCP carries
  no workspace state, so it is the easy part. Data authorization stays
  identity-based (`agentId → user → row-level`) throughout, so there is no
  cross-role data leak during the transition.

Session:

- Bump the session epoch (reuse `bumpClawSessionEpochBestEffort` or the runtime
  adapter equivalent) so the new tool fingerprint takes effect; otherwise active
  runtime sessions may keep the old toolset cached. This answers the earlier
  Open Question on session reset.

Audit:

- Emit a `role.changed` event: old role → new role, added/removed Skills + MCP,
  actor (admin or self), timestamp.

New infra required (none exists today):

1. A **role reset mode** in the runtime adapter — recompute effective grants for
   the new role and overwrite active Skill/MCP exposure. For OpenClaw this can
   reuse or replace `claw-provision.sh`; for jiuwenswarm it should update the
   per-agent skill directory and MCP service-side allowlist.
2. `roleTemplate` field on `claw_adoptions` (in Implementation Plan, not built).
3. Deferred: per-installed-Skill state (`source` + `active/deactivated`) for
   fine-grained reconcile when user self-installed business Skills become common.

### L3 policy (decided): deactivate, don't delete

Rationale — a Skill is a methodology Markdown, **not** a permission. The real
boundary is MCP + identity-based data authorization, which is swapped on role
change; a leftover Skill whose backing MCP is gone simply fails closed (no data
leak, at worst an off-target answer). So Skills are not treated like credentials
and are never hard-deleted on role change.

Decided default:

- 通用技能 (`origin=opensource`)：保留且激活——无害工具。
- 跨岗位业务技能 (`origin=squad/finance`，不属新岗位)：**停用不删**——移出激活
  `skills` 列表、市场隐藏、停止自动触发，但**保留 workspace 文件**，便于调回原岗位
  时秒恢复。停用 ≠ 删除是关键：既不销毁用户的方法论积累，又保持角色边界清晰和审计观感。
- 新岗位业务技能：装上并激活。

This is defense-in-depth on top of the hard MCP boundary, not the primary gate.
Rejected alternatives: "keep all active" (cross-role business Skills mis-trigger
and poor audit optics) and "clear all" (destroys user methodology unnecessarily,
since MCP already fails closed).

## Skill Metadata For Role Matching

Do not use the existing `skill_marketplace.category` column as the fine-grained
business scenario field.

Current database state:

- `skill_marketplace.origin` is a source/display grouping, such as
  `opensource`, `finance`, or `squad`. It answers where the Skill came from.
- `skill_marketplace.category` is a coarse enum limited to
  `finance | dev | data | writing | general | office | design`. It is useful
  for broad marketplace filtering, but it cannot safely store values such as
  `auto_insurance_sales` or `group_insurance_audit`; MySQL will coerce unknown
  enum values to an empty string.
- The marketplace card's top-right chip should display a business scenario
  label, not the source label. For example, squad Skills should show
  `债券报价`, `凭证审核`, `车险外呼`, `团险审核`, or `销售陪练`, rather than all showing
  `中队专区`. These are scenario chips, not self-service role names.

Short-term implementation:

- Keep `origin=squad` for internally reviewed squad Skills.
- Keep `category=finance` for finance/insurance squad Skills until the schema is
  extended.
- In the marketplace frontend, map known `skillId` values to scenario labels for
  display only:

```text
bond-quote-parse                 -> 债券报价（授权归投顾分析）
credential-prompt-generator      -> 凭证审核（授权归审核专员）
insurance-telesales-recommend    -> 车险外呼（授权归保险顾问）
group-insurance-audit            -> 团险审核（授权归审核专员）
goldencoach-stage-evaluation     -> 销售陪练（授权归保险顾问）
```

Target schema:

Add explicit role-matching metadata instead of overloading `category`:

```ts
type SkillBusinessMetadata = {
  scenarioKey: string;       // e.g. "auto_insurance_sales"
  scenarioLabel: string;     // e.g. "车险外呼"
  businessDomain: string;    // e.g. "insurance" | "banking" | "securities"
  roleTags: string[];        // e.g. ["insurance-advisor", "wealth-manager"]
  mcpServers: string[];      // MCP dependencies used by this Skill
  toolNames: string[];       // Optional sub-tool dependencies
};
```

Role templates should match on `scenarioKey`, `businessDomain`, and `roleTags`.
The UI chip can render `scenarioLabel`; authorization must be server-side and
must not rely on frontend display tags.

## Dynamic Role–Asset Association（动态岗位匹配）

需求：上线技能/MCP 会持续发生，**新增一个技能/MCP 时，运营在发布环节标注它属于哪些岗位，
上线后该岗位的所有 Agent 立即（动态）看到，无需改配置、无需重启、无需开发介入。** 一个技能或
MCP **可以同时挂多个岗位**（通用类挂多个，专用类挂一个）。

> **范围更新（2026-06-17）**：本节已按 *Enterprise Readiness & Scope Decisions* 收敛为
> **单一源 = DB 岗位资产授权**。"基线"只是出厂默认 seed 进去的授权记录，不再维护独立静态
> `allowedSkills ∪ dynamicTags` 两套真相源。多岗位 / 发布即生效 / 通用标记等需求不变。

### 单一源模型（DB role asset grants）

某岗位的有效技能/MCP 清单只从 DB 授权表解析：

```text
effective_skills(role) = { skill | role ∈ role_asset_grants
                                  and asset_type = "skill"
                                  and enabled = true }

effective_mcp(role)    = { mcp   | role ∈ role_asset_grants
                                  and asset_type = "mcp_server"
                                  and enabled = true }
```

- **JSON baseline**：岗位目录、行业分类、默认 runtime/model/dataScope、出厂 seed 清单。
- **DB grant**：运行时权限源。P2/P3 引入后，JSON seed 会导入/同步成 DB grant；后续发布技能/MCP
  只改 DB grant 即可即时生效。
- **grant mode**：同一张表区分 `default`（新建/重置 Agent 自动装配）与 `optional`（市场可见、用户可装）。
- **scope marker**：通用资产用 `role="*"` 或 `role="general-assistant"` 表示公共可见，避免逐岗位复制。

建议目标表（可按现有 DB 命名调整）：

```ts
type RoleAssetGrant = {
  roleKey: string;              // canonical role key or "*"
  assetType: "skill" | "mcp_server";
  assetId: string;              // skill_id / mcp_server
  grantMode: "default" | "optional";
  source: "seed" | "admin" | "market";
  enabled: boolean;
  createdBy?: string;
  updatedBy?: string;
};
```

### Seed sync contract（P2 硬约束）

JSON baseline 保留 Git/PR 治理，但运行时只查 DB grants。实现方式是把 JSON seed
**幂等物化**到 `role_asset_grants`：

```text
syncRoleAssetSeed(jsonBaseline):
  desiredSeed = expand defaultSkills/defaultMcp from JSON
  upsert desiredSeed rows with source = "seed"
  prune/disable stale rows where source = "seed" and not in desiredSeed
  never modify rows where source in ("admin", "market")
```

硬规则：

- JSON seed 变化只影响 `source="seed"` 的行。
- 运营/后台新增的 `source="admin"` / `source="market"` 授权，部署或 re-seed 时绝不能被覆盖或删除。
- 从 Git 基线删除一个默认技能/MCP，只能删除或禁用对应 `source="seed"` 行；同一资产若还有 admin/market 授权，继续保留。
- `enabled=false` 是统一安全闸：待审、下架、应急封禁都可以先通过禁用 grant 即时生效，再补 PR/审计说明。
- Resolver 查询通用授权时必须匹配 `{roleKey, "*"}`；`role="*"` 代表所有岗位通用。

Resolver 对外契约：

```ts
type EffectiveRoleAssets = {
  skills: {
    default: string[];
    optional: string[];
  };
  mcpServers: {
    default: string[];
    optional: string[];
  };
};

resolveEffectiveRoleAssets(roleKey: string): Promise<EffectiveRoleAssets>;
```

Runtime adapters only consume `resolveEffectiveRoleAssets(...)`. They must not
read JSON seed or marketplace display tags directly.

MCP sub-tool authorization is **future scope**. P2 grants at MCP server level to
match the current UI model (server card + expanded tool list). If a specific
dangerous sub-tool must be blocked later, add a separate deny/allow layer with
explicit UI and audit support instead of making every MCP publish flow manage
dozens of tool-level grants from day one.

### 多岗位（核心）

- 技能与 MCP 的岗位关联都是**多值**：一个资产可服务多个岗位。
- 通用资产（如行情查询、文档协作）打到多个岗位；专用资产（如团险审核）只打一个。
- 可保留一个特殊标记（如 `*` / `general`）表示"对所有岗位可见"，用于真正通用的工具，避免逐个岗位打标签。

### 当前差距（必须补，目前是空白/半成品）

1. **技能主岗位字段只做展示**：`skill_marketplace.role_tag` 现为单个 `varchar(32)`，可保留为市场卡片主岗位 /
   chip，不再作为授权 source of truth。
2. **新增统一授权表**：用 `role_asset_grants` 同时承载 Skill、MCP server、MCP sub-tool 的岗位授权；
   比分别维护 `skill_role_tags` / `mcp_role_tags` 更容易做统一审计和重置。
3. **发布/后台打标签 UI**：上线技能/MCP 时设置多个岗位 + `grantMode`，写 DB，即时生效。
4. **可见 vs 自动安装**：`optional` 默认让资产对该岗位**可见/可选**，不强制塞进存量 Agent；
   `default` 只在新建 Agent 或 role reset 时自动装配。
5. **与 role_tag 规整的关系**：P1 的 role_tag canonical 化仍要做，但只是为了显示和反查干净；
   P2/P3 授权不再依赖单值 role_tag。

### 验收

- 发布一个新技能、写入 `role_asset_grants(roleKey="wealth-manager", grantMode="optional")` →
  该岗位所有 Agent 在技能市场/可见清单中**立即**看到，
  无需改 JSON、无需重启。MCP 同理。
- 一个技能标注 `["wealth-manager","investment-researcher"]` → 两个岗位都看到。

## Frontend Display Layer

The UI must not display tools outside the selected role.

For a `wealth-manager` Agent, the MCP tools page should show wealth-manager customer/product tools and hide unrelated research, bond quote, or general platform MCP tools.

This must be server-driven. The frontend should render what the API returns, not keep its own hard-coded authority list.

Required changes:

- Add a role selector to the child Agent application flow.
- Show the selected role on Agent profile/settings pages.
- Filter Skills and MCP tools by role through server responses.
- Keep frontend cache versioned so an old MCP catalog cannot continue showing after role changes.

### Apply UI: grouped role picker

The apply page should not silently create a professional Agent. It should show a
grouped role picker and default to `general-assistant`.

Grouping:

| Group | Roles |
|---|---|
| 通用 | 普通助手 (`general-assistant`) |
| 银行 | 财富经理 (`wealth-manager`), 风控经理 (`post-loan-risk-control`), 审核专员 (`credential-compliance`) |
| 保险 | 保险顾问 (`insurance-advisor`) |
| 证券 | 投顾分析 (`investment-researcher`) |

Display policy:

- `general-assistant` is selected by default. If the user directly confirms,
  create a jiuwenswarm Agent with no business Skill/MCP.
- `status=mvp` roles are selectable in the first version.
- `status=planned` roles are either greyed out with a "规划中" state or hidden
  from the self-service flow and only assignable by admins.
- End users choose role, not runtime. Runtime comes from the role template:
  new Agents default to jiuwenswarm; OpenClaw is admin-only fallback.

### Admin UI: where role change lives

Role assignment and reassignment live in the admin backend — `ClawAdmin.tsx`
实例管理 (instance management) table — not in the end-user flow. The table
already has the row-level pattern to reuse: a `Select` whose `onValueChange`
calls `updateMutation.mutate(...)`, plus a batch action via `adminBatchUpdate`.

Important gotcha: the table currently has a column **labeled "角色"** that in fact
renders `permissionProfile` (plus/internal) — i.e. the privilege tier, not the
business role. Do not stack a second "岗位" column on top of this ambiguity.

Decided layout:

| 列 | 含义 | 取值 |
|---|---|---|
| 权限档 (rename the existing "角色" column) | sandbox/privilege tier | plus / internal |
| 岗位 (new column) | business role | 财富经理 / 风控经理 / 审核专员 / 保险顾问 / 投顾分析 / 通用助手 |

This matches the tier-vs-role separation: `permissionProfile` stays for
sandbox/privilege; the new role column drives Skill/MCP allocation.

Critical: the 岗位 dropdown's `onValueChange` must **trigger role reset** defined
in *Role Lifecycle*, not just write a label — recompute effective DB grants,
overwrite active Skill/MCP exposure, bump session epoch, emit a `role.changed`
audit event. Row-level update reuses `adminUpdate`; batch reassignment reuses
`adminBatchUpdate` (both take a new `role` field on top of the existing
`permissionProfile`/`status`/`ttlDays` inputs).

## Workforce Agent Platform API Layer

The server must enforce role filtering even if a user bypasses the frontend.

Required changes:

- Store the role template id for each child Agent.
- Resolve effective Skill/MCP grants from DB `role_asset_grants` through the
  role asset grant resolver.
- Filter `/api/claw/mcp-tools/status` by effective MCP grants.
- Filter Skill list responses by effective Skill grants and visible zones.
- Reject Skill enable/install requests if the Skill is outside the Agent role.
- Treat user-uploaded/generated personal Skills as per-Agent personal assets:
  they are owner-scoped and do **not** require role matching. Submitting such a
  Skill to the marketplace converts it into a reviewed market asset; at that
  point marketplace role-grant rules apply.
- Record role and effective allowlists in audit events.

The existing `permissionProfile` should remain for sandbox and broad privilege tiering. It should not be reused as the business role.

## OpenClaw Runtime Layer

For Codex app-server Agents:

- When provisioning or updating an Agent, maintain `mcp.servers.<server>.codex.agents`.
- Add the Agent id to each allowed MCP server.
- Remove the Agent id from each disallowed MCP server.
- Write the Agent's `skills` array to the OpenClaw Agent config.
- Link only allowed shared Skills into the Agent workspace.

Runtime Skill activation must merge the role baseline with safe installed
personal assets:

```text
active_skills =
  role_default_skills
  ∪ enabled ready personal uploaded/generated Skills
  ∪ enabled ready marketplace Skills still allowed by effective role grants
```

Do **not** auto-activate every optional role Skill. Optional grants mean
"visible/installable"; they become active only after the user installs/enables
the Skill. Role reset must not accidentally drop user-uploaded/generated
personal Skills from `agent.skills`, but it must remove or deactivate
marketplace business Skills that are no longer allowed by the new role.

MCP stays stricter than Skill activation: effective MCP servers are always the
role resolver output. A personal uploaded Skill can call only MCP servers already
allowed for that Agent's role; it cannot expand MCP permissions.

For non-Codex runtime paths:

- Short term: MCP servers must authorize by trusted OpenClaw context, especially `_meta.openclaw.agentId`.
- Long term: patch OpenClaw embedded/bundle MCP loading to support a runtime-agnostic field such as:

```json
{
  "mcp": {
    "servers": {
      "wealth_assistant_customer": {
        "openclaw": {
          "agents": ["trial_lgc-xxx"]
        }
      }
    }
  }
}
```

The long-term patch should make generic MCP runtime filtering behave like the Codex `codex.agents` projection.

## MCP Data Authorization

Per-agent MCP filtering controls whether a model can see or call a tool. It does not decide which business rows the tool returns.

For data-sensitive MCPs, the MCP service should receive or resolve trusted context:

```text
MCP receives _meta.openclaw.agentId
-> MCP resolves agentId to real user or service identity
-> MCP/data service applies row-level authorization
-> MCP returns only authorized data
```

The model must not be trusted to pass user id, employee id, customer id ownership, or data scope.

## Audit Requirements

For bank-facing usage, audit should capture:

- Actor user id/name.
- Agent `adoptId` and runtime Agent id.
- Selected role template.
- MCP server and tool name.
- Skill id for Skill operations.
- Whether the tool was allowed or denied by role policy.
- Business-sensitive request summary after redaction.
- Result status, duration, and error code.

This makes it possible to answer: who used which role, which Agent used which MCP, whether the call was allowed, and what data domain was involved.

### Current State vs Gaps (updated 2026-06-18)

The audit requirements above are the target. Actual coverage today is partial:

| 能力 | 现状 | 证据 |
|---|---|---|
| Skill/exec 调用 | ✅ 已落库 | `tool_execution_audits` 记录 `user_id` / `agent_id` / `original_tool_name`(exec) / `command` / `args` / `policy_decision`(allow/deny/rewrite) / `exit_code` / `created_at`，覆盖多个 trial agent，最近写入 2026-06-16。 |
| Skill 作为一级单元 | ✅ 已接 | OpenClaw trajectory 审计会在 `tool.call.arguments` 命中 Skill 路径或显式 `skillId` 时额外落 `skill.invoked`；jiuwenswarm WebChannel 的 `chat.tool_call` 也会按同一规则落 `skill.invoked`。 |
| MCP 工具调用 | ✅ 已接 | EA 侧 MCP adapter 记录 `mcp.tool.*`；`/api/claw/audit/mcp-tool` 可接收业务 MCP 回写；OpenClaw trajectory 与 jiuwenswarm WebChannel 会把已知业务工具名映射为 MCP server 并落 `mcp.tool.*`。 |

一句话：**审计主链已经具备 Skill / MCP 的一级事件入口；P5 剩余风险在覆盖面，不在数据模型。**

### Invocation Capture — Plan

1. `skill.invoked` 一级事件：在技能执行入口（exec 命令命中 `skills/<name>/` 或技能 router）落一条带 `skill_id` / `role` / `user_id` / `agent_id` 的事件，不再依赖反推。
2. MCP 调用纳入审计：见下方「Recording Location」。每次 MCP 调用落 `mcp.tool.started/completed/failed`，含 `mcp_server` / `tool_name` / `user_id` / `agent_id` / `decision` / `duration` / `error_code`。
3. 两者复用现有 `audit_events` / `tool_execution_audits` 表结构与 `recordAuditBestEffort` 框架，不新建并行体系。

### Recording Location: EA vs MCP server

决策：**捕获在 MCP adapter 层（贴近调用），但权威记录与聚合在 EA 中心审计库。** 不把权威审计/计数分散到各 MCP server。

理由：

- **第三方 MCP（Wind、盈米）无法插桩**——只有让它们经过我们的 adapter/代理才看得到调用；自记录方案对它们天然失效。
- **身份解析在 EA**：MCP server 只拿到 `_meta.openclaw.agentId` / `x-linggan-agent-id`，真实 `user_id` 由 EA 用 agentId 反查。权威"谁调用"必须在 EA 侧补全身份。
- **合规要单一可信源**：审计要一个防篡改、可统一查询的库，而非 N 份分散日志。
- **跨 MCP 聚合**：调用次数本来就要跨 server 汇总，集中在 EA 更自然。

落地形态：

- 本地 adapter（bond / insurance_kb / wealth_assistant / group_insurance / credential / telesales）已是每个 MCP 的天然 chokepoint，由 adapter 向 EA 审计 ingestion 端点 POST 事件。
- 当前直连、未经 adapter 的 MCP（Wind / 盈米）应统一前置一层 thin pass-through adapter，使每个业务 MCP 都有捕获点（顺带统一鉴权头/凭证注入，和 credential-skills-adapter 一致）。
- MCP server 可保留自身运维日志，但**审计与调用计数的 source of truth 是 EA**，不以第三方/自报为准。

### Marketplace Invocation Count

技能市场卡片除已有「安装数」(`skill_marketplace.download_count`) 外，新增「调用数」：

- Skill 调用数：从 `skill.invoked` 事件按 `skill_id` 聚合。
- MCP 调用数：从 MCP 审计事件按 `mcp_server` / `tool_name` 聚合。
- MVP 先由中心审计表实时聚合返回给市场接口；后续访问量上来后再改为 rollup 计数（同 download_count 思路），由中心审计流增量更新或批量聚合。无论实时聚合还是 rollup，**展示口径和审计口径保持同源**。

## Runtime Strategy: jiuwenswarm-primary

EA is pivoting to make **jiuwenswarm (jiuwenclaw)** the primary runtime, with
OpenClaw kept as secondary. This section records how the role-based design maps
onto jiuwenswarm and the development plan.

### Local baseline and model auth (2026-06-18)

- Local jiuwenswarm is installed editable from `/home/ubuntu/jiuwenclaw-upstream`
  at develop commit `f538993e` into venv
  `/home/ubuntu/.venvs/jiuwenswarm-022-f538`. The package version still reports
  `0.2.2`; use the commit hash as the local engineering baseline.
- Runtime home is `/home/ubuntu/.jiuwenswarm`. The local service is started via
  `python -m jiuwenswarm.app` and listens on AgentServer `127.0.0.1:18092`,
  WebChannel `127.0.0.1:19000/ws`, and ACP/TUI `127.0.0.1:19001`.
- Local model smoke passed with Huawei MaaS `glm-5.1`; WebChannel smoke produced
  streaming `chat.delta` and `chat.final` frames. The web frontend `dist` is not
  built locally, so `jiuwenswarm-start all` is not the expected validation path
  until frontend assets are built.
- Patch 1 / Patch 2 have been re-ported locally on 2026-06-18 (see
  `docs/JIUWENSWARM_PATCHES.md`). Source-level checks passed for
  `streamable-http` config and connection-level `x-linggan-agent-id` /
  `x-jiuwen-channel-id` injection for `user_context: true` MCP servers. Wealth
  assistant v2.1 customer and product MCPs passed direct HTTP smoke with
  `x-linggan-agent-id=jiuwen_lgj-liwenhua`.
- Do **not** inject internal identity fields such as `__jiuwen_channel_id` into
  LLM-visible tool arguments. openjiuwen validates tool arguments against the
  MCP tool schema before calling the MCP server; hidden extra fields cause
  Pydantic `extra_forbidden` failures and the tool never reaches the server.
  Trusted identity must travel through runtime-controlled headers / server-side
  context, not model-controlled arguments.
- Full role-based new-agent provisioning plus LLM tool-call E2E passed locally on
  2026-06-18 for a temporary `lgj-p2e2e*` wealth-manager Agent. New-agent
  jiuwenswarm provisioning is still feature-flagged until the same smoke is
  repeated in the target environment and MCP data authorization is accepted.
- The checked upstream has tags such as `JiuwenSwarm0.2.2`; no literal `0.22`
  tag was present. Treat "0.22" references as the 0.2.2 line unless product
  confirms a different release artifact.
- Latest upstream still rejects `streamable-http` in `interface_deep.py` and
  still lacks trusted request-level channel injection in `stream_event_rail.py`.
  Therefore the MCP transport patch and MCP identity-injection patch are still
  required before jiuwenswarm can safely host our business MCPs.
- jiuwenswarm does **not** reuse OpenClaw/Codex authentication. OpenClaw/Codex
  uses per-agent auth state such as `openclaw-agent.sqlite`; jiuwenswarm reads
  its own `config.yaml` / process environment (`API_KEY`, `API_BASE`,
  `MODEL_NAME`, `MODEL_PROVIDER`) or `models.defaults[].model_client_config`.
- EA must provision or reference jiuwenswarm model credentials from a
  platform-controlled secret/config path. Creating a `lgj-*` Agent must not
  depend on OpenClaw's Codex auth store. For GPT-5.5, provider naming should be
  `openai`, not historical `openai-codex`.

### Compatibility assessment (verified against source 2026-06-21)

jiuwenswarm 0.2.2 is installed editable from `/root/jiuwenswarm-upstream-src`
(Shanghai) and `/home/ubuntu/jiuwenclaw-upstream` (local). Assessment by layer:

- **Platform layer: already runtime-agnostic.** EA treats jiuwenswarm (`lgj-*`)
  as a first-class runtime — `isJiuwenClawAdoptId`, `jiuwenclaw-bridge.ts`, the
  jiuwen cron provider, and `skill-registry` (jiuwen skills resolve to
  `jiuwenClawWorkspaceDir`, not `.openclaw`). The role template, role lifecycle,
  audit-at-adapter, marketplace, and admin UI are all runtime-agnostic.
- **Skill isolation: supported.** jiuwenswarm has per-agent/user
  skill directories — `get_agent_skills_dir()` / `user_skills_dir` in
  `skill_manager.py`, separate from builtin, with its own `_marketplace` dir and
  `skills_state.json`. `skill_mode: auto_list` is the current EA integration
  default so ordinary chat does not load every installed Skill. Role-based Skill
  allow-listing works by controlling what is installed in the agent's skill dir —
  conceptually the same as OpenClaw, different path.
- **MCP transport: works only with our patches.** Upstream jiuwenswarm rejects
  `streamable-http` MCP; our local patch (see `docs/JIUWENSWARM_PATCHES.md`,
  Patch 1) normalizes it and wires `auth_headers`. Without it, no business MCP
  connects on jiuwenswarm.
- **MCP per-user data isolation: works only with our patches.** Patch 1#3
  injects runtime-controlled `x-linggan-agent-id` / `x-jiuwen-channel-id` headers
  for `user_context: true` MCP servers. Patch 2 must preserve that trusted
  context through the request lifecycle without adding hidden fields to tool
  arguments. This is the data-side enforcement the *MCP Data Authorization*
  section depends on.
- **MCP progressive disclosure: enabled.** jiuwenswarm `progressive_tool.enabled`
  is on with `max_loaded_tools=8`. The initial model context exposes
  `search_tools` / `load_tools` and a small visible set; business MCP tools are
  loaded on demand. This is not the authorization boundary, but it avoids the
  OpenClaw-style all-schema token blow-up for ordinary chat.
- **MCP per-agent gating: enforced by provisioning + service-side auth.** EA
  provisions per-role MCP config into each `lgj-*` Agent and still relies on
  runtime-controlled `x-linggan-agent-id` / `x-jiuwen-channel-id` headers plus
  MCP service-side authorization for data isolation. The progressive tool
  mechanism is a context/token optimization, not a substitute for grants.
- **SwarmFlow: useful for controlled multi-step role workflows, not for every
  chat.** The 0.2.2 line includes Team-mode SwarmFlow (`enable_swarmflow`
  defaults true under `modes.team`): a leader starts a workflow through
  `SwarmflowTool`, then `WorkflowMonitorHandler` emits `workflow.updated` events
  with workflow / phase / agent state. This is a real runtime capability, not
  only TUI decoration. EA should use it for complex, auditable role workflows
  such as research report generation, group insurance audit, post-loan risk
  review, and wealth proposal preparation. Simple one-turn chat should stay in
  fast agent mode to avoid extra planning and latency.

### SwarmFlow integration notes (2026-06-17)

Source verified in `/home/ubuntu/jiuwenclaw-upstream`:

- Documentation: `docs/zh/TUI使用SwarmFlow指南.md` / `docs/en/TUISwarmFlowGuide.md`.
- Runtime config: `jiuwenswarm/resources/config.yaml` has
  `modes.team.jiuwen_team.enable_swarmflow: true`.
- Runtime event bridge: `team_helpers.py` starts `WorkflowMonitorHandler` when
  SwarmFlow is enabled and broadcasts `workflow.updated` deltas.
- State schema: `workflow_state.py` tracks workflow `running/completed/failed`,
  phase state, agent state, prompts, outcomes, logs, duration, and final result.
- Snapshot command: `command.workflows` returns `workflow_run_snapshot`, so EA
  can restore/refresh the right-side workflow panel.

How EA should use it:

1. Keep role provisioning based on the runtime adapter. SwarmFlow is a **mode /
   execution strategy** inside jiuwenswarm, not a separate runtime.
2. Add role-level execution policy later, e.g. `executionMode:
   "fast" | "team-swarmflow" | "template-workflow"`. MVP default stays `fast`.
3. Enable SwarmFlow only for roles/tasks that naturally need stages and
   evidence: `investment-researcher`, `wealth-manager`,
   `post-loan-risk-control`, `credential-compliance`, and `insurance-advisor` batch/report workflows.
4. Surface `workflow.updated` in EA. Current `jiuwenclaw-bridge.ts` wraps unknown
   jiuwen custom events as `jiuwen_event`, and the frontend parser does not yet
   convert `workflow.updated` into a first-class `ChatEvent`. This is a required
   P2/P3 UI integration item.
5. Persist workflow snapshots and include them in audit. For regulated workflows,
   `workflow.updated` should become the stage-level audit backbone: phase,
   agent, prompt, outcome, error, duration, and final result.
6. Do not use SwarmFlow as the first mechanism for MCP permissioning. It helps
   orchestrate work; MCP allowlist and data isolation must still be enforced by
   the role runtime adapter and MCP service-side authorization.

### Runtime policy for new Agents

- The machine-readable baseline currently sets `runtimePolicy.defaultRuntime =
  openclaw` and `runtimePolicy.fallbackRuntime = openclaw`.
- Apply flow: users choose role, not runtime. The backend resolves the role
  template and provisions an OpenClaw Agent by default while JiuwenSwarm
  per-agent MCP isolation remains pending.
- Admin override: operations can keep or move a specific Agent to OpenClaw for
  compatibility, regression comparison, or runtime-specific debugging.
- Existing OpenClaw Agents are not forcibly migrated by this policy. They should
  be reconciled only when an admin explicitly changes runtime or role.

### Code & repo strategy

- **One repo, runtime adapter — do not fork.** EA code is already branching on
  runtime; formalize a runtime-adapter interface with `openclaw` and
  `jiuwenswarm` implementations rather than forking a jiuwenswarm-only repo
  (forking would duplicate the role/audit/marketplace work and diverge). "Primary
  jiuwenswarm" does not mean OpenClaw is removed; even if it were, deleting one
  adapter is cleaner than maintaining two repos.
- Adapter surface (4 methods, 2 implementations): **provisioning**, **per-agent
  Skill scoping**, **per-agent MCP gating**, **audit hook**. Skill scoping for
  jiuwenswarm = write the role's Skills into `get_agent_skills_dir()`; the
  `claw-provision.sh` OpenClaw-only path needs a jiuwen branch.

### Dev environment & patch sequence

- Develop and verify patches locally first, then sync Shanghai in a single
  controlled pass. Shanghai is production-like and should not be the first place
  to discover patch conflicts.
- **Precondition:** jiuwenswarm runtime patches are captured in
  `docs/JIUWENSWARM_PATCHES.md`. Before each jiuwenswarm upgrade, compare Patch 1
  (streamable-http + trusted headers), Patch 2/2b (tool event / argument
  normalization), and Patch 4 (progressive tool config) against upstream.
- Sequence: local source update + re-port patches → local smoke → Shanghai sync
  + service restart → EA frontend/runtime smoke.

## OpenClaw Upgrade Posture

The current OpenClaw upgrade risk is materially lower than the earlier phase,
because two previously risky areas have been reduced or isolated:

- Codex WSS streaming still requires a small OpenClaw Codex runtime patch in
  `@openclaw/codex@2026.6.8`: forward assistant delta events on the `assistant`
  stream and suppress duplicate terminal assistant text. This is documented in
  `../OPENCLAW_RUNTIME_PATCHES.md`. The patch is now isolated and repeatable,
  rather than an untracked fork.
- Stdio MCP has been removed from the primary business MCP path. Wind, Qieman,
  bond quote parsing, credential tools, wealth assistant, and group insurance
  audit are now modeled as HTTP/streamable-http MCP or platform tools. This
  avoids the old per-call stdio process/resource pressure.

Upgrade still needs validation around the interfaces we actively depend on:

- `openclaw.json` path and schema compatibility, especially `agents.list`,
  `workspace`, `skills`, `tools.alsoAllow`, `tools.sandbox.tools.alsoAllow`, and
  `mcp.servers`.
- Trusted runtime context propagation to MCP handlers, especially
  `_meta.openclaw.agentId`, `sessionKey`, `sessionId`, and `workspaceDir`.
  Data-sensitive MCP services must not depend on user-supplied ids.
- Per-agent MCP projection behavior. Codex app-server projection through
  `mcp.servers.*.codex.agents` is present in OpenClaw 2026.6.8
  (`bundle-mcp-codex` filters by agent id). It should still be covered by a smoke
  test before role-based MCP filtering is enabled in Shanghai.
- Gateway streaming events used by Workforce Agent Platform desktop/web paths, including
  assistant deltas, tool start/result events, terminal done/error events, and
  idle timeout behavior.
- Skill runtime loading: whether changes to `agents.list[].skills` and workspace
  skill folders require gateway restart or can be hot reloaded.
- MCP server transport compatibility for `streamable-http` and any OpenAI-style
  HTTP/SSE fallback paths.
- Qieman is intentionally treated as a high-cardinality MCP. Its raw server
  exposes 69 tools, so it is not part of default role grants. Revisit only when
  there is a concrete requirement and a slim/proxy surface is available.

Recommended sequence for the three environments:

1. First synchronize Workforce Agent Platform code and configuration across local,
   Shanghai, and Singapore experiment environments. Do not upgrade OpenClaw while
   EA code/config are divergent; otherwise failures cannot be attributed cleanly.
2. Freeze and back up current `openclaw.json`, `.env`, workspace directories,
   PM2 process list, and approved Skill/MCP catalog in each environment.
3. Upgrade Singapore experiment first. This was validated on 2026-06-17 for
   OpenClaw/Codex 2026.6.8, including auth SQLite migration and WSS streaming
   after the assistant-delta patch.
4. Run a fixed smoke suite in Singapore:
   - plain chat streaming
   - tool-call card rendering
   - web search / browser tool if enabled
   - Wind/Qieman public data MCP
   - bond quote parse MCP
   - credential MCP
   - group insurance audit MCP
   - wealth assistant MCP, including agentId/context propagation
   - Skill install/uninstall and marketplace install
   - file list/download if enabled
   - desktop connection if the desktop build points at the environment
5. Only after Singapore passes, upgrade local for developer parity and debugging.
   Local was also upgraded to OpenClaw/Codex 2026.6.8 on 2026-06-17 with the
   same assistant-delta patch.
6. Upgrade Shanghai last, during a planned maintenance window, with a rollback
   bundle ready: previous OpenClaw package/version, previous `openclaw.json`, and
   PM2 restart commands.

Do not upgrade Shanghai first. The expected remaining risks are schema/event
drift, trusted-context drift, role/MCP permission semantics, and forgetting to
re-apply the small Codex WSS assistant-delta patch after plugin upgrades.

## Implementation Plan

1. Treat `docs/design/role-skill-mcp-baseline.json` as the runtime-owned role catalog and seed source. Validate it with Zod at server boot and fail fast on duplicate role keys, unknown runtimes, unknown visible zones, or missing `general-assistant`.
2. Add `roleTemplate`, `industry`, and `runtime` fields to child Agent adoption/profile storage. Keep `permissionProfile` as the sandbox/privilege tier.
3. Add role selection to the Agent application UI. The default selection is `general-assistant`, and new Agents are provisioned on OpenClaw by default until JiuwenSwarm per-agent MCP isolation is implemented and validated.
4. Introduce a runtime-adapter interface: `provision`, `reconcileSkills`, `reconcileMcp`, `bumpSessionEpoch`, and `audit`.
5. Add a role asset grant resolver backed by DB `role_asset_grants`. Runtime adapters consume the resolver's effective `default`/`optional` Skill/MCP set; they do not read static `allowedSkills` as long-term authority.
6. Implement the jiuwenswarm adapter first: create `lgj-*` Agents, write role default Skills into the per-agent jiuwenswarm skill directory, and pass trusted identity context into MCP calls.
7. Implement MCP gating for jiuwenswarm by service-side authorization first; if jiuwenswarm later exposes native per-agent MCP projection, wire the effective MCP grants into that native mechanism.
8. Keep the OpenClaw adapter as fallback: write Agent `skills`, link only allowed shared Skills, and maintain `mcp.servers.*.codex.agents`.
9. Filter `/api/claw/mcp-tools/status` by the selected role's effective MCP grants.
10. Filter Skill marketplace/list/toggle/install APIs by the selected role's visible zones and effective Skill grants.
11. Reject Skill enable/install requests if the Skill is outside the Agent role, unless it is an audited admin exception.
12. Add a **role reset mode** for role change: recompute grants from the new role and overwrite active Skill/MCP exposure. Fine-grained deactivate-don't-delete reconcile is deferred.
13. Admin UI (实例管理 in `ClawAdmin.tsx`): rename the existing "角色" column to 权限档 (it renders `permissionProfile`), add a 岗位 column whose change triggers role reset; reuse `adminUpdate`/`adminBatchUpdate` with a new role field.
14. Add runtime override in admin only. End users choose role, not runtime.
15. Add audit fields/events for role policy decisions, role changes/resets, and effective Skill/MCP allowlists.
16. MCP invocation audit: capture at the MCP adapter layer, record authoritatively in EA (`mcp.tool.*`); front direct MCPs (Wind/Qieman) with a pass-through adapter so every business MCP has a capture point.
17. First-class `skill.invoked` audit event (`skill_id`/`role`/`user`/`agent`), replacing command-path inference.
18. Marketplace invocation count: rollup from the central audit (by `skill_id` / `mcp_server`), shown alongside install count and from the same source as compliance audit.
19. jiuwenswarm patches extracted and documented in `docs/JIUWENSWARM_PATCHES.md` (done).
20. Stand up jiuwenswarm **0.2.2** in a clean dev env (local; Singapore for validation), re-port the patches per `docs/JIUWENSWARM_PATCHES.md`, and validate streamable-http MCP + per-user channel isolation before Shanghai.
21. Dynamic role–asset association (见 *Dynamic Role–Asset Association*): seed JSON → DB `role_asset_grants`；后续发布/后台打标签只写 DB grant，effective list 只从 DB grant 解析。
22. 发布/后台打标签 UI：上线技能/MCP 时设置多个岗位（含 `*`/general 通用标记）和 `grantMode`，写 DB 即时生效；`optional` 不强制自动装进存量 Agent。

## Development Plan (Phased)

阶段化执行计划，把上面步骤归入 P0-P7。状态：✅ 完成 / 🔵 进行中 / ⬜ 未开始。
每个阶段先列阶段目标，再逐步给目标 + 验收。阶段之间有依赖：P1 → P2/P3 → P4 → P5 → P6 → P7。

### P0 — 设计与决策（地基）｜状态 ✅

目标：把岗位权限设计、机读基线、运行时方向、补丁、关键决策全部对齐定稿。

| 项 | 目标 | 验收 | 状态 |
|---|---|---|---|
| 设计归口 | 单一归口文档 + JSON + schema | 三者一致、自洽校验 0 错误 | ✅ |
| 关键决策 | MCP 硬边界/技能停用不删/审计归口 EA/deny-by-default 等 | 写入 Resolved Decisions | ✅ |
| Step 19 补丁文档 | jiuwen 补丁可还原可升级 | `JIUWENSWARM_PATCHES.md` 含 transport/user-context、tool event、argument normalization、progressive tool、业务 MCP 热修记录 | ✅ |

### P1 — 岗位数据模型与基线注册（无强制，先打底）｜状态 🔵

目标：后端有类型安全、启动校验的岗位注册表；DB 能存 agent 的岗位/运行时；技能 role_tag 规整到 canonical。

| 步 | 目标 | 验收 | 状态 |
|---|---|---|---|
| 1 | 运行时直读 baseline + Zod 启动校验 | 坏数据（重复 key/未知 runtime/缺 general-assistant）启动即失败；loader 单测覆盖 | ✅ |
| 2 | `roleTemplate`/`industry`/`runtime` 入库 | 能读写某 agent 的岗位与运行时，`permissionProfile` 保持独立 | ✅ |
| (OQ) | `skill_marketplace.role_tag` 规整 SQL | review-only SQL 草案已写，待上海受影响行确认后执行；`insurance-claims` 待决 | 🔵 |
| — | general-assistant 进 JSON | 默认角色存在、自洽 | ✅ |

**P1 Review 结论（2026-06-17）**

实现位置 / 质量：
- 加载器 `server/_core/role-templates.ts`：Zod 全枚举校验 + 重复角色 id、默认角色必须在 `industries.general` 下等自定义检查；`server/_core/index.ts` 顶层调用 → **启动即 fail-fast**。实测真实 JSON 解析通过（10 岗位）。
- 单测 `server/_core/role-templates.test.ts`：用 `ROLE_SKILL_MCP_BASELINE_PATH` 临时文件隔离，覆盖缺默认角色 / 未知 runtime / 跨行业重复 id / 未知请求 id 全部 fail-fast 路径。
- DB：migration `drizzle/migrations/0017_add_claw_role_template.sql` 加 3 列并按 adoptId 前缀回填 runtime（`lgj-`→jiuwenswarm / `lgh-`→hermes）；`server/db/claw.ts` + `server/routers/claw.ts` 已接线读写，并新增 `claw.roleTemplates` 列表接口。

迁移运维注意（**重要**）：
- `drizzle/migrations/*.sql` 不在 `drizzle/` 的 journal 内 → `db:push` / `drizzle-kit migrate` **不会自动执行 0017/0018**，需手动 apply。
- **0017 必须在每个环境手动 apply**（local + Shanghai）；否则 `roleTemplate` 列缺失会导致 `db/claw.ts` 查询报错。
- **0018 是 review-only 预览，纯 SELECT、零修改**（备份表与真正 UPDATE 延后到「正式 apply migration」）：在生产库（上海 MySQL `finance_ai`，脏数据唯一所在）跑该 SELECT，产出「按 `skill_id` 的建议 `suggested_role_tag` + 受影响行」清单，人工核对后再写正式 apply migration（建备份表 → 按 skill_id 精确 UPDATE）。
- 已决策（见下 dry-run 段）：`insurance-claims` 当前并入审核专员；其余按 skill_id 精确映射，不按旧标签一刀切。

runtime 默认值过渡：DB 列 `runtime` 默认 `openclaw`，JSON `defaultRuntime=openclaw`。JiuwenSwarm adapter 已能 provision，但 MCP 仍是服务级全局注册；待 per-agent MCP allowlist 实现并验证后，再评估是否把默认运行时翻转为 jiuwenswarm。

**P1 role_tag dry-run（2026-06-17，只读，未改任何数据）**

对上海生产库 `finance_ai.skill_marketplace` 做只读查询，受 0018 影响的 5 个旧 role_tag 共 7 行：

| id | skill_id | 名称 | 当前 role_tag | origin | 作者 | 处理 |
|---|---|---|---|---|---|---|
| 56 | credential-prompt-generator | 凭证要素提取提示词生成 | compliance | squad | 邱月琼 | → `credential-compliance` ✅ 干净 |
| 58 | goldencoach-stage-evaluation | 智能陪练阶段点评 | sales-coaching | squad | 赵印伟 | → `insurance-advisor` ✅ 并入保险顾问 |
| 69 | loan-risk-monitor | 贷后风险监测 | credit-risk | opensource | 阿里点金 | → `post-loan-risk-control` ✅ 对 |
| 70 | kyc-doc-parse | KYC文件解析 | credit-risk | opensource | Anthropic | → `credential-compliance` ✅ 按 KYC/文档解析归入凭证合规 |
| 71 | dd-checklist | 尽职调查清单 | credit-risk | opensource | Anthropic | → `post-loan-risk-control` ✅ 先归贷后/风控尽调场景 |
| 67 | health-verification | 核保健康告知辅助 | insurance-underwriting | opensource | 阿里点金 | → `insurance-advisor` / `credential-compliance` 待按用途复核 |
| 63 | insurance-claim-fraud-detection | 理赔欺诈风险检测 | insurance-claims | opensource | 阿里点金 | → `credential-compliance` ✅ 并入审核专员 |

**关键结论：0018 的「旧标签→新标签」批量改名不成立，必须按 `skill_id` 精确映射。** `credit-risk` 下实际混有贷后/KYC/尽调，`insurance-underwriting` / `insurance-claims` 当前都并入审核专员，后续成规模再拆。

**已拍板（2026-06-17）：**
1. `kyc-doc-parse` → `credential-compliance`
2. `dd-checklist` → `post-loan-risk-control`
3. `health-verification` → `insurance-advisor` 或 `credential-compliance`（按最终用途复核）
4. `insurance-claim-fraud-detection` → `credential-compliance`

**后续动作：** 把真正执行用的 migration 写成「按 `skill_id` 精确映射」，先建备份表（需先确认），再执行 UPDATE。`insurance-claims` 不再作为独立岗位进入 baseline；当前作为审核专员下的可选能力。

**⏳ 待执行决策点（P1 收尾，阻塞 P1 → ✅）**

决策内容已全部拍定（上面 4 项 + 按 skill_id 精确映射）。剩下的是**一个需要人工放行的生产数据写操作**：

- 动作：写正式 apply migration（`0019_apply_role_tag_canonicalization.sql`）= 建带日期备份表 → 按 `skill_id` 精确 `UPDATE` 那 7 行 → 上海生产库执行。
- 放行流程（与既有边界一致）：先对该 apply migration 做 **dry-run 预览**（展示「将建的备份表内容 + 将改的具体行 old→new」），**人工确认后**再真正执行 `UPDATE`。建备份表本身也需先确认。
- 选项：
  - A. 现在写 apply migration + dry-run，确认后执行 → P1 转 ✅。
  - B. 暂挂此执行项（role_tag 漂移不阻塞 P2：岗位→资产的运行时权威源将是 DB `role_asset_grants`，
    `skill_marketplace.role_tag` 只保留为展示/反查主岗位），先推进 P2，待上线前再统一执行。
- 当前状态：**未写 apply migration、未建备份表、未执行任何 UPDATE**；等本决策点放行。

### P2 — 运行时 adapter + jiuwenswarm 执行（pivot 核心）｜状态 🔵

目标：岗位驱动的 provisioning 在 jiuwenswarm（主）跑通，OpenClaw 作 fallback。

| 步 | 目标 | 验收 | 状态 |
|---|---|---|---|
| 4 | runtime-adapter 接口（provision/reconcileSkills/reconcileMcp/bumpSessionEpoch/audit） | 接口定义 + 两实现骨架；adopt 入口已通过 provision plan 选择 runtime | ✅ |
| 4a | role asset grant resolver + seed sync | 表结构、migration、resolver、seed sync preview/apply 后端入口已实现并有单测；本地已 apply migration + seed 61 条；其他环境仍需按部署顺序执行 | ✅ |
| 20 | 本地起 jiuwenswarm 0.2.2 + 移植补丁 + SwarmFlow 冒烟 | 本地 develop `f538993e` + GLM 基础流式已跑通；Patch 1/2/2b 已 re-port；progressive tool 已打开；财富助手 v2.1 streamable-http MCP 直连和 local WebChannel smoke 已通过；Team mode `workflow.updated` 仍待专项端到端冒烟 | 🔵 |
| 5 | jiuwen adapter：建 `lgj-*`、按 resolver 的 default grants 写技能到 per-agent 目录、注入可信身份 | EA 侧已写 per-agent role scope manifest；本地 adapter smoke 已验证 `lgj-*` workspace、财富经理默认 Skill 链接、MCP allowlist manifest；2026-06-18 本地 LLM tool-call E2E 已验证财富助手 MCP 查询客户清单可返回客户数据并完成 GLM-5.2 续写 | ✅ |
| 5a | 翻转新建 Agent 默认 runtime | P1 过渡期 DB 默认/实际 provision 仍为 `openclaw`；P2 adapter 可用后，新建 Agent 改为 `jiuwenswarm`，DB 默认值同步翻转 | ⬜ |
| 6 | jiuwen MCP 门控（先服务端鉴权，后原生投影） | role scope manifest 已记录 MCP allowlist；非本岗位 MCP 工具不可调仍待 MCP 服务端按 agent/user context 强制 | 🔵 |
| 7 | OpenClaw adapter 作 fallback | 旧 `lgc-*` 路径仍工作（skills + codex.agents） | ✅ |
| 7a | SwarmFlow 事件接入 EA | `workflow.updated` 已转成一等 `ChatEvent`；复杂岗位任务阶段/Agent 进度的 UI 渲染仍待后续 | 🔵 |

**P2 Step 4 实现说明（2026-06-17）**

- 新增 `server/_core/role-runtime-adapter.ts`：定义统一 adapter 合同，包含 `provision`、`reconcileSkills`、`reconcileMcp`、`bumpSessionEpoch`、`audit`，并提供 `resolveRoleRuntimeProvisionPlan()`。
- 新增 `server/routers/role-runtime-adapters.ts`：OpenClaw adapter 包装现有 `provisionEmployeeAgentInstance()`；jiuwenswarm adapter 在 provision 开关打开后创建 per-agent workspace，未打开时仍回退 OpenClaw，不会误创建。
- `claw.adopt` 不再硬编码 OpenClaw：先根据岗位模板生成 provision plan，再决定 `lgc-*` / `lgj-*`、`agentId`、DB `runtime` 和审计字段。
- 当前默认仍为安全过渡：`JIUWENSWARM_PROVISION_ENABLED` / `JIUWENCLAW_PROVISION_ENABLED` 未开启时，岗位模板即使写 `runtime=jiuwenswarm`，实际也会 fallback 到 OpenClaw，并在审计 metadata 记录 `requestedRuntime`、`actualRuntime`、`runtimeFallbackReason`。
- 2026-06-18 本地已临时打开 `JIUWENSWARM_PROVISION_ENABLED=true` 做 E2E，并在验证后收回：
  财富经理岗位的 Skill/MCP 解析、jiuwenswarm workspace 写入、财富助手 MCP 调用和 GLM-5.2
  续写均已通过。默认 provisioning 仍保持 feature-flag，是为了先在目标环境复测和确认 MCP
  服务端数据授权策略。
- 2026-06-18 决策更新：jiuwenswarm 已作为新建 Agent 默认 runtime 正式打开。
  `JIUWENSWARM_PROVISION_ENABLED=true` 后，新建自助申请将创建 `lgj-*`
  jiuwenswarm Agent；OpenClaw 保留为存量兼容和管理员 fallback。业务数据 MCP 不再因为
  runtime 默认切换而放宽权限，仍必须由 MCP 服务端按 agent/user/channel 强制鉴权。
- 已补 `server/_core/role-runtime-adapter.test.ts`，覆盖 jiuwenswarm 未启用回退、启用后选择 jiuwenswarm、强制 runtime override 三条路径。

**P2 Step 5/6/7/7a 实现说明（2026-06-18）**

- 新增 `server/_core/jiuwenswarm-role-scope.ts`：EA 侧会在 jiuwenswarm workspace 写
  `.linggan-role-scope.json`，内容包含岗位、effective Skills、effective MCP servers 和执行边界。
  该 manifest 是 jiuwenswarm 启动器/运行时后续消费的单一岗位资产输入。当前本机 jiuwenswarm
  基础流式已跑通，adapter smoke 已能创建 per-agent workspace 并写入 role scope。
- jiuwenswarm adapter 已按 resolver 的 default Skill grants 维护 per-agent `skills/` 目录：
  当前从 `.openclaw/skills-shared/` 与 `.openclaw/skill-market/approved/` 两类来源查找并建立软链，
  不在岗位授权内且由这些来源管理的 skill 链接会被移除。2026-06-18 本地 smoke 已验证
  `wealth-manager` 6 个默认 Skill 能完整链接到 `lgj-*` workspace。
- OpenClaw fallback 已接入 resolver：`reconcileSkills()` 会维护 `openclaw.json` 中
  `agents[].skills` 和 `mcp.servers.*.codex.agents`，并按岗位同步/移除 workspace 下的 shared skill
  链接。MCP 粒度按 server 级处理，子工具级授权留到 future。
- jiuwenswarm MCP 门控当前采用“manifest + MCP 服务端鉴权”的设计：EA 记录岗位允许的 MCP server，
  但真正的数据/工具越权拦截必须由 MCP server 根据 agent/user context 执行。
- 2026-06-18 本地 LLM tool-call E2E 结论：临时 `lgj-p2e2e*` 财富经理 Agent 能完成
  DB adoption、workspace、默认 Skill 链接、MCP allowlist manifest、`glm-5.2` 推理、
  `mcp_wealth_assistant_customer_wealth_assistant_context_probe` /
  `wealth_assistant_customer_list` 调用，并返回前 3 位客户（张伟、李娜、王强）。
  已确认失败根因不是 EA resolver 或财富助手 MCP 服务，而是内部 `__jiuwen_channel_id`
  曾被注入到 tool arguments，触发 openjiuwen schema 校验 `extra_forbidden`。修复原则：
  可信身份走 `x-linggan-agent-id` / `x-jiuwen-channel-id` 等 runtime-controlled header，
  不进入 LLM-visible tool arguments。
- EA bridge 已补错误透传：`chat.error` 的 `content/error` 会透出到前端，避免只显示
  `jiuwenclaw runtime error`。
- `jiuwen_event` 中的 `workflow.updated` 已在 `client/src/lib/chat-event-parser.ts` 提升为
  `workflow.updated` ChatEvent。UI 阶段进度条/多 Agent 进度展示不属于本次权限主链，后续单独做。
- 测试覆盖：`role-asset-grants`、`openclaw-role-scope`、`jiuwenswarm-role-scope`、
  `role-runtime-adapter`、`chat-event-parser`；`pnpm run check` 已通过。

**P2 deployment guardrail**

- Deploy order is mandatory: apply migration `0019_add_role_asset_grants.sql` →
  immediately run admin `roleAssetSeedSync` → then enable role-based
  provisioning. Migration `0019` only creates the table; it does not seed rows.
- To avoid a bad rollout window, resolver behavior is:
  - DB/table unavailable → fallback to JSON seed.
  - `role_asset_grants` table exists but has **zero rows globally** → fallback
    to JSON seed and log a warning. This protects the “migration applied but seed
    sync not yet run” window.
  - Table has rows globally, but the requested role resolves to zero rows → trust
    DB and return zero assets. This preserves the semantics of deliberately
    clearing or disabling a role grant.

### P3 — 申请流程与岗位强制（UI/API）｜状态 ✅

目标：选岗位即得正确工具集；UI/API 服务端强制边界。

| 步 | 目标 | 验收 | 状态 |
|---|---|---|---|
| 3 | 申请 UI 加岗位选择（默认 general-assistant、默认 jiuwen） | 新建 agent 带岗位、走默认运行时 | ✅ |
| 8 | `/api/claw/mcp-tools/status` 按岗位过滤 | 财富经理只见财富 MCP | ✅ |
| 9 | 技能市场/列表/安装 按岗位过滤 | 只见本岗位 zones/技能 | ✅ |
| 10 | 拒绝越岗位安装（除审计过的管理员例外） | 越权安装被拒 + 落审计 | ✅ |
| 13 | 实例管理加「岗位」列、原「角色」改名「权限档」 | 两列分离、改岗位触发迁移 | ✅ |
| 14 | 运行时 override 仅管理员可见 | 用户端无运行时选择；运行时由岗位模板 + 安全开关决定 | ✅ |
| 21 | 动态岗位授权数据层：JSON seed → DB `role_asset_grants`；effective list 只从 DB grants 解析 | 一个技能/MCP 标多岗位，多岗位都可见；不再维护「基线 ∪ 动态」双源 | ✅ |
| 22 | 发布/后台打标签 UI（多选 + `*`/general 通用标记 + grantMode） | 上线技能/MCP 标注岗位后，该岗位 Agent **即时**可见，无需改 JSON/重启 | ✅ |

> 说明：step 8/9 的过滤从一开始就走 role asset grant resolver，避免后期返工。P2 初期可由 JSON seed
> 回填 DB grant；一旦 DB grant 表启用，JSON 只保留岗位目录/seed 文档职责。详见 *Dynamic Role–Asset Association*。

Implementation note (2026-06-18):

- The apply page now exposes a compact role selector backed by
  `claw.roleTemplates`. First-phase UI only shows `status = "mvp"` roles: the
  default `general-assistant` plus five professional roles.
- `claw.adopt` accepts `roleTemplate` but rejects non-MVP roles for self-service
  apply. Planned/disabled roles remain admin-only until explicitly promoted.
- Admin instance management now separates `permissionProfile` as 权限档 from
  `roleTemplate` as 岗位. Single-row and batch role changes call
  `adminUpdate`/`adminBatchUpdate`, which trigger role reset.
- `/api/claw/mcp-tools/status` now resolves the requesting Agent's
  `roleTemplate`, loads effective MCP grants from `role_asset_grants`, and
  filters the displayed MCP catalog at MCP server granularity. `general-assistant`
  has no business MCP, so it sees an empty MCP list.
- Skill marketplace list and install now use the same role grant source:
  `claw.marketList({ adoptId })` returns only effective role skills, and
  `claw.marketInstall` rejects skills outside the Agent's effective skill grants
  with `skill.install.denied` audit metadata.
- Runtime is deliberately not exposed in the self-service apply UI/API. Users
  choose `roleTemplate`; runtime is resolved from the role template and
  `JIUWENSWARM_PROVISION_ENABLED`, with OpenClaw fallback while jiuwenswarm
  provisioning remains gated. Runtime migration/override stays an admin/runtime
  operation outside the self-service path.
- Dynamic grants are now backed by `role_asset_grants` as the runtime authority:
  `adminRoleAssetCatalog` lists roles, approved skills, configured MCP servers
  and grants; `adminSetRoleAssetGrants` writes only `source='admin'` rows.
  Seed rows are never mutated by the UI, so JSON baseline governance remains
  intact while admin/market grants can change at runtime.
- Approved open-source Skills are treated as common capability and materialized
  into `role_asset_grants` as `role_key='*'`, `grant_mode='optional'`,
  `source='market'`. Business Skills (`finance` / `squad`) and MCP servers are
  not globally granted; they still require explicit role grants because they may
  carry business data or system privileges.
- Admin Skill Marketplace now has a "岗位授权" editor for each approved Skill.
  The same page includes an MCP server-level grant editor. Both support multiple
  roles, wildcard `*`, and `default` / `optional` grant modes. The resolver reads
  the updated DB rows immediately; existing Agents pick up default changes on
  role reset, and optional grants become visible in role-filtered lists.

### P4 — 换岗 / 迁移｜状态 ✅

目标：管理员改岗位即按新岗位重置工具集；精细 reconcile 延后。

| 步 | 目标 | 验收 | 状态 |
|---|---|---|---|
| 11 | provision 加 role reset 模式 | 能按新岗位 grants 覆盖已有 agent 的 active Skill/MCP；杀旧会话/刷新工具指纹 | ✅ |
| 12 | 精细 reconcile 延后：技能 `source` + `active/deactivated`；L3 停用不删 | 等用户大量自装业务技能后再做；当前不阻塞 MVP | ⏸ |
| 15 | `role.changed` 等审计事件 | 旧岗→新岗、增删 skill/MCP、操作人、时间全记 | ✅ |

Implementation note (2026-06-18):

- `claw.adminUpdate` now treats any submitted `roleTemplate` as an explicit
  role reset request. It updates the adoption record, resolves effective assets
  from `role_asset_grants`, reconciles Skills/MCP through the existing runtime
  adapter, bumps the session epoch, and records a `profile_updated` lifecycle
  event with `action: "role_reset"`.
- `claw.adminBatchUpdate` applies the same reset per selected agent when a
  batch role is submitted.
- A role reset **does not migrate runtime**. Existing `lgc-*` agents stay on
  OpenClaw and existing `lgj-*` agents stay on JiuwenSwarm; runtime migration is
  a separate rollout decision.
- Reset is skipped for non-active lifecycle states (`recycled` / `failed`) and
  reported as `applied: false`; reset errors are audited as
  `agent.role.reset_failed` and returned to the admin UI.
- Successful single-row and batch role resets now emit first-class
  `agent.role.changed` audit events. The event records old role, new role,
  runtime, previous/effective Skill and MCP grants, added/removed grant diff,
  active Skill list, runtime reconcile results, session epoch, operator, request
  metadata, and whether the submitted role actually changed.
- Fine-grained L3 reconcile (`source` + `active/deactivated`) remains deferred
  by design. Current MVP uses role reset plus personal Skill preservation and
  hard MCP role boundaries; this is sufficient until users frequently
  self-install cross-role business Skills.

### P5 — 审计与市场调用数｜状态 ✅

目标：谁调用了哪个技能/MCP 全可审计；市场展示调用数。

| 步 | 目标 | 验收 | 状态 |
|---|---|---|---|
| 16 | MCP 调用审计（adapter 捕获、EA 归口；Wind/盈米前置 adapter） | 每次 MCP 调用有 who/what/result 落库 | ✅ |
| 17 | `skill.invoked` 一级事件 | 不再靠命令路径反推技能名 | ✅ |
| 18 | 市场「调用数」 | 安装数 + 调用数同源于中心审计 | ✅ |

> 2026-06-18 本地已完成代码层闭环：业务 MCP 可 POST `/api/claw/audit/mcp-tool` 写入中心审计；OpenClaw trajectory 与 jiuwenswarm WebChannel 均可写 `skill.invoked` 和 `mcp.tool.*`；Skill 市场与 MCP 工具状态接口返回 `invocationCount`。当前调用数为实时聚合，后续访问量上来后再切 rollup；新增业务 MCP 工具名需要同步补映射或走 adapter 回写。

### P6 — 迁移与上线｜状态 ✅

目标：存量 agent 归类到岗位；上海最后上线。

| 项 | 目标 | 验收 | 状态 |
|---|---|---|---|
| 存量迁移 | 老用户按已装技能/常用 MCP 分类到岗位 | 存量 agent 已完成岗位归类；李泓锟保留全量/特殊管理口径 | ✅ |
| 上海上线 | 按 Upgrade Posture，上海最后升、备回滚 | 代码同步、migration/seed、PM2 重启、核心接口 smoke 通过 | ✅ |

Implementation note (2026-06-18):

- 上海环境已同步本地岗位权限代码，`claw_adoptions` 的
  `roleTemplate` / `industry` / `runtime` 字段和 `role_asset_grants` 表已就绪。
- `role_asset_grants` seed sync 已执行：当前 seed 启用 47 条、历史 seed 禁用 21 条、
  open-source market 通用授权 17 条。seed 同步只处理 `source='seed'`，不覆盖
  `source='admin'/'market'` 动态授权。
- 上海 PM2 `linggan-claw` 已重启；首页、`claw.roleTemplates`、resolver、MCP 审计写入
  smoke 均通过。新建 Agent 会走岗位选择和岗位授权过滤；存量 Agent 已按确认清单迁移到
  6 个 MVP 岗位或特殊全量口径。

### P7 — 验收脚本与回归基线｜状态 🔵

目标：把岗位/Skill/MCP 的关键验收固化成可重复脚本，后续本地、上海、新加坡升级后都能一键回归。

| 项 | 目标 | 验收 | 状态 |
|---|---|---|---|
| P7 回归检查 | 检查 baseline、DB grants、resolver、HTTP 审计入口、调用数聚合 | 历史 smoke harness 已移出发布仓，必要时在外置归档环境手动执行 | 🔵 |
| 回归入口文档化 | 升级 OpenClaw/jiuwenswarm/EA 后有固定验收命令 | 文档记录脚本用途、参数、通过标准 | 🔵 |

Implementation note (2026-06-18):

- 早期曾用独立 smoke harness 覆盖岗位 baseline、DB grants、resolver、HTTP 审计入口和调用数聚合。
- 该 harness 已移出发布仓，避免把一次性环境验证脚本带入开源/交付代码。后续如需恢复，应放在独立测试仓或本机归档环境中维护。

### P-Gov — 企业治理底线（进银行 POC 前必补）｜状态 ⬜

目标：补齐进银行/保险 POC 的治理硬门槛。当前作为独立 backlog 管理，不阻塞岗位权限 MVP。

归口文档：`docs/design/ENTERPRISE_GOVERNANCE_BACKLOG.md`。

| 项 | 目标 | 验收 | 状态 |
|---|---|---|---|
| 离职反向收权（JML Leaver） | 员工离职/停用 → agent 停用、杀会话、收回数据访问 | 停用用户 5 分钟内 agent 不可用、MCP 调用被拒、落审计 | ⬜ |
| 技能安全审查闸 | 发布/打标签前过代码安全门（静态扫描 + 人工签核，编写≠审批） | 未过审技能不可发布/不可打岗位标签 | ⬜ |
| 模型-数据治理 | 数据敏感度 → 允许模型白名单 | PII 类只能进合规/本地模型，违规调用被拒 | ⬜ |
| 审计留存/不可篡改 | WORM + 留存年限 + 监管导出 + 法务冻结 | 审计不可改、可按期导出（确认 enterprise-audit-ledger 覆盖） | ⬜ |

## Resolved Decisions (2026-06-16)

- **Role approval**: no admin approval in the current MVP — role selection is
  self-service. In an enterprise deployment, the role is auto-mapped by querying
  the customer's internal IT systems (IAM / HR / AD), not by manual approval.
- **Shared Skills deny-by-default**: yes. "Shared Skills" means whatever sits in
  `.openclaw/skills-shared/` that `claw-provision.sh` links into every Agent
  regardless of role. Today that directory is empty (effectively 0 shared
  Skills). The "link everything into everyone" behavior is retired in favor of
  role asset grants — Skills are deny-by-default and only granted by the
  role asset grants. The only universally-present Skills are the
  `general-assistant` seed grants (explicit allow, not implicit share).
- **MCP catalog display**: keep current behavior — the outer catalog lists at MCP
  server level, and a dropdown expands to the sub-tool level on demand.
- **Baseline loading**: the server loads `role-skill-mcp-baseline.json` directly
  at runtime from a runtime-owned path, validated with a Zod schema at boot
  (fail-fast). No build-time TS codegen. The JSON remains the role catalog and
  seed source; effective Skill/MCP authorization lives in DB grants once P2/P3
  introduces `role_asset_grants`.

## Enterprise Readiness & Scope Decisions (2026-06-17)

从企业（银行/保险）视角复盘后的范围决策。分三类：暂缓、必补治理项、砍掉的过设计。

### 暂缓（本期不做）

- **多租户 / 按客户隔离**：当前单租户部署，不纳入本期。仅当产品要同时卖给多家银行时再启动。
  代码有租户底子（`tenant_map`、`tenant-isolation`），但**按租户隔离的岗位/技能/MCP 目录暂不做**。

### 必补治理项（进银行 POC 前的底线）

- **离职/调岗反向收权（JML Leaver）**【高优先】：现有"换岗迁移"只覆盖在岗。必须补：员工离职/停用 →
  **agent 停用、活跃会话杀掉、数据访问立即收回**。IAM 自动映射要覆盖 Leaver，不只 Joiner/Mover。
  （离职员工的 agent 还能调客户 MCP = 事故级漏洞。）
- **技能上线安全审查闸**【高优先】：技能是 md + 脚本，跑在 `exec` / `security: full`。市场只有业务审核
  （pending/approved），无代码安全门。须在「发布 / 打岗位标签」前加安全审查（静态扫描 + 人工签核；
  职责分离：编写者 ≠ 审批者）。
- **模型-数据治理**：每岗位有 defaultModel，但缺「数据分级 → 允许模型」策略。客户 PII 只能进合规/本地
  模型。须建数据敏感度→模型白名单。
- **审计不可篡改与留存**：当前记事件，须补 WORM/防篡改、留存年限（银行 5–7 年）、监管导出、法务冻结。
  确认 `enterprise-audit-ledger.md` 覆盖范围。

### 砍掉的过设计（范围收敛）

- **两套关联机制收成一套**：放弃「静态 `allowedSkills`(JSON) ∪ 动态 `roleTags`(DB)」双源。改为**单一源
  = DB 岗位资产授权**，所谓"基线"只是出厂默认 seed 的授权记录。**本条取代 *Dynamic Role–Asset Association* 里
  的两层并集模型**，避免长期双源一致性债。
- **岗位别一次铺满**：只上 MVP 岗位，其余靠动态标签长出来，不为单个技能立岗位（如 insurance-claims 当前
  1 技能）。非 MVP 岗位保持 `planned`/disabled，等技能量到了再启用。
- **复核/退役 `permissionProfile` 这个轴**：业务岗位驱动 provisioning 后，确认 plus/internal 档是否还有
  独立价值；若无，合并掉，少一个维度。
- **MVP 简化换岗 reconcile**：暂缓 L1/L2/L3 + 停用不删那套精细逻辑。MVP 阶段「换岗 = 按新模板重装」即可；
  等用户真的大量自装业务技能后再引入精细 reconcile。

> 总方向：把一部分"功能精巧度"的预算挪给"企业治理底线"（离职收权、技能安全、审计留存）。

## Open Questions

- Role-tag canonicalization is closed by
  `drizzle/migrations/0020_apply_role_tag_canonicalization.sql`: it backs up the
  seven affected Skill rows and updates `skill_marketplace.role_tag` by exact
  `skill_id`. Runtime authorization remains `role_asset_grants`.

## Backlog (low priority, defer to last)

### Per-user reasoning (thinking) toggle — verified facts + open dependency (2026-06-18)

Goal: let the end user switch the model's reasoning (thinking) on/off per chat,
mainly to trade depth for speed. Measured on Huawei MaaS `glm-5.2`: reasoning OFF
roughly halves total latency (13.5s → 6.2s on a sample prompt; ~280 fewer thinking
tokens). First-token latency is ~unchanged (~4.1s); the win is total completion.

Verified facts:
- The disable parameter that works on Huawei MaaS `glm-5.2` is
  `"thinking": {"type": "disabled"}` in the request body. Other variants
  (`enable_thinking`, `chat_template_kwargs.enable_thinking`,
  `reasoning.enabled`, `reasoning_effort`) had **no effect**.
- Frontend rendering already exists: `reasoning_content` deltas render as a
  `💭 深度思考` block; `jiuwenclaw-bridge.ts` already translates jiuwen reasoning
  events (`delta_kind=reasoning` / `chat.reasoning`) into `reasoning_content`.
- A **display-only** toggle already exists: `UiSettings.chatShowThinking`
  (show/hide the block). It does **not** change generation or save time — the
  model still thinks.

Open dependency (why this is deferred, Codex to investigate):
- A real per-user speed toggle must send `thinking:{type:disabled}` to the model
  per request. On jiuwenswarm, model params come from `config.yaml`
  `model_config_obj` (per-agent), and there is **no confirmed per-request override
  path** through the EA→jiuwen agent-server WS (jiuwen `_model_request_config` is
  built from the instance config; the per-request `params` channel carries `mode`,
  not model body params). jiuwen's web/tui channels have a `reasoning_level`
  concept, but EA does not use those channels.
- Therefore a frontend-only toggle would be a **dead switch** on jiuwen until
  jiuwen accepts a per-request thinking/reasoning override (another jiuwen-side
  patch). Codex should verify whether the EA→jiuwen request can carry a per-request
  model override; if not, scope the small jiuwen patch.

Interim (works today, no per-user control):
- Global off: add `thinking: {type: disabled}` under `model_config_obj` in jiuwen
  `config.yaml` → reasoning off for all jiuwen agents on restart.
- Users who only dislike seeing the thinking can turn off `chatShowThinking`.

Implementation sketch (once the jiuwen dependency is cleared):
1. `UiSettings` add `reasoningEnabled: boolean` (distinct from the display-only
   `chatShowThinking`).
2. Add the switch to the active settings UI; default ON (quality first).
3. `useAgentChat.ts` include it in the chat payload (alongside `memoryEnabled`).
4. Backend passes it to the runtime; when OFF, inject `thinking:{type:disabled}`
   into the model request. Only meaningful for reasoning models (glm-5.x); harmless
   to pass to others.
