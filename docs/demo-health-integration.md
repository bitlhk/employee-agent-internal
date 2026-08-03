# 灵感 Demo 健康状态接入指南

灵感首页对所有 Demo 使用同一套状态样式和探测协议。新增 Demo 默认只检测访问入口，不要求开发者修改代码；需要展示模型、工作流或 Agent Runtime 状态时，再实现标准健康端点。

## 1. 接入级别

| Profile               | 适用类型                    | 首页展示项                         |
| --------------------- | --------------------------- | ---------------------------------- |
| `entry`               | 任意网站、未改造的历史 Demo | 访问入口                           |
| `model-app`           | 直接调用模型的自研应用      | 应用服务、模型服务                 |
| `openjiuwen-workflow` | openJiuwen Studio 工作流    | 应用服务、工作流、模型服务         |
| `jiuwenswarm-agent`   | JiuwenSwarm Agent 应用      | 应用服务、Agent 运行时、模型服务   |
| `custom`              | 需要自定义组件的应用        | 由双方约定，首页仍使用统一组件渲染 |

默认值是 `entry`。只要 Demo 的 `https://<experienceId>.demo.linggan.top/` 能返回 HTTP 2xx 或 3xx，首页就显示“运行正常”。

## 2. 标准端点

深度监测统一提供：

```text
GET /.well-known/linggan-health
```

响应必须是 JSON：

```json
{
  "schemaVersion": "1.0",
  "profile": "jiuwenswarm-agent",
  "status": "operational",
  "checkedAt": "2026-08-03T08:00:00.000Z",
  "components": [
    {
      "key": "application",
      "status": "operational",
      "checkedAt": "2026-08-03T08:00:00.000Z"
    },
    {
      "key": "runtime",
      "status": "operational",
      "checkedAt": "2026-08-03T08:00:00.000Z"
    },
    {
      "key": "model",
      "status": "operational",
      "checkedAt": "2026-08-03T08:00:00.000Z"
    }
  ]
}
```

状态值只有四种：

- `operational`: 核心能力可用。
- `degraded`: 页面可访问，但部分能力异常或深度监测不完整。
- `outage`: 核心能力不可用。
- `unknown`: 尚未得到足够证据。

组件 key 使用小写英文。通用 key 为 `entry`、`application`、`workflow`、`runtime`、`model`。

## 3. 实现原则

健康端点必须返回缓存快照，不能在每次 HTTP 请求中同步调用模型。建议后台每 30 至 60 秒检查应用和 Runtime；模型状态优先复用真实业务成功记录，长时间无业务流量时再按需执行低频、低 Token 的探测。

健康响应不得包含：

- 模型名称、API 地址、主机地址；
- Token、密钥、账号、内部路径；
- 异常堆栈或第三方原始错误；
- 用户、租户或业务数据。

首页会缓存探测结果，并在连续两次失败后才显示“暂不可用”，避免短暂网络抖动造成红色告警。

## 4. Express 示例

```ts
import express from "express";

const app = express();
let snapshot = {
  schemaVersion: "1.0",
  profile: "model-app",
  status: "unknown",
  checkedAt: new Date().toISOString(),
  components: [
    {
      key: "application",
      status: "operational",
      checkedAt: new Date().toISOString(),
    },
    { key: "model", status: "unknown", checkedAt: new Date().toISOString() },
  ],
};

app.get("/.well-known/linggan-health", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=15, stale-if-error=60");
  res.json(snapshot);
});

// 后台定时更新 snapshot，不要在健康请求里直接调用模型。
```

## 5. FastAPI 示例

```python
from datetime import datetime, timezone
from fastapi import FastAPI

app = FastAPI()

snapshot = {
    "schemaVersion": "1.0",
    "profile": "openjiuwen-workflow",
    "status": "unknown",
    "checkedAt": datetime.now(timezone.utc).isoformat(),
    "components": [
        {"key": "application", "status": "operational", "checkedAt": datetime.now(timezone.utc).isoformat()},
        {"key": "workflow", "status": "unknown", "checkedAt": datetime.now(timezone.utc).isoformat()},
        {"key": "model", "status": "unknown", "checkedAt": datetime.now(timezone.utc).isoformat()},
    ],
}

@app.get("/.well-known/linggan-health")
def linggan_health():
    return snapshot
```

## 6. Nginx 与认证

标准端点必须允许灵感首页服务器匿名读取，但只返回上述最小状态。若应用默认强制登录，在登录跳转规则之前单独放行：

```nginx
location = /.well-known/linggan-health {
    proxy_pass http://127.0.0.1:5180/.well-known/linggan-health;
    proxy_set_header Host $host;
    proxy_connect_timeout 2s;
    proxy_read_timeout 5s;
}
```

不要把 Prometheus、Grafana 或内部 `/health/ready` 直接公开。标准端点是专门用于首页展示的脱敏快照。

## 7. 首页配置

在灵感后台的“场景体验配置”中设置：

1. 状态监测：启用。
2. 监测级别：选择对应 Profile；未改造应用保持“仅检测访问入口”。
3. 健康端点：默认 `/.well-known/linggan-health`，通常不需要修改。

EA 使用 `jiuwenswarm-agent`。EA 默认公开标准端点；可用以下环境变量控制低频模型探测：

```bash
EA_PUBLIC_HEALTH_ENABLED=true
EA_PUBLIC_HEALTH_INTERVAL_MS=30000
EA_MODEL_HEALTH_SUCCESS_TTL_MS=1800000
EA_MODEL_HEALTH_PROBE_ENABLED=false
```

`EA_MODEL_HEALTH_PROBE_ENABLED=false` 时，真实对话成功会把模型标记为正常；超过成功证据有效期且没有新对话时显示“未检测”。生产环境希望持续展示模型状态时可开启低频探测。

## 8. 验收

```bash
curl -fsS https://<experienceId>.demo.linggan.top/.well-known/linggan-health | jq
```

确认：

- HTTP 200，响应时间建议小于 500ms；
- `schemaVersion` 为 `1.0`；
- `status` 和各组件状态只使用规定枚举；
- 停止 Runtime 或让模型探测失败后，状态会在两个探测周期内变化；
- 响应中没有地址、密钥、错误堆栈和用户数据。
