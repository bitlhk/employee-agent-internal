# 企业 MCP 开发者接入与整改手册 v1

> 适用对象：业务 MCP 开发者、平台管理员、测试与安全人员
>
> 目标：把现有 IP/端口形式的 MCP 安全、可审计地接入 Employee Agent
> 首批标杆：保险客户画像、保险产品考点

## 1. 一页结论

统一调用链如下：

```text
岗位用户
  -> Employee Agent / JiuwenSwarm
  -> EA 企业 MCP 网关（岗位授权、策略、审批、幂等、审计）
  -> HTTPS Streamable HTTP MCP（验签、scope、行级权限、业务审计）
  -> 业务数据或业务系统
```

开发者不需要购买域名或自行申请公网证书。开发者提供源站 IP、端口和 MCP 路径，平台统一配置：

```text
https://mcp.demo.linggan.top/<业务域>/<能力>/mcp
```

但源站必须限制为仅允许平台反向代理访问。域名和 TLS 不能代替身份认证。

## 2. 双方责任

### 2.1 MCP 开发者负责

1. 提供标准 Streamable HTTP `/mcp` 端点和无敏感信息的 `/health` 端点。
2. 校验 EA 短期 ES256 Access Token，不接受普通 Header 或参数冒充用户身份。
3. 校验 `iss`、`aud`、`server_id`、`tool_name`、`scope`、`exp`、`nbf` 和 `kid`。
4. 按 `identity_mode` 实施租户或用户行级过滤。
5. 记录业务侧审计事件，并返回业务请求号。
6. 写操作实施业务幂等；未经平台确认前不得开放写工具。
7. 配合限制源站端口，只允许平台代理访问。

### 2.2 EA 平台负责

1. 分配规范域名、稳定 `serverId` 和 `resourceUri`。
2. 管理岗位授权、工具开关、副作用、scope、审批、幂等和审计策略。
3. 为每次调用签发不超过 5 分钟、绑定单一 MCP 和单一工具的 Access Token。
4. 发布 JWKS 并支持多 `kid` 无中断轮换。
5. 在调用前执行 Governance/PEP，在调用后保存平台调用回执和审计证据。
6. 对服务执行工具发现和可信身份负向验证，通过后才允许进入 `enforced`。

## 3. 开发者首次需要提交的信息

| 字段 | 必填 | 示例 |
|---|---:|---|
| 服务名称 | 是 | 保险客户画像 |
| 负责人及团队 | 是 | 姓名、团队、联系方式 |
| 源站 IP / 主机 | 是 | `43.167.157.125` |
| 源站端口 | 是 | `8765` |
| MCP 路径 | 是 | `/mcp` |
| 健康检查路径 | 是 | `/health` |
| 协议版本 | 是 | `2025-11-25`，后续升级 `2026-07-28` |
| 工具清单 | 是 | 名称、说明、输入 Schema |
| 数据范围 | 是 | 公开、内部、敏感、严格受限 |
| 身份模式 | 是 | `platform` / `tenant` / `user` |
| 所属岗位 | 是 | `insurance-advisor` |
| 每个工具的副作用 | 是 | read / write / external_send 等 |
| 预计超时和并发 | 是 | 30 秒、20 并发 |
| 下游系统及幂等能力 | 写工具必填 | 业务请求号、幂等键规则 |

不要通过文档、聊天或 URL 提交 API Key、数据库密码和长期 Token。

## 4. 固定环境参数

### 上海演示环境

| 项目 | 值 |
|---|---|
| Issuer | `https://ling-claw.demo.linggan.top` |
| JWKS | `https://ling-claw.demo.linggan.top/api/enterprise-mcp/.well-known/jwks.json` |
| 算法 | `ES256` / P-256 |
| Token 类型 | `at+jwt` |
| 默认有效期 | 120 秒 |

### 本地/新加坡环境

| 项目 | 值 |
|---|---|
| Issuer | `https://work.linggan.top` |
| JWKS | `https://work.linggan.top/api/enterprise-mcp/.well-known/jwks.json` |

不同环境使用不同 Issuer 和密钥。服务端可以配置允许的多个 Issuer，但不得共享或索取 EA 私钥。

