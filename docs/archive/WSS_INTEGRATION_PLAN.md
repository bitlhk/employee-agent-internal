# 岗位智能体平台 WebSocket 直连 OpenClaw Gateway 方案

## 背景

当前子虾聊天链路：
```
浏览器 → HTTP POST /api/claw/chat-stream → 岗位智能体平台 Node.js 代理 → HTTP /v1/chat/completions → Gateway → LLM
```

目标链路（WSS 优先 + HTTP 回退）：
```
优先：浏览器 → WSS ws://gateway:18789 → 直连 Gateway RPC
回退：浏览器 → HTTP POST（现有链路不变）
```

## OpenClaw Gateway WSS 协议（已验证）

### 握手流程

```
1. 浏览器建立 WebSocket 连接（带 Authorization: Bearer {token} header）
2. ← 收到 { type:"event", event:"connect.challenge", payload:{ nonce, ts } }
3. → 发送 {
     type: "req",
     id: {uuid},
     method: "connect",
     params: {
       minProtocol: 3,
       maxProtocol: 3,
       client: {
         id: "webchat",
         version: "1.0.0",
         platform: "lingxia",
         mode: "webchat"
       }
     }
   }
4. ← 收到 { type:"res", id:{同上}, ok:true } → 认证成功
5. 之后用 RPC 帧通信：sessions.send / sessions.subscribe 等
```

### RPC 帧格式

```json
// 请求
{ "type": "req", "id": "{uuid}", "method": "{method}", "params": { ... } }
// 响应
{ "type": "res", "id": "{对应req的id}", "ok": true/false, "result": { ... } }
// 事件
{ "type": "event", "event": "{event_name}", "payload": { ... } }
```

## 改动清单

### 1. 后端配置（5 分钟）

`/root/.openclaw/openclaw.json` 加 allowedOrigins：
```json
"controlUi": {
  "allowedOrigins": [
    "http://localhost:18789",
    "http://127.0.0.1:18789",
    "https://www.example.com",
    "https://ling-claw.demo.example.com"
  ]
}
```

### 2. 新增 WebSocket 客户端（核心）

文件：`client/src/lib/openclaw-ws.ts`

功能：
- 建连 + challenge 握手 + 认证
- 心跳保活（30 秒 ping）
- 断线自动重连（指数退避，最大 30 秒）
- 消息收发封装（Promise 化的 RPC 调用）
- 连接状态事件（connected / disconnected / error）

关键接口：
```typescript
class OpenClawWSClient {
  constructor(gatewayUrl: string, token: string)
  connect(): Promise<void>
  disconnect(): void
  sendMessage(agentId: string, message: string, sessionKey?: string): AsyncGenerator<ChatChunk>
  onEvent(handler: (event: GatewayEvent) => void): void
  get state(): 'connecting' | 'connected' | 'disconnected'
}
```

### 3. 改造聊天输入组件

文件：`client/src/components/ChatInput.tsx`

逻辑：
```typescript
// 初始化时尝试 WSS
const ws = new OpenClawWSClient(gatewayUrl, token);
try {
  await ws.connect();  // 3 秒超时
  useWSMode = true;
} catch {
  useWSMode = false;   // 降级到 HTTP SSE
}

// 发消息
if (useWSMode) {
  for await (const chunk of ws.sendMessage(agentId, message)) {
    // 处理流式响应
  }
} else {
  // 现有 HTTP POST /api/claw/chat-stream 逻辑不变
  fetch('/api/claw/chat-stream', { ... });
}
```

### 4. 适配消息格式

WSS 返回的 RPC 事件需要转换成现有 ChatMessage 组件能消费的格式：

```typescript
// Gateway WSS 事件 → 岗位智能体平台消息格式
{
  "type": "event",
  "event": "sessions.stream.delta",
  "payload": { "content": "你好" }
}
// 转换为
{
  choices: [{ delta: { content: "你好" } }]
}
```

### 5. 不改的部分

- `server/_core/claw-chat.ts` — HTTP SSE 代理逻辑完整保留作为 fallback
- `CollabDrawer.tsx` — 智能体协作面板不走 WSS（业务 agent 有各自的协议）
- 后端认证/鉴权 — 不变

## 自动降级策略

```
浏览器启动
  ↓
尝试 WSS 连接（3 秒超时）
  ├─ 成功 → WSS 模式（实时双向）
  └─ 失败 → HTTP SSE 模式（现有逻辑）
       ↓
  每 5 分钟尝试升级到 WSS
  ├─ 成功 → 下次对话切 WSS
  └─ 失败 → 继续 HTTP
```

## 华为内网兼容

| 场景 | 链路 | 是否可用 |
|------|------|---------|
| 外网访问 | WSS 直连 gateway | ✅ |
| 华为内网（WSS 放行） | WSS 直连 gateway | ✅ |
| 华为内网（WSS 被拦） | 自动降级 HTTP SSE | ✅ |
| localhost 开发 | WSS 直连 localhost:18789 | ✅ |

## 前端安全考虑

- Gateway token 不能暴露到浏览器端 → 需要岗位智能体平台后端签发短时 session token
- WSS 连接的 token 通过岗位智能体平台后端的 `/api/claw/ws-token` 接口获取（一次性，5 分钟有效）
- 或者岗位智能体平台后端做 WSS 代理（浏览器 → 岗位智能体平台 WSS → gateway WSS），token 不出服务端

## 工作量估算

| 任务 | 时间 |
|------|------|
| openclaw.json 配置 + 验证连通 | 10 分钟 |
| openclaw-ws.ts 客户端 | 3-4 小时 |
| ChatInput 改造（双模式） | 2-3 小时 |
| 消息格式适配 | 1-2 小时 |
| 断线重连 + 自动降级 | 1-2 小时 |
| 测试 + 边界场景 | 2-3 小时 |
| **合计** | **1.5-2 天** |

---

*文档生成时间：2026-04-09*
*基于 OpenClaw 2026.4.9 (0512059) 协议逆向验证*

---

## 附录：协议逆向验证结果（2026-04-09 实测）

### 设备认证完整流程（已跑通）

1. 生成 **Ed25519** 密钥对（不是 ECDSA）
2. device id = sha256(raw_public_key_32bytes) 转 hex
3. publicKey = base64url(raw_public_key_32bytes)
4. 签名 payload 格式（v2 协议），用竖线分隔：
   v2|deviceId|clientId|clientMode|role|scopes_comma_joined|signedAtMs|token|nonce
5. 签名 = ed25519_sign(privateKey, payload_utf8_bytes) 转 base64url
6. signedAt 是毫秒时间戳
7. 成功响应：type=res ok=true

### 关键发现

- 协议版本必须是 3
- 帧格式：type=req, id=uuid, method=xxx, params=xxx
- device identity 基于 Ed25519
- 签名 payload 是 v2 格式，用竖线分隔各字段
- allowedOrigins 已配置到 openclaw.json
- sessions.send 参数需要 key（session key）和 message

### 源码位置参考

- 设备身份：device-identity-D3srcfXR.js
- 服务端验证：server.impl-BxLfE9ri.js
- 帧 schema：method-scopes-Gjdcdc0s.js
- Control UI 客户端：control-ui/assets/index-Dts6VHgr.js
