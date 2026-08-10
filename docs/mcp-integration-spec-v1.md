# 企业 MCP 接入与治理规范 v1

## 0. 当前落地状态（2026-08-08）

本规范同时描述已实现基础与目标态。当前完成:

- 企业 MCP 注册表、工具治理策略表及复用现有岗位授权表。
- 管理后台“企业连接器”配置页，支持地址、协议、身份模式、认证方式、数据分级、生命周期、工具策略和岗位授权。
- 配置、工具策略和岗位授权变更使用管理员 MFA，并写入 fail-close 审计事件。
- EA 企业 MCP 内部网关，运行时按岗位授权、智能体开关和工具策略裁剪 `tools/list`。
- ES256 短期 Access Token 签发与公开 JWKS，Token 绑定 tenant/user/agent/role/server/tool/scope/request，默认 120 秒过期。
- 工具调用已接入参数策略、数据护栏、持久化调用回执、幂等键占用和 `strong/highest` 同步审计。
- 后台连接、工具策略和岗位授权变更会刷新受影响的 JiuwenSwarm 实例；启动时会修复旧实例缺失的企业网关能力声明。
- 未完成持久化人工审批的写入工具一律 fail-close；当前 `save_product` 保持停用。
- 两项保险标杆服务已启用标准地址，旧地址继续内部兼容:
  - `https://mcp.demo.linggan.top/insurance/customer-profile/mcp`
  - `https://mcp.demo.linggan.top/insurance/product-exam-points/mcp`
- 两项服务已通过 `2025-11-25` 初始化和 `tools/list` 联调；平台目标配置为 `oauth2_access_token + shadow`，待服务端通过可信身份负向验证后进入 `enforced`。

当前尚未完成，不能将两项标杆服务切换为生产可信接入:

- 两项 MCP 服务端的 Token 验签、租户/用户行级过滤、scope 校验和双侧业务审计。
- `save_product` 的持久化人工审批与 MCP 服务端幂等结果复用。
- 原始 MCP 源站仅允许网关访问，并通过安全组或防火墙完成网络收口。

因此当前两项连接器可用于岗位授权、工具策略和可信身份联调，但不应在服务端验签前承载真实客户敏感数据。平台已增加有效 Token、无 Token、错误 audience、缺 scope 和错误 tool binding 的强制验收；任一负向探测被接受都不能切换为生产强制态。

> 适用对象:岗位智能体平台管理员、MCP 服务开发者、平台开发者、安全与审计人员
>
> 状态:设计基线 v1，平台注册与影子接入已实现
>
> 协议基线:MCP `2026-07-28`，兼容现网 `2025-11-25`
> 核心目标:统一接入、可信身份、最小授权、动作受控、过程可审计、故障可定位

---

## 1. 结论

企业 MCP 不应继续采用“每个服务单独开端口、在 JiuwenSwarm 中手工写配置、靠普通 Header 传用户”的方式扩展。

目标架构统一为:

```text
用户 / 岗位实例
  -> JiuwenSwarm
  -> EA 企业 MCP 网关(统一注册、鉴权、策略、审计)
  -> HTTPS Streamable HTTP MCP
  -> 业务系统 / 数据服务
```

规范冻结以下原则:

1. 企业 MCP 由管理员注册，个人 MCP 由用户自助添加，两类连接器严格隔离。
2. 远程企业 MCP 使用 HTTPS Streamable HTTP；本机内置能力可以暂时保留 stdio。
3. 企业 MCP 的可信身份由 EA 签发短期、面向单一 MCP 资源的 Bearer Access Token。
4. URL 按业务域和能力命名，岗位授权单独配置，不把岗位写死在 URL 中。
5. 平台负责能力级授权，MCP 负责业务数据的行级授权。
6. 所有写入、外发、交易、审批和管理动作必须经过 PreToolUse、审批/幂等和强审计。
7. 迁移按 `legacy -> shadow -> enforced` 逐服务推进，不做一次性切换。

这套方案与 EA 已有的工具治理、出站护栏和审计台账方向一致，但当前代码只具备部分基础设施，不能把本文目标态描述为“已经完成”。

---

## 2. 范围与边界

### 2.1 三类连接器

