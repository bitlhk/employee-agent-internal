#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const HOST = process.env.BOND_QUOTE_HTTP_MCP_HOST || "127.0.0.1";
const PORT = Number(process.env.BOND_QUOTE_HTTP_MCP_PORT || 17892);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = process.env.BOND_QUOTE_HTTP_MCP_ENV || join(__dirname, "bond-quote-http-mcp.env");

loadDotenv(ENV_FILE);

const TOOLS = [
  {
    name: "bond_parse_schema",
    description: "获取 BCCP 契约说明（GET /api/v1/parse/schema）。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bond_parse_validate",
    description: "校验语料包 JSON（POST /api/v1/parse/validate）。bccp_json 为完整 BCCP 对象字符串。",
    inputSchema: {
      type: "object",
      properties: {
        bccp_json: { type: "string", description: "完整 BCCP 对象字符串，含 schema_version、messages 等。" },
      },
      required: ["bccp_json"],
      additionalProperties: false,
    },
  },
  {
    name: "bond_parse_batch",
    description: "批量解析报价语料（POST /api/v1/parse/batch）。bccp_json 为完整 BCCP 对象字符串。",
    inputSchema: {
      type: "object",
      properties: {
        bccp_json: { type: "string", description: "完整 BCCP 对象字符串；返回含 quotes_table、items、summary。" },
      },
      required: ["bccp_json"],
      additionalProperties: false,
    },
  },
  {
    name: "bond_parse_health",
    description: "检查上游 API 是否可达（GET /api/health）。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function loadDotenv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    process.env[key.trim()] = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
  }
}

function upstream() {
  const value = (process.env.BOND_PARSE_UPSTREAM || "").trim();
  if (!value) {
    throw new Error("BOND_PARSE_UPSTREAM is required for bond quote parsing.");
  }
  return value.replace(/\/+$/, "");
}

function headers() {
  const out = { "Content-Type": "application/json", Accept: "application/json" };
  const key = (process.env.BOND_PARSE_API_KEY || "").trim();
  if (key) out.Authorization = `Bearer ${key}`;
  return out;
}

async function requestJson(method, path, body, timeoutMs) {
  const resp = await fetch(`${upstream()}${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 8000) };
  }
  const result = {
    http_status: resp.status,
    ok: resp.ok,
    body: parsed,
  };
  const warn = resp.headers.get("X-Auth-Warning");
  if (warn) result.auth_warning = warn;
  return result;
}

function parseBccp(input) {
  const raw = input?.bccp_json;
  if (typeof raw !== "string" || !raw.trim()) throw new Error("bccp_json 不能为空");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("bccp_json 须为 JSON 对象");
  }
  return parsed;
}

async function callTool(name, input) {
  if (name === "bond_parse_schema") {
    return requestJson("GET", "/api/v1/parse/schema", undefined, 60_000);
  }
  if (name === "bond_parse_validate") {
    return requestJson("POST", "/api/v1/parse/validate", parseBccp(input), 120_000);
  }
  if (name === "bond_parse_batch") {
    return requestJson("POST", "/api/v1/parse/batch", parseBccp(input), 600_000);
  }
  if (name === "bond_parse_health") {
    return requestJson("GET", "/api/health", undefined, 30_000);
  }
  throw new Error(`Unknown bond quote tool: ${name}`);
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") return null;
  if (message.method === "notifications/initialized") return null;
  try {
    if (message.method === "initialize") {
      return message.id === undefined ? null : jsonRpcResult(message.id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "bond-quote-parse", version: "0.1.0" },
        instructions: "转发债券群聊语料到 bond_assistant 解析 API。优先使用 bond_parse_validate / bond_parse_batch，不要臆造报价字段。",
      });
    }
    if (message.method === "tools/list") {
      return message.id === undefined ? null : jsonRpcResult(message.id, { tools: TOOLS });
    }
    if (message.method === "tools/call") {
      const value = await callTool(message.params?.name, message.params?.arguments || {});
      return message.id === undefined ? null : jsonRpcResult(message.id, toolResult(value));
    }
    return message.id === undefined ? null : jsonRpcError(message.id, -32601, `Unknown method: ${message.method}`);
  } catch (err) {
    return message.id === undefined ? null : jsonRpcError(message.id, -32000, err?.message || String(err));
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (req.method !== "POST" || !/^\/mcp\/?$/.test(req.url || "")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  try {
    const raw = await readBody(req);
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    const response = Array.isArray(parsed)
      ? (await Promise.all(parsed.map(handleMessage))).filter(Boolean)
      : await handleMessage(parsed);
    if (!response || (Array.isArray(response) && response.length === 0)) {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Mcp-Session-Id": "bond-quote-http-mcp",
    });
    res.end(JSON.stringify(response));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify(jsonRpcError(null, -32000, err?.message || String(err))));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`bond-quote-http-mcp listening on http://${HOST}:${PORT}`);
});
