# 企业 MCP 服务可信身份接入指南

## 1. 服务开发者需要完成什么

EA 已在调用企业 MCP 前完成岗位授权、工具策略、数据护栏和审计。MCP 服务仍必须自行完成:

1. 从 `Authorization: Bearer <token>` 取出 EA 短期 Access Token。
2. 使用 EA JWKS 校验 ES256 签名、`iss`、`aud`、`exp`、`nbf`和 `kid`。
3. 校验 `server_id`、`tool_name`和 `scope`，不能只判断“Token 有效”。
4. 按 `identity_mode` 使用 `tenant_id` 或 `user_id` 做数据库行级过滤。
5. 记录 `request_id`、`actor_user_id`、`agent_id`、`server_id`、`tool_name`和业务结果编号，不记录 Token 原文。
6. 在 MCP 结果 `_meta.businessRequestId` 中返回业务侧请求号，便于双侧审计关联。

MCP 服务不得信任客户端自行传入的 `X-User-Id`、`X-Tenant-Id`、`role` 或工具参数中的用户标识。

后台执行工具发现时，Token 的 `tool_name` 为 `tools/list`，scope 为 `mcp.tools.read`。服务端应只返回该调用方可发现的工具定义，不执行任何业务操作。

## 2. 当前联调参数

| 项目 | 上海环境 | 本地/新加坡环境 |
|---|---|---|
| Issuer | `https://ling-claw.demo.linggan.top` | `https://work.linggan.top` |
| JWKS | `https://ling-claw.demo.linggan.top/api/enterprise-mcp/.well-known/jwks.json` | `https://work.linggan.top/api/enterprise-mcp/.well-known/jwks.json` |
| 签名算法 | `ES256` | `ES256` |
| Token 类型 | `at+jwt` | `at+jwt` |
| 默认有效期 | 120 秒 | 120 秒 |

每个环境有独立的 Issuer 和签名密钥。MCP 服务应维护允许的 Issuer/JWKS 列表，不得共享私钥。

### 密钥轮换

EA 使用一把当前私钥签发 Token，并可在 JWKS 中同时发布多把公钥。轮换时先把旧公钥写入仅包含公开 JWK 的 `ENTERPRISE_MCP_ADDITIONAL_JWKS_FILE`，再切换当前私钥和 `ENTERPRISE_MCP_KEY_ID`。旧公钥至少保留 24 小时，且必须长于最大 Token TTL 与各服务 JWKS 缓存时间之和；确认旧 Token 和缓存全部失效后再移除。

附加 JWKS 示例：

```json
{
  "keys": [
    {
      "kty": "EC",
      "crv": "P-256",
      "alg": "ES256",
      "use": "sig",
      "kid": "ea-mcp-es256-v1",
      "x": "...",
      "y": "..."
    }
  ]
}
```

附加文件不得包含私钥参数 `d`。MCP 服务必须按 Token Header 中的 `kid` 选择公钥；遇到未知 `kid` 时刷新 JWKS 一次，仍不存在则拒绝请求。

## 3. Token 核心声明

```json
{
  "iss": "https://work.linggan.top",
  "aud": "https://mcp.demo.linggan.top/insurance/customer-profile/mcp",
  "sub": "ea-user:123",
  "tenant_id": "tn_<opaque>",
  "user_id": 123,
  "actor_user_id": 123,
  "agent_id": "jiuwen_lgj-example",
  "adopt_id": "lgj-example",
  "role": "insurance-advisor",
  "server_id": "insurance_customer_profile",
  "tool_name": "list_customer_profiles",
  "identity_mode": "user",
  "scope": "insurance.customer.read",
  "request_id": "emcp_<uuid>"
}
```

`tenant_id` 是不透明稳定标识，不要将组织名称本身当作数据权限键。

## 4. Python 验签骨架

```python
import jwt
from jwt import PyJWKClient

ISSUER = "https://work.linggan.top"
AUDIENCE = "https://mcp.demo.linggan.top/insurance/customer-profile/mcp"
JWKS = f"{ISSUER}/api/enterprise-mcp/.well-known/jwks.json"
jwks_client = PyJWKClient(JWKS, cache_keys=True, lifespan=300)

def verify_ea_token(token: str, expected_server: str, expected_tool: str, required_scope: str):
    signing_key = jwks_client.get_signing_key_from_jwt(token)
    claims = jwt.decode(
        token,
        signing_key.key,
        algorithms=["ES256"],
        issuer=ISSUER,
        audience=AUDIENCE,
        options={"require": ["exp", "iat", "iss", "aud", "sub", "jti"]},
    )
    scopes = set(str(claims.get("scope", "")).split())
    if claims.get("server_id") != expected_server:
        raise PermissionError("server_id mismatch")
    if claims.get("tool_name") != expected_tool:
        raise PermissionError("tool_name mismatch")
    if required_scope not in scopes:
        raise PermissionError("scope denied")
    return claims
```

依赖为 `PyJWT[crypto]`。生产实现还应限制最大时钟偏差、缓存 JWKS、在 `kid` 变化时刷新，并对连续验签失败告警。

## 5. 两个标杆服务的改造要求

### customer-profile

- `aud`: `https://mcp.demo.linggan.top/insurance/customer-profile/mcp`
- `server_id`: `insurance_customer_profile`
- scope: `insurance.customer.read`
- 必须使用 `user_id + tenant_id` 限制客户查询范围。

### product-exam-points

- `aud`: `https://mcp.demo.linggan.top/insurance/product-exam-points/mcp`
- `server_id`: `insurance_product_exam_points`
- 查询 scope: `insurance.product.read`
- 查询使用 `tenant_id` 隔离企业产品库。
- `save_product` 需另行实现 `insurance.product.write`、幂等键和审批凭证；未完成前保持停用。

## 6. 切换顺序

1. 服务端先在测试环境完成验签、scope 和行级过滤。
2. EA 连接器改为 `oauth2_access_token + shadow`，服务端完成验签后由管理员执行“验证身份”。
3. 对比新旧结果、双侧请求号、行级过滤和失败告警。
4. EA 后台将认证方式改为“EA 短期令牌”，安全和业务验收后切换 `enforced`。
5. 最后限制源站端口只允许统一网关访问。

平台会同时验证有效 Token、无 Token、错误 audience、缺少 scope 和错误 tool binding。任一负向请求被服务接受，都不能进入 `enforced`。完整交付清单见 [enterprise-mcp-developer-handoff-v1.md](./enterprise-mcp-developer-handoff-v1.md)。
