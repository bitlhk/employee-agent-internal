# 财富经理助手 — MCP 服务部署包

## 包含服务

| 服务 | 目录 | 端口（默认） | 工具数 |
|------|------|-------------|--------|
| 产品 MCP | `product-mcp-server/` | 18007 | 6 |
| 客户 MCP | `customer-mcp-server/` | 18008 | 3 |

## 产品 MCP 工具列表

| 工具名 | 功能 |
|--------|------|
| `wealth_assistant_product_info` | 查询单个产品详情 |
| `wealth_assistant_product_search` | 搜索产品列表 |
| `wealth_assistant_fund_info` | 查询基金详细信息 |
| `wealth_assistant_nav_history` | 查询基金净值历史 |
| `wealth_assistant_wealth_product` | 查询理财产品详情 |
| `wealth_assistant_market_news` | 获取市场资讯 |

## 客户 MCP 工具列表

| 工具名 | 功能 |
|--------|------|
| `wealth_assistant_context_probe` | 获取当前操作上下文（用户身份、权限等） |
| `wealth_assistant_customer_list` | 查询客户列表（支持搜索和分页） |
| `wealth_assistant_customer_detail` | 查询单个客户详细信息 |

## 环境要求

- **Node.js** >= 18.0.0
- **npm** >= 8.0.0

## 部署步骤

### 1. 安装依赖

```bash
cd product-mcp-server && npm install --omit=dev
cd ../customer-mcp-server && npm install --omit=dev
```

### 2. 配置环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `WEALTH_API_BASE_URL` | 后端 API 地址 | `http://localhost:3001/api` |
| `WEALTH_API_TOKEN` | JWT 认证 Token | （必填） |
| `PRODUCT_MCP_PORT` | 产品 MCP 端口 | `18007` |
| `CUSTOMER_MCP_PORT` | 客户 MCP 端口 | `18008` |

### 3. 启动服务

```bash
# 产品 MCP
WEALTH_API_TOKEN='your-token' PRODUCT_MCP_PORT=18007 node product-mcp-server/dist/index.js

# 客户 MCP
WEALTH_API_TOKEN='your-token' CUSTOMER_MCP_PORT=18008 node customer-mcp-server/dist/index.js
```

推荐使用 PM2 管理进程：

```bash
npm install -g pm2

WEALTH_API_TOKEN='your-token' PRODUCT_MCP_PORT=18007 pm2 start product-mcp-server/dist/index.js --name product-mcp --interpreter node
WEALTH_API_TOKEN='your-token' CUSTOMER_MCP_PORT=18008 pm2 start customer-mcp-server/dist/index.js --name customer-mcp --interpreter node

pm2 save
```

### 4. 验证

```bash
# 健康检查
curl http://localhost:18007/health
curl http://localhost:18008/health
```

## MCP 协议信息

- **协议**: MCP Streamable HTTP（无状态模式）
- **SDK 版本**: `@modelcontextprotocol/sdk ^1.0.4`
- **MCP 端点**: `POST /mcp`
- **注册 URL 示例**:
  - 产品: `http://<服务器IP>:18007/mcp`
  - 客户: `http://<服务器IP>:18008/mcp`

## 技术架构

```
OpenClaw 平台
    │  MCP Streamable HTTP
    ▼
┌──────────────┐     ┌──────────────┐
│ 产品 MCP     │     │ 客户 MCP     │
│ :18007       │     │ :18008       │
└──────┬───────┘     └──────┬───────┘
       │ HTTP                │ HTTP
       ▼                     ▼
┌─────────────────────────────────────┐
│     后端 API (CRM 系统)             │
│     :3001/api                       │
└─────────────────────────────────────┘
```