| 类型 | 谁配置 | 身份与凭证 | 网络规则 | 示例 |
|---|---|---|---|---|
| `enterprise` | 管理员 | EA 签发企业 Access Token | 可访问管理员白名单内的公网/私网服务 | 保险客户画像、财富客户数据 |
| `user` | 终端用户 | 用户自己的 OAuth/API Key | 禁止私网地址，执行 SSRF 防护 | 用户自加 Notion、GitHub MCP |
| `platform` | 平台代码 | 内部服务身份 | 仅平台内网/回环 | `platform_tools` |

强制边界:

- `user` MCP 不得收到企业 `tenant_id`、岗位身份、客户归属或内部服务凭证。
- `enterprise` MCP 不使用终端用户上传的任意 Token 作为企业身份。
- 企业连接器与个人连接器必须使用不同的注册表、凭证域和网关路径。
- MCP 收到的 Access Token 不得原样传给下游业务 API。下游 API 使用 MCP 自己的独立凭证或 Token Exchange 结果。

### 2.2 身份模式

`requiresSubject: true/false` 过于粗糙，统一为三档:

| identityMode | 适用场景 | Token 中必须包含 | 数据隔离责任 |
|---|---|---|---|
| `platform` | 公开行情、公开资讯 | `client_id`, `aud`, `scope` | 仅验证平台调用方 |
| `tenant` | 企业共享制度、产品库 | 加 `tenant_id` | MCP 按企业隔离 |
| `user` | 客户、持仓、信贷、个人任务 | 加 `tenant_id`, `sub`, `role`, `agent_instance_id` | MCP 按用户/岗位做行级过滤 |

身份模式是服务注册信息的强约束。声明为 `tenant` 或 `user` 后，缺少对应 Claim 必须拒绝，禁止降级为平台公共访问。

---

## 3. 服务与 URL 命名

URL 按“业务域/能力”组织，岗位是授权关系，不是 URL 的一部分。

```text
https://mcp.demo.linggan.top/<business-domain>/<capability>/mcp
```

示例:

```text
https://mcp.demo.linggan.top/insurance/customer-profile/mcp
https://mcp.demo.linggan.top/insurance/product-exam-points/mcp
https://mcp.demo.linggan.top/wealth/customer-data/mcp
https://mcp.demo.linggan.top/wealth/product-data/mcp
```

对应稳定 ID:

```text
insurance_customer_profile
insurance_product_exam_points
wealth_customer_data
wealth_product_data
```

要求:

- `serverId` 创建后不可修改，审计和岗位授权以它为稳定内部主键。
- `resourceUri` 使用 MCP canonical URI，OAuth `resource` 参数和 Access Token `aud` 必须绑定该 URI。
- 显示名称、图标、描述可以修改，不影响稳定 ID。
- 旧地址保留服务端内部 rewrite 兼容，禁止用会改变 POST 语义的外部 301/302 跳转。
- 原始服务端口仅允许反向代理或企业网关访问，不得继续直接暴露公网。
- 同一个 MCP 可授权给多个岗位，不复制多套 URL 或服务实例。

首批标杆服务:

| serverId | 标准地址 | identityMode | 说明 |
|---|---|---|---|
| `insurance_customer_profile` | `/insurance/customer-profile/mcp` | `user` | 客户查询需按用户隔离和审计 |
| `insurance_product_exam_points` | `/insurance/product-exam-points/mcp` | `tenant`，写工具为 `user` | 查询为企业共享，`save_product` 必须绑定操作者 |

---

## 4. 传输与协议

### 4.1 目标态

| 项 | 要求 |
|---|---|
| 传输 | MCP Streamable HTTP |
| TLS | 远程服务强制 HTTPS；HTTP 仅允许本机回环或受控内网迁移期 |
| 端点 | 单一 `/mcp` 端点 |
| 内容类型 | `application/json`，流式响应可用 `text/event-stream` |
| 目标版本 | `2026-07-28` |
| 长任务 | 使用 MCP Tasks 扩展或业务任务句柄，禁止无限挂住 HTTP 请求 |
| 追踪 | 传播 W3C `traceparent` / `tracestate`，并关联 EA `correlationId` |

MCP `2026-07-28` 已移除 `initialize/initialized` 握手和协议级 `Mcp-Session-Id`。每个请求自包含协议版本、客户端信息和能力，可直接由普通负载均衡分发。

