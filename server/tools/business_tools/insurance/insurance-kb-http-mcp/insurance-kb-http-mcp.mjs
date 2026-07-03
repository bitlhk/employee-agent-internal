#!/usr/bin/env node
/**
 * insurance-kb-http-mcp
 * 保险知识库 HTTP MCP Adapter
 * 
 * 模式B：平台侧部署本机 HTTP MCP Adapter
 * Agent → http://127.0.0.1:9610/mcp → FastGPT API → 保险知识库
 * 
 * 符合岗位智能体平台内部 HTTP MCP 接入标准
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ==================== 私有 env 文件加载 ====================
// 必须在所有逻辑之前执行，覆盖 process.env
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(__dirname, "insurance-kb-http-mcp.env");

function loadPrivateEnv(path) {
  if (!existsSync(path)) {
    console.warn(`[env] private env file not found: ${path}`);
    return;
  }
  const text = readFileSync(path, "utf8");
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const i = trimmed.indexOf("=");
    if (i <= 0) continue;
    const key = trimmed.slice(0, i).trim();
    const value = trimmed.slice(i + 1).trim();
    process.env[key] = value;
    count++;
  }
  console.log(`[env] loaded ${count} vars from ${path}`);
}

loadPrivateEnv(ENV_FILE);

// ==================== 配置 ====================
const PORT = parseInt(process.env.MCP_PORT || "9610", 10);
const FASTGPT_BASE_URL = process.env.FASTGPT_BASE_URL || "http://localhost:29527";
const FASTGPT_API_KEY = process.env.FASTGPT_API_KEY || "";
const SERVICE_NAME = "insurance-kb-http-mcp";
const SERVICE_VERSION = "1.0.0";

// 默认知识库ID（部署时通过env配置）
const DEFAULT_KB_IDS = process.env.DEFAULT_KB_IDS
  ? process.env.DEFAULT_KB_IDS.split(",").map((s) => s.trim())
  : [];

// ==================== Express ====================
import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ==================== 统计 ====================
const stats = {
  total: 0,
  success: 0,
  errors: 0,
  startTime: Date.now(),
};

// ==================== 可信上下文提取 ====================
function extractContext(req) {
  const requestId = req.headers["x-request-id"] || randomUUID();
  const startTime = Date.now();
  const context = {
    agentId: req.headers["x-linggan-agent-id"] || req.headers["x-openclaw-agent-id"] || "",
    adoptId: req.headers["x-linggan-adopt-id"] || "",
    userId: req.headers["x-linggan-user-id"] || "",
    channelId: req.headers["x-jiuwen-channel-id"] || "",
    requestId,
    startTime
  };
  return context;
}

// ==================== FastGPT API 调用 ====================
async function callFastGPT(method, path, body) {
  const url = `${FASTGPT_BASE_URL}${path}`;
  const headers = {
    Authorization: `Bearer ${FASTGPT_API_KEY}`,
    "Content-Type": "application/json",
  };

  const opts = { method, headers };
  if (body && method !== "GET") {
    opts.body = JSON.stringify(body);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`FastGPT ${resp.status}: ${text.slice(0, 200)}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ==================== JSON-RPC 工具定义 ====================
const TOOLS = [
  {
    name: "insurance_kb_list",
    description:
      "列出保险知识库。返回可用的知识库ID和名称，用于后续检索时指定知识库。",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        name_filter: {
          type: "string",
          description: "知识库名称模糊搜索（可选，为空返回全部）",
        },
      },
    },
  },
  {
    name: "insurance_kb_search",
    description:
      "在保险知识库中检索内容。返回匹配的知识片段、分数和来源。用于获取产品信息、条款解释、异议处理话术等保险知识。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "检索关键词，如：平安e生保等待期、重疾险推荐",
        },
        kb_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "知识库ID列表，为空时使用默认知识库或全部知识库",
        },
        top_k: {
          type: "number",
          description: "返回数量，默认10",
        },
        score_threshold: {
          type: "number",
          description: "相似度阈值（0-1），默认0.0，低于此值的结果不返回",
        },
      },
      required: ["query"],
      additionalProperties: true,
    },
  },
];

// ==================== 工具实现 ====================

async function toolListKb(args, ctx) {
  const nameFilter = args.name_filter || "";

  try {
    const result = await callFastGPT("POST", "/api/core/dataset/list", {
      searchText: nameFilter,
      current: 1,
      pageSize: 50,
    });

    const datasets = result.data || [];
    const items = (Array.isArray(datasets) ? datasets : []).map((d) => ({
      kb_id: String(d._id || ""),
      name: d.name || "",
      description: d.intro || d.name || "",
      size: d.size || 0,
    }));

    return {
      ok: true,
      source: "fastgpt",
      summary: `找到 ${items.length} 个知识库`,
      total: items.length,
      items,
    };
  } catch (err) {
    console.error(`[insurance_kb_list] error:`, err.message);
    return {
      ok: false,
      errorCode: "FASTGPT_ERROR",
      message: err.message,
      source: "fastgpt",
      items: [],
      total: 0,
    };
  }
}

async function toolSearchKb(args, ctx) {
  const query = args.query;
  const kbIds =
    args.kb_ids && args.kb_ids.length > 0 ? args.kb_ids : DEFAULT_KB_IDS;
  const topK = args.top_k || 10;
  const scoreThreshold = args.score_threshold || 0;

  if (!query) {
    return {
      ok: false,
      errorCode: "MISSING_QUERY",
      message: "query is required",
      source: "fastgpt",
      items: [],
      total: 0,
    };
  }

  // 如果没指定kb_ids，先获取全部知识库列表
  let targetIds = kbIds;
  if (targetIds.length === 0) {
    try {
      const listResult = await callFastGPT("POST", "/api/core/dataset/list", {
        searchText: "",
        current: 1,
        pageSize: 50,
      });
      const datasets = listResult.data || [];
      if (Array.isArray(datasets)) {
        targetIds = datasets.map((d) => String(d._id)).filter(Boolean);
      }
    } catch (err) {
      console.error(`[insurance_kb_search] list error:`, err.message);
      return {
        ok: false,
        errorCode: "KB_LIST_FAILED",
        message: `获取知识库列表失败: ${err.message}`,
        source: "fastgpt",
        items: [],
        total: 0,
      };
    }
  }

  if (targetIds.length === 0) {
    return {
      ok: true,
      source: "fastgpt",
      summary: "无可用的知识库",
      items: [],
      total: 0,
    };
  }

  // 对每个知识库执行检索
  const allResults = [];

  for (const kbId of targetIds) {
    try {
      const searchResult = await callFastGPT(
        "POST",
        "/api/core/dataset/searchTest",
        {
          datasetId: kbId,
          text: query,
          topK: Math.min(topK * 5, 50), // 多取一些用于过滤
        }
      );

      const resultsList = searchResult?.data?.list || [];
      for (const item of resultsList) {
        let score = item.score;
        if (Array.isArray(score)) {
          score = score.length > 0 ? score[0]?.value || 0 : 0;
        }
        if (typeof score !== "number") score = 0;

        if (scoreThreshold > 0 && score < scoreThreshold) continue;

        allResults.push({
          kb_id: kbId,
          file_id: item.collectionId || "",
          chunk_id: item.id || "",
          content: item.a || item.q || "",
          score: Math.round(score * 1000) / 1000,
          title: item.sourceName || "Unknown",
        });
      }
    } catch (err) {
      console.error(`[insurance_kb_search] search ${kbId} error:`, err.message);
      // 单个知识库失败不中断，继续下一个
    }
  }

  // 按分数排序，截取topK
  allResults.sort((a, b) => b.score - a.score);
  const finalResults = allResults.slice(0, topK);

  return {
    ok: true,
    source: "fastgpt",
    summary: `检索到 ${finalResults.length} 条结果（搜索: ${query}）`,
    total: finalResults.length,
    items: finalResults,
    raw: {
      kb_count: targetIds.length,
      query,
      score_threshold: scoreThreshold,
    },
  };
}

// ==================== JSON-RPC 处理 ====================

function handleInitialize(id) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: SERVICE_NAME, version: SERVICE_VERSION },
      instructions:
        "保险知识库检索服务。提供知识库列表和知识检索能力，支持产品信息、条款解释、异议处理话术等保险知识检索。",
    },
  };
}

function handleToolsList(id) {
  return {
    jsonrpc: "2.0",
    id,
    result: { tools: TOOLS },
  };
}

async function handleToolsCall(id, params, ctx) {
  const { name, arguments: args = {} } = params || {};

  let details;

  switch (name) {
    case "insurance_kb_list":
      details = await toolListKb(args, ctx);
      break;
    case "insurance_kb_search":
      details = await toolSearchKb(args, ctx);
      break;
    default:
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Unknown tool: ${name}`,
        },
      };
  }

  // 双格式响应：content (给LLM) + details (给插件)
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify(details, null, 2),
        },
      ],
      details,
    },
  };
}

// ==================== 路由 ====================

// 健康检查
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    name: SERVICE_NAME,
    version: SERVICE_VERSION,
    uptime_seconds: Math.floor((Date.now() - stats.startTime) / 1000),
  });
});

// MCP 统一入口
app.post("/mcp", async (req, res) => {
  const body = req.body;
  const method = body.method;
  const id = body.id;
  const ctx = extractContext(req);

  stats.total++;

  try {
    let response;

    switch (method) {
      case "initialize":
        response = handleInitialize(id);
        break;

      case "notifications/initialized":
        // 通知不需要响应体
        res.status(202).json({});
        stats.success++;
        return;

      case "tools/list":
        response = handleToolsList(id);
        break;

      case "tools/call":
        response = await handleToolsCall(id, body.params, ctx);
        break;

      default:
        response = {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        };
    }

    const elapsed = Date.now() - ctx.startTime;
    console.log(JSON.stringify({
      requestId: ctx.requestId,
      method,
      agentId: ctx.agentId,
      status: response.error ? "error" : "ok",
      elapsed
    }));

    if (response.error) {
      stats.errors++;
    } else {
      stats.success++;
    }

    res.json(response);
  } catch (err) {
    stats.errors++;
    console.error(`[mcp] error:`, err.message);
    res.json({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: `Internal error: ${err.message}`,
      },
    });
  }
});

// 根路径
app.get("/", (req, res) => {
  res.json({
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    endpoints: {
      "GET /health": "健康检查",
      "POST /mcp": "JSON-RPC 2.0 MCP入口",
    },
  });
});

// ==================== 启动 ====================
app.listen(PORT, "127.0.0.1", () => {
  console.log(`[${SERVICE_NAME}] v${SERVICE_VERSION}`);
  console.log(`  listening: http://127.0.0.1:${PORT}/mcp`);
  console.log(`  FastGPT: ${FASTGPT_BASE_URL}`);
  console.log(`  API Key: ${FASTGPT_API_KEY ? FASTGPT_API_KEY.slice(0, 15) + "..." : "(empty)"}`);
  console.log(`  Default KB IDs: ${DEFAULT_KB_IDS.length > 0 ? DEFAULT_KB_IDS.join(", ") : "(all)"}`);
});