## 5. Token 验证规则

调用示例：

```http
POST /insurance/customer-profile/mcp HTTP/1.1
Authorization: Bearer <short-lived-access-token>
Content-Type: application/json
Accept: application/json, text/event-stream
```

典型 Claims：

```json
{
  "iss": "https://ling-claw.demo.linggan.top",
  "aud": "https://mcp.demo.linggan.top/insurance/customer-profile/mcp",
  "sub": "ea-user:123",
  "tenant_id": "tn_opaque",
  "user_id": 123,
  "actor_user_id": 123,
  "agent_id": "jiuwen_lgj-example",
  "adopt_id": "lgj-example",
  "role": "insurance-advisor",
  "server_id": "insurance_customer_profile",
  "tool_name": "list_customer_profiles",
  "identity_mode": "user",
  "scope": "insurance.customer.read",
  "request_id": "emcp_uuid",
  "iat": 1786150000,
  "nbf": 1786149995,
  "exp": 1786150120,
  "jti": "emcp_uuid"
}
```

服务端必须：

- 固定允许算法为 `ES256`，禁止接受 Token Header 自选算法。
- 按 `kid` 从 JWKS 选择公钥；未知 `kid` 时刷新 JWKS 一次，仍不存在则拒绝。
- 精确比较 `iss` 和 `aud`，不得只验签不验 audience。
- `server_id` 必须等于当前服务。
- `tool_name` 必须等于本次 JSON-RPC 实际执行的工具；Header、Token 与请求体不一致时拒绝。
- `scope` 必须包含该工具要求的 scope。
- 检查 `exp`、`nbf`、`iat`，时钟容差建议不超过 30 秒。
- 不记录 Token 原文，不把 Token 转发给下游业务系统。

后台工具发现是特殊的只读平台调用：

```text
identity_mode = platform
tool_name = tools/list
scope = mcp.tools.read
```

服务必须允许该调用列出工具，但不能借此读取业务数据。

## 6. 数据权限规则

### `platform`

只适用于公开数据、纯计算和不区分企业的数据。验证平台调用方后即可执行。

### `tenant`

每条查询都必须带服务端过滤条件：

```sql
WHERE tenant_id = :token_tenant_id
```

不得从工具参数读取 `tenant_id` 代替 Token Claim。

### `user`

客户、持仓、信贷、任务等数据至少同时过滤：

```sql
WHERE tenant_id = :token_tenant_id
  AND owner_user_id = :token_user_id
```

若业务采用团队、机构或客户经理归属表，应由服务端根据可信 `user_id` 展开授权范围，不得信任参数中的用户名、工号或客户经理 ID。

## 7. 双侧审计与返回格式

MCP 服务应记录：

```text
request_id
tenant_id
actor_user_id
adopt_id / agent_id
server_id
tool_name
scope
业务对象编号（非敏感）
结果：success / denied / failed
耗时
业务请求号或业务回执号
```

禁止记录 Access Token、密码、完整证件号、完整客户资料和未经脱敏的工具结果。

工具结果建议返回：

```json
{
  "content": [{ "type": "text", "text": "..." }],
  "_meta": {
    "businessRequestId": "biz_20260810_001"
  }
}
```

平台会把 `businessRequestId` 与 `request_id`、策略决定、岗位实例和调用回执关联。

## 8. 写操作额外要求

写入、外发、审批、金融和管理动作必须同时满足：

1. 平台工具策略显式标记副作用，未知工具默认不能开放写能力。
2. 平台 Governance 返回允许或已完成人工确认。
3. 请求包含 `idempotency_key`。
4. MCP 服务端使用唯一约束或原子占用保证同一键只执行一次。
5. 同一幂等键配不同参数时拒绝，不得覆盖原动作。
6. 返回持久业务回执，重试时复用原结果。

人工确认只证明“用户同意”，不能替代服务端幂等。

## 9. 平台可信身份验收

后台“企业连接器 → 验证身份”会自动执行：