`MCP-Protocol-Version`、`Mcp-Method`、`Mcp-Name` 是 2026 版必需 Header，并且必须与 JSON-RPC 请求体中的 `_meta`、`method`、`params.name/uri` 一致。请求体是事实来源，Header 与请求体不一致时服务端返回 `400 HeaderMismatch`，避免网关按 Header 授权而后端执行另一项工具。

### 4.2 现网兼容

当前 JiuwenSwarm、MCP SDK 以及两项保险标杆服务仍使用 `2025-11-25` 会话模型。迁移期要求:

- EA 企业 MCP 网关支持 `2025-11-25` 客户端并可对接现有 MCP。
- 旧协议的 `initialize` 和后续 session 请求必须逐次执行同一套认证与授权。
- session 必须绑定调用主体；同一 session 切换 `sub` 或 `tenant_id` 必须拒绝。
- 新服务优先实现 `2026-07-28`，需要时提供旧协议兼容层。
- 不要求现有服务为升级协议而停机，不把协议升级与权限整改强绑定。

### 4.3 网络要求

- 公网入口必须由受控反向代理/API Gateway 终结 TLS。
- 源站端口通过安全组、防火墙或服务认证限制为仅网关可达。
- Streamable HTTP 服务必须校验 `Origin`；存在且不在允许列表时返回 `403`，防止 DNS rebinding。
- 禁止把“源站地址不公开”当作认证机制。
- 生产服务应提供 `/health` 或等价健康探针，但不得在健康响应中泄露凭证、依赖地址或版本漏洞信息。
- 超时由注册项配置，默认普通工具 30 秒；长任务必须异步化。

---

## 5. 认证与可信身份

### 5.1 目标态:单一 Access Token

每次请求使用一个短期、面向单一 MCP 资源的 Bearer Access Token:

```http
POST /insurance/customer-profile/mcp HTTP/1.1
Authorization: Bearer <EA_ISSUED_ACCESS_TOKEN>
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: get_customer_profile_by_name
Content-Type: application/json
Accept: application/json, text/event-stream
traceparent: 00-<trace-id>-<span-id>-01
```

Token 由 EA 企业授权服务动态签发，MCP 开发者不向平台提供“用户 Token”。MCP 服务作为 OAuth 2.1 Resource Server 验证 Token。

推荐 Claims:

```json
{
  "iss": "https://work.linggan.top",
  "aud": "https://mcp.demo.linggan.top/insurance/customer-profile/mcp",
  "server_id": "insurance_customer_profile",
  "client_id": "employee-agent",
  "tenant_id": "tenant_demo_bank",
  "sub": "usr_7f3a91c4e2b84d6f",
  "role": "insurance-advisor",
  "agent_instance_id": "lgj-xxxxxxxx",
  "scope": "insurance:customer:read",
  "iat": 1786150000,
  "exp": 1786150300,
  "jti": "tok_9f2c..."
}
```

要求:

- `aud` 必须绑定单个 MCP `resourceUri`，不得跨 MCP 复用；`server_id` 仅用于平台内部关联。
- `exp` 默认不超过 5 分钟。
- `sub` 使用稳定不透明 ID，禁止放姓名、工号、邮箱、手机号等 PII。
- 当前统一使用 ES256/P-256 非对称签名，MCP 通过 JWKS 验签。
- 验签必须锁定算法、`iss` 和 `aud`。
- Access Token 必须出现在 `Authorization` Header，不得放入 URL。
- 平台私钥不外发；JWKS 使用 `kid` 支持至少 24 小时的轮换重叠期。
- 若对接企业统一身份平台，可由企业 IdP 签发；EA 仍需把岗位实例和最小 scope 纳入可验证授权结果。

资源服务和授权服务分别暴露标准元数据:

```text
企业 MCP 网关/资源服务:OAuth Protected Resource Metadata(RFC 9728)
EA 授权服务:/.well-known/oauth-authorization-server 或 /.well-known/openid-configuration
EA 授权服务:/.well-known/jwks.json
```

具体 Protected Resource Metadata 地址按 MCP canonical resource URI 和 RFC 9728 生成，不由各业务开发者自行发明路径。

### 5.2 过渡态:静态 Bearer + `X-EA-Subject`

若首批服务暂时无法接入统一授权服务，可短期兼容:

```http
Authorization: Bearer <STATIC_SERVICE_TOKEN>
X-EA-Subject: <EA_SIGNED_USER_ASSERTION>
```

该模式是 EA 的迁移扩展，不是最终 MCP 标准。限制如下:

- 仅允许 `legacy` / `shadow` 阶段使用。
- 服务 Token 按 MCP 独立生成，至少 32 随机字节，环境变量/KMS 存储，支持双 Token 轮换。
- 静态 Token 使用常量时间比较。
- `X-EA-Subject` 仍需非对称签名、短时效和 audience 绑定。
- 迁移到统一 Access Token 后删除双凭证逻辑。

### 5.3 三种 Token 的责任边界

| 凭证 | 谁签发/配置 | 放在哪里 | 用途 |
|---|---|---|---|
| EA -> MCP Access Token | EA 授权服务或企业 IdP 动态签发 | 不落管理后台明文 | 证明平台、租户、用户与 scope |
| MCP -> 下游业务系统凭证 | MCP 服务开发者/业务系统 | MCP 运行环境、KMS/Secret Manager | 调用业务 REST/数据库 |
| 用户第三方 OAuth/API Key | 用户与第三方提供方 | EA 现有加密凭证库 | 用户自定义 MCP |

只有迁移期静态 Bearer 可由管理员录入，必须加密保存、只写不回显、可轮换和吊销。

---

## 6. 授权分工

```text
平台:这个岗位实例能否看到/调用该 MCP 和工具
MCP:这个企业/用户能否访问这些具体业务数据
业务系统:客户归属、数据权限和业务规则的最终真相源
```

### 6.1 平台能力级授权

EA 在调用前按以下信息判定:

- 当前用户、租户和岗位实例是否有效。
- 岗位是否获授该 `serverId`。
- 工具是否启用。
- scope 是否满足。
- 工具 side effect 是否需要 Policy Gate、审批和幂等键。
- 数据密级是否允许当前岗位和外部处理方式。

未注册企业 MCP、未发现工具或工具策略缺失时:

- 只读工具可在管理员明确启用的 `shadow` 阶段观测。
- 无法确定为只读的工具一律按业务 `write` 处理并 fail-close。

### 6.2 MCP 行级授权

MCP 服务必须:

- 使用 `tenant_id` 过滤企业数据。
- `identityMode=user` 时使用 `sub` 过滤客户、持仓、案件或个人任务。
- 不信任普通 `X-User-Id`、`x-linggan-agent-id` 等未签名 Header。
- 不在 EA 中复制“客户经理与客户归属”表，避免产生第二个真相源。
- 无权限返回 `403`，无有效身份返回 `401`，不得返回空数据冒充成功。

### 6.3 写操作

所有 `write`、`external_send`、`financial_action`、`approval_action`、`admin_action` 工具必须:

- `identityMode=user`。
- 声明最小写 scope。
- 经过 EA PreToolUse 和工具治理注册表。
- 按策略要求获得用户确认或审批。
- 接收并校验幂等键，避免重试导致重复写入。
- 在业务侧保存 `created_by_sub` / `updated_by_sub` 和业务请求号。
- 禁止通过只读工具名包装写操作。

`insurance_product_exam_points.save_product` 是首批必须按上述规则整改的样例。

---

## 7. 管理后台注册模型

入口建议:

```text
管理后台 -> 连接器管理 -> 企业 MCP
```

### 7.1 连接器级配置

| 字段 | 必填 | 说明 |
|---|---:|---|
| `serverId` | 是 | 不可变稳定内部 ID，用于注册、授权和审计 |
| `displayName` / `description` / `icon` | 是 | 前端展示 |
| `businessDomain` | 是 | `insurance` / `wealth` / `risk` 等 |
| `endpointUrl` | 是 | 标准 HTTPS MCP 地址 |
| `resourceUri` | 是 | OAuth canonical resource URI，通常与 `endpointUrl` 相同，也是 Token audience |
| `protocolVersion` | 是 | `2025-11-25` 或 `2026-07-28` |
| `identityMode` | 是 | `platform` / `tenant` / `user` |
| `authMode` | 是 | `oauth2_access_token` / `static_bearer_legacy` |
| `dataClassification` | 是 | `public` / `internal` / `sensitive` / `restricted` |
| `environment` | 是 | `dev` / `test` / `prod` |
| `lifecycleState` | 是 | `legacy` / `shadow` / `enforced` / `disabled` |
| `timeoutClass` | 是 | 普通/长任务，最终映射具体超时 |
| `ownerDepartment` / `ownerContact` | 是 | 责任人与故障通知 |
| `healthUrl` | 否 | 健康探针 |
| `allowedSourceNetworks` | 否 | 源站网络白名单说明 |