| 探测 | 期望 |
|---|---|
| 有效 Token + `mcp.tools.read` + `tools/list` | 成功并返回工具 |
| 不带 Token | 拒绝 |
| 错误 `aud` | 拒绝 |
| 缺少 `mcp.tools.read` | 拒绝 |
| Token `tool_name` 与实际方法不一致 | 拒绝 |

任一负向探测被接受，验证状态均为失败。以下配置变化会自动清除旧验证结果，必须重新验证：

- MCP 地址或 Resource URI
- 认证方式
- 身份模式
- 协议版本

连接器只有同时满足以下条件，才能切换为 `enforced`：

- 平台短期令牌签发就绪
- 工具发现成功
- 可信身份验证通过
- 至少一个工具策略启用
- 至少授权给一个岗位

## 10. 服务端最低自动化测试

每个 MCP 在申请切换前，至少提交以下测试结果：

1. 有效 Token 调用成功。
2. 无 Token 返回 `401`。
3. 签名错误、未知 `kid`、过期 Token 返回 `401`。
4. 错 `iss`、错 `aud` 返回 `401` 或 `403`。
5. 错 `server_id`、错 `tool_name`、缺 scope 返回 `403`。
6. 租户 A 不能读取租户 B 数据。
7. 用户 A 不能读取用户 B 客户数据。
8. 参数伪造 `user_id` / `tenant_id` 不改变服务端授权范围。
9. 审计日志不含 Token 和敏感原文。
10. 写工具重复请求只产生一次业务动作。

## 11. 两个标杆的明确整改项

### 11.1 保险客户画像

```text
serverId: insurance_customer_profile
URL: https://mcp.demo.linggan.top/insurance/customer-profile/mcp
identityMode: user
aud: 与 URL 完全一致
scope: insurance.customer.read
岗位: insurance-advisor
```

必须完成：

- `list_customer_profiles` 和 `get_customer_profile_by_name` 校验完整 Token 契约。
- 所有数据查询同时按 `tenant_id + user_id` 过滤。
- 参数中的用户身份只可作为查询条件，不能作为授权身份。
- 记录双侧审计字段并返回 `businessRequestId`。
- 原始 `43.167.157.125:8765` 只允许平台代理访问。

### 11.2 保险产品考点

```text
serverId: insurance_product_exam_points
URL: https://mcp.demo.linggan.top/insurance/product-exam-points/mcp
identityMode: tenant（写工具覆盖为 user）
aud: 与 URL 完全一致
read scope: insurance.product.read
write scope: insurance.product.write
岗位: insurance-advisor
```

必须完成：

- 四个查询工具按 `tenant_id` 隔离产品库。
- 验证完整 Token 契约并记录双侧审计。
- 原始 `43.167.157.125:8766` 只允许平台代理访问。
- `save_product` 继续停用。只有完成用户身份、人工确认、业务幂等和回执复用后才能单独申请开放。

## 12. 上线流程

```text
1. 开发者提交接入信息
2. 平台分配 serverId 和标准域名
3. 平台登记为 oauth2_access_token + shadow
4. 开发者完成验签、scope、行级权限和审计
5. 平台执行工具发现
6. 平台执行可信身份正负向验证
7. 联合测试跨租户、跨用户、审计和失败场景
8. 限制源站只允许平台代理访问
9. 安全与业务负责人确认
10. 平台切换 enforced
11. 观察稳定后删除旧直连和重复个人连接
```

禁止跳过 `shadow` 直接上线，禁止在验证失败时通过关闭鉴权或开启无鉴权影子调用绕过。

## 13. 开发者交付模板

```text
服务名称：
负责人/团队：
源站 IP、端口、路径：
健康检查路径：
协议版本：
身份模式：platform / tenant / user
数据分级：public / internal / sensitive / restricted
岗位范围：
工具清单：
每个工具 scope：
每个工具副作用：
写工具幂等方案：
业务审计存储位置：
业务请求号返回字段：
允许访问源站的代理 IP：
自动化测试结果：
```

更完整的架构和迁移原则见 [mcp-integration-spec-v1.md](./mcp-integration-spec-v1.md)，验签代码骨架见 [mcp-service-trusted-identity-guide.md](./mcp-service-trusted-identity-guide.md)。