### 7.2 岗位授权

独立关系表维护:

- `serverId`
- `roleTemplate`
- `grantMode`:默认启用/用户可选/管理员强制
- 可用环境和租户范围
- 生效与失效时间

同一个 MCP 可授权给多个岗位，角色变更不要求改 MCP 服务代码。

### 7.3 工具级策略

管理员点击“发现工具”后，逐工具确认:

| 字段 | 说明 |
|---|---|
| `toolName` | MCP 原始工具名 |
| `enabled` | 是否允许调用 |
| `sideEffect` | `read` / `compute` / `write` / `external_send` / `financial_action` / `approval_action` / `admin_action` |
| `requiredScopes` | 最小权限集合 |
| `allowedRoles` | 可选的工具级岗位覆盖 |
| `identityModeOverride` | 工具级身份升级；例如服务默认 `tenant`，写工具升级为 `user` |
| `approvalMode` | `never` / `conditional` / `always` |
| `auditLevel` | `normal` / `strong` / `highest` |
| `idempotencyRequired` | 是否强制幂等键 |
| `argumentPolicy` | 参数范围、敏感字段和出站限制 |

禁止依据工具名称自动批准生产写权限。自动推断只能生成待确认草稿。

### 7.4 建议数据表

```text
enterprise_mcp_connections
enterprise_mcp_role_grants
enterprise_mcp_tool_policies
enterprise_mcp_secret_versions       # 仅迁移期静态凭证
```

管理员后台不保存 MCP 下游业务系统账号密码。

---

## 8. 平台执行链路

每次企业 MCP 调用必须经过同一条链路:

```text
1. 解析 user / tenant / roleTemplate / adoptId
2. 查询企业 MCP 注册项和岗位授权
3. 读取工具级治理策略
4. 调用 PreToolUse:数据出站护栏 + sideEffect Policy
5. 必要时发起并持久化审批，绑定 toolInputHash
6. 生成 correlationId / traceparent / idempotencyKey
7. 签发短期 audience-bound Access Token
8. 记录 mcp.tool.requested / allowed 或 denied
9. 由企业 MCP 网关发起远程调用
10. 记录 completed / failed，输出指标和安全发现
```

关键不变量:

- 所有企业 MCP 必经 EA 企业网关，不允许 JiuwenSwarm 绕过网关直连生产企业 MCP。
- 平台授权和 MCP 行级授权必须同时成功。
- Policy Gate 不可用时，写入和高风险调用 fail-close。
- 审批必须持久化、绑定参数摘要并且只能消费一次。
- Access Token 的 scope 不得超过岗位授权、工具策略和上游调用上下文的交集。

---

## 9. 审计与证据规范

### 9.1 审计目标

系统必须能回答:

1. 谁在什么时间，以哪个岗位实例调用了哪个 MCP 工具。
2. 当时属于哪个租户，使用了哪些 scope 和哪版策略。
3. 输入参数是什么摘要，是否包含敏感数据，为什么允许或拒绝。
4. MCP 返回成功、失败还是越权，耗时和结果规模是多少。
5. 写操作是否经过审批、审批绑定了哪组参数、是否发生重复消费。
6. MCP 又调用了哪个业务系统请求，能否通过业务请求号关联。

### 9.2 平台侧必记事件

```text
mcp.tool.requested
mcp.tool.allowed
mcp.tool.denied
mcp.tool.completed
mcp.tool.failed
mcp.approval.requested
mcp.approval.consumed
mcp.connector.config_changed
mcp.connector.credential_rotated
```

每条调用至少记录:

| 类别 | 字段 |
|---|---|
| 主体 | `actorUserId`, `tenantId/actorOrgId`, `actorRole`, `agentInstanceId` |
| 能力 | `serverId`, `toolName`, `sideEffect`, `dataClassification`, `scope` |
| 关联 | `eventId`, `requestId`, `correlationId`, `traceId`, `toolCallId`, `jti` |
| 决策 | `policyDecisionId`, `policyCode`, `ruleVersion`, `approvalId` |
| 输入 | `toolInputHash`, 脱敏参数摘要，禁止默认记录完整参数 |
| 输出 | `result`, `errorCode`, `durationMs`, `responseBytes`, 脱敏结果摘要 |
| 幂等 | `idempotencyKey` 或其 hash，重复命中状态 |
| 下游 | MCP 侧 `businessRequestId` / `upstreamTraceId` |

禁止记录:

- Access Token、刷新 Token、静态 Bearer、Cookie、私钥。
- 完整客户资料、银行卡、身份证、手机号等敏感入参/结果。
- SQL、内部堆栈和密钥管理路径。

### 9.3 MCP 服务侧必记事件

MCP 侧至少记录:

```text
时间 | tenant_id | sub | role | serverId | toolName | scope
参数摘要 | 授权结果 | 行级过滤结果 | 业务请求号 | 结果 | 耗时 | jti | traceId
```

平台与 MCP 使用 `correlationId/traceId` 和业务请求号关联，形成双侧证据。只记录平台侧“已发请求”不足以证明业务数据实际如何授权和返回。

### 9.4 审计等级

| auditLevel | 场景 | 持久化要求 |
|---|---|---|
| `normal` | 公共/内部只读 | 可异步，但必须进入可靠队列或 DLQ |
| `strong` | 敏感读取、普通写入、外发 | 执行前审计必须同步持久化或写入 DLQ，否则拒绝 |
| `highest` | 交易、审批、管理动作、受限数据 | 决策、审批和结果均同步记录；审计完全不可用时 fail-close |

保留期、导出审批、脱敏和访问权限遵循企业审计制度。审计日志本身按敏感数据管理。

### 9.5 与 EA 现有审计能力的对齐情况

| 需求 | 当前基础 | 满足度 | 缺口 |
|---|---|---:|---|
| 主体/组织/岗位/实例 | `audit_events` 已有 actor/org/role/agent 字段 | 基本满足 | 企业 Token 尚未统一映射这些字段 |
| 请求与链路关联 | 已有 request/session/correlation 字段 | 部分满足 | MCP 尚未统一传播 W3C trace context |
| ALLOW/DENY 留痕 | PreToolUse 已记录治理决定 | 部分满足 | 不是所有 MCP 都被证明必经该入口 |
| 审计可靠性 | `audit-ledger.ts` 支持 DB、DLQ、排水和脱敏；连接配置、策略和岗位授权变更已 fail-close | 部分满足 | MCP 工具调用的 `strong/highest` 事件尚未全部接入统一 fail-close 执行路径 |
| 参数保护 | 已有脱敏、16KB 截断和 `toolInputHash` | 基本满足 | MCP 调用事件尚未统一落账 |
| 策略证据 | metadata 中可记 `policyDecisionId` | 部分满足 | `policyDecisionId/ruleVersion` 尚无独立列和稳定查询 |
| 审批证据 | 现有前端应答通道 | 不满足 | 审批未持久化、未绑定参数、不可单次消费 |
| MCP 双侧证据 | 无统一契约 | 不满足 | MCP 服务需实现审计并回传业务请求号 |
| 租户/行级授权 | 部分本地适配器自定义实现 | 不满足 | 缺统一 `tenant_id/sub/scope` 契约和服务端中间件 |

结论:EA 的审计底座质量足够，不需要重写；需要把企业 MCP 调用接入这套底座，并补齐策略列、审批表、强审计 action 和双侧关联字段。

---

## 10. 服务端强制校验

统一认证中间件至少完成:

```text
1. Authorization Bearer 存在                         -> 否则 401
2. 签名有效且算法锁定                               -> 否则 401
3. iss 为受信签发方                                 -> 否则 401
4. aud 等于当前 resourceUri                         -> 否则 401
5. exp/nbf/iat 合理，时钟偏移不超过 60 秒           -> 否则 401
6. identityMode 所需 tenant_id/sub 存在             -> 否则 401
7. scope 覆盖当前工具                               -> 否则 403
8. tenant_id/sub 行级授权通过                       -> 否则 403
9. 写工具具备审批/幂等上下文                         -> 否则 409/403
10. 记录双侧审计并返回 businessRequestId             -> 失败按 auditLevel 处理
```

错误约定:

| HTTP | 含义 | 平台行为 |
|---|---|---|
| `400` | MCP/授权请求格式错误 | 不重试 |
| `401` | Token 缺失、无效或过期 | 重新取 Token，最多一次 |
| `403` | scope 或业务数据权限不足 | 不重试，记审计 |
| `409` | 幂等/状态冲突 | 查询原业务结果，不盲目重试 |
| `429` | 限流 | 有上限的退避重试 |
| `5xx` | 服务异常 | 仅只读/幂等调用可有限重试 |

错误响应不得回显 Token、JWT、SQL、堆栈、内部路径或客户数据。

---

## 11. 开发者与平台责任

| 事项 | EA 平台 | MCP 开发者 | 管理员/业务部门 |
|---|---:|---:|---:|
| 企业注册表、岗位授权、工具策略 | 主责 | 提供元数据 | 审批配置 |
| HTTPS 域名与统一网关 | 主责 | 配合源站限制 | - |
| Access Token 签发、JWKS | 主责 | 验签 | - |
| MCP Streamable HTTP 实现 | 兼容客户端 | 主责 | - |
| tenant/user 行级过滤 | 传可信身份 | 主责 | 确认业务规则 |
| 下游业务凭证 | 不持有 | 主责 | 业务系统授权 |
| PreToolUse/审批/幂等治理 | 主责 | 校验上下文 | 审批高风险能力 |
| 双侧审计 | 平台侧主责 | 服务侧主责 | 确定保留期/审计访问 |
| 健康、指标、告警 | 汇总展示 | 暴露服务指标 | 指定负责人 |

Nginx 只能完成 TLS、路由和基础限流，不能代替身份验证、scope 校验、行级授权和业务审计。

---

## 12. 迁移计划

### 阶段 A:平台基础

1. 增加企业 MCP 注册表、岗位授权和工具策略表。
2. 在现有 EA `:5180` 内增加企业 MCP 网关，不新开业务端口。
3. 增加短期 Token 签发、JWKS 和资源元数据。
4. 把企业 MCP 接入 PreToolUse、出站护栏和审计台账。
5. 增加连接测试、工具发现和一致性验收工具。

### 阶段 B:两项保险标杆

1. 标准地址改为:
   - `/insurance/customer-profile/mcp`
   - `/insurance/product-exam-points/mcp`
2. 开发者接入统一验签中间件。
3. `customer-profile` 增加租户/用户过滤。
4. `product-exam-points` 查询按租户隔离，`save_product` 按用户授权、审批和幂等。
5. 先 `shadow` 对比身份、结果和审计，再切 `enforced`。
6. 原始 MCP 源站收紧为仅网关可达，不在客户端配置或公开文档中暴露源站地址。

### 阶段 C:财富数据

当前 `18007/18008` 是 MCP 适配层，背后调用财富 REST API，不是业务系统本身。迁移时:

1. 保持工具名和 Schema 不变。
2. 移除 product adapter 中的硬编码用户映射。
3. 用统一 Token 替代 `x-linggan-agent-id/x-linggan-user-code` 的裸 Header 信任。
4. 让财富业务 API 继续作为客户归属真相源。
5. 切换到标准域名后关闭对外源端口，仅保留受控源站访问。

### 阶段 D:其余能力

- `post_loan_risk_data`:敏感数据，按 `user` 模式迁移。
- `wind_*`:公开金融数据，可保持本机 stdio；只有需要共享扩容时再远程 HTTP 化。
- `platform_tools`:保持平台内部调用。
- `custom_mcp_gateway`:保持用户连接器模型，绝不下发企业身份。

迁移状态:

| 状态 | 行为 |
|---|---|
| `legacy` | 旧链路运行，登记风险和责任人 |
| `shadow` | 新网关并行验证身份/策略/审计，不影响主结果 |
| `enforced` | 所有生产调用强制走新网关 |
| `disabled` | 禁止调用，保留审计和配置历史 |

---

## 13. 验收清单

### 13.1 协议与网络

- [ ] HTTPS 证书有效，原始端口仅网关可达
- [ ] Streamable HTTP 请求/响应符合声明版本
- [ ] `2026-07-28` 服务无协议 session 依赖
- [ ] `2025-11-25` 兼容服务逐请求验证身份，session 绑定主体
- [ ] 超时、取消、限流和只读重试策略可验证

### 13.2 认证与授权

- [ ] 无 Bearer Token 返回 `401`
- [ ] 篡改签名、错误 `iss`、错误 `aud`、过期 Token 返回 `401`
- [ ] `identityMode=user` 缺 `sub` 或 `tenant_id` 返回 `401`
- [ ] scope 不足返回 `403` 和明确的最小 scope challenge
- [ ] A 用户不能读取 B 用户数据
- [ ] A 租户不能读取 B 租户数据
- [ ] MCP 不接受未签名普通 Header 作为最终身份
- [ ] MCP 不向下游透传 EA Access Token

### 13.3 工具治理

- [ ] 工具列表已发现并由管理员确认 sideEffect
- [ ] 未登记写工具被 fail-close
- [ ] 写/外发/交易/审批/管理工具必经 PreToolUse
- [ ] 需要审批的调用绑定 `toolInputHash`
- [ ] 同一审批只能消费一次
- [ ] 幂等重试不会重复写业务数据

### 13.4 审计

- [ ] 平台记录 requested/decision/completed 三段事件
- [ ] MCP 记录身份、行级授权结果和业务请求号
- [ ] 平台与 MCP 可通过 trace/correlation 关联
- [ ] 能还原 policyDecisionId、ruleVersion、scope 和参数 hash
- [ ] 审计中不含 Token、私钥和客户敏感明文
- [ ] 强/最高审计不可用时调用 fail-close
- [ ] DB 写入失败后 DLQ 可排水并去重

### 13.5 运维

- [ ] 服务负责人、告警联系人和环境已登记
- [ ] Token/JWKS 轮换已演练
- [ ] 服务异常、超时、401/403/429 指标可观测
- [ ] 可按 serverId/toolName/tenant/role 查询审计
- [ ] 旧地址和旧凭证有明确下线日期

---

## 14. 当前满足度与下一步

### 当前判断

| 维度 | 判断 |
|---|---|
| 方案完整性 | 已清晰，可作为企业 MCP 设计基线 |
| 传输与地址规范 | 已明确，现网可渐进迁移 |
| 企业身份与权限 | EA 已实现统一 registry、ES256 短期 Token 和多密钥 JWKS；服务侧验签与行级过滤待标杆 MCP 接入 |
| 工具治理 | EA 已有 PreToolUse 和 sideEffect 注册表，可直接复用 |
| 审计底座 | 基本满足，属于现有代码的强项 |
| MCP 审计闭环 | EA 已实现 requested/completed 强审计和持久化调用回执；服务侧业务审计待接入 |
| 写操作审批 | 尚不满足，需先完成审批持久化和参数绑定 |
| 多租户/行级隔离 | 依赖各 MCP 实现，当前两个标杆服务尚未证明满足 |

### 实施顺序

1. 先实现企业 MCP 注册表和只读网关，不改现有业务结果。
2. 接入短期 Token/JWKS、PreToolUse 和 MCP 平台侧审计。
3. 让两项保险 MCP 开发者接入统一验签、租户/用户过滤和服务侧审计。
4. 完成 `shadow` 验证后再切 `enforced`。
5. 写工具上线前，先补审批持久化、参数绑定、单次消费和幂等。
6. 标杆通过后，将同一中间件和验收套件提供给财富、风控等后续 MCP。

---

## 15. 参考基线

- MCP 2026-07-28 Streamable HTTP:
  `https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http`
- MCP 2026-07-28 Authorization:
  `https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization`
- MCP 2026-07-28 Tools:
  `https://modelcontextprotocol.io/specification/2026-07-28/server/tools`
- EA 受控运行时计划:`docs/governed-agent-runtime-plan.md`
- EA 架构审计:`docs/architecture-audit-rcagca.md`
- EA 工具治理:`server/_core/tool-governance.ts`
- EA PreToolUse:`server/_core/tool-egress-routes.ts`
- EA 审计台账:`server/_core/audit-ledger.ts`
