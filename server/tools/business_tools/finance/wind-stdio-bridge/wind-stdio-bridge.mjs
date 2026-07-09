#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SERVER_TYPE = process.argv[2];
const SKILL_DIR =
  process.env.WIND_MCP_SKILL_DIR ||
  join(homedir(), ".openclaw", "mcp", "wind-mcp-skill");

const SERVERS = {
  stock_data: "https://mcp.wind.com.cn/vserver_stock_data/mcp/",
  global_stock_data: "https://mcp.wind.com.cn/vserver_global_stock_data/mcp/",
  fund_data: "https://mcp.wind.com.cn/vserver_fund_data/mcp/",
  index_data: "https://mcp.wind.com.cn/vserver_index_data/mcp/",
  bond_data: "https://mcp.wind.com.cn/vserver_bond_data/mcp/",
  financial_docs: "https://mcp.wind.com.cn/vserver_financial_docs/mcp/",
  economic_data: "https://mcp.wind.com.cn/vserver_economic_data/mcp/",
  analytics_data: "https://mcp.wind.com.cn/vserver_analytics_data/mcp/",
};

if (!SERVERS[SERVER_TYPE]) {
  console.error(`Unknown Wind server_type: ${SERVER_TYPE || "(missing)"}`);
  process.exit(2);
}

function parseDotenv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed
      .slice(idx + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
  }
  return out;
}

function getApiKey() {
  if (process.env.WIND_API_KEY) return process.env.WIND_API_KEY;

  const localConfig = join(SKILL_DIR, "config.json");
  if (existsSync(localConfig)) {
    try {
      const cfg = JSON.parse(readFileSync(localConfig, "utf8"));
      if (cfg.wind_api_key) return cfg.wind_api_key;
    } catch {}
  }

  const globalConfig = join(homedir(), ".wind-aifinmarket", "config");
  if (existsSync(globalConfig)) {
    try {
      const env = parseDotenv(readFileSync(globalConfig, "utf8"));
      if (env.WIND_API_KEY) return env.WIND_API_KEY;
    } catch {}
  }
  throw new Error("WIND_API_KEY is not configured");
}

function loadToolNames() {
  const manifestPath = join(SKILL_DIR, "references", "tool-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const tools = manifest[SERVER_TYPE];
  if (!Array.isArray(tools)) return [];
  return tools;
}

function parseSseOrJson(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  let last = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data: ")) last = line.slice(6);
  }
  if (!last) throw new Error(`Unrecognized MCP response: ${text.slice(0, 160)}`);
  return JSON.parse(last);
}

async function remoteRequest(method, params, timeoutMs = 60_000) {
  const apiKey = getApiKey();
  const resp = await fetch(SERVERS[SERVER_TYPE], {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Wind HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  const payload = parseSseOrJson(text);
  if (payload.error) {
    throw new Error(payload.error.message || JSON.stringify(payload.error));
  }
  return payload.result;
}

async function remoteToolCall(name, args) {
  await remoteRequest(
    "initialize",
    {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "ea-wind-stdio-bridge", version: "0.1.0" },
    },
    30_000
  );
  return remoteRequest(
    "tools/call",
    {
      name,
      arguments: args || {},
      _meta: { clientVersion: "ea-wind-stdio-bridge/0.1.0" },
    },
    600_000
  );
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(message) {
  if (!message || !message.method) return;
  const id = message.id;
  try {
    if (message.method === "initialize") {
      result(id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: {
          name: `wind-${SERVER_TYPE}`,
          version: "0.1.0",
        },
      });
      return;
    }
    if (message.method === "tools/list") {
      const toolNames = loadToolNames();
      result(id, {
        tools: toolNames.map((name) => ({
          name,
          description: `Wind ${SERVER_TYPE} MCP tool: ${name}`,
          inputSchema: {
            type: "object",
            additionalProperties: true,
          },
        })),
      });
      return;
    }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      if (!loadToolNames().includes(name)) {
        throw new Error(`Unknown Wind tool for ${SERVER_TYPE}: ${name}`);
      }
      const remoteResult = await remoteToolCall(name, args);
      result(id, remoteResult);
      return;
    }
    if (id !== undefined) result(id, {});
  } catch (err) {
    if (id !== undefined) error(id, -32000, err?.message || String(err));
  }
}

let textBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  textBuffer += chunk;
  while (true) {
    const lineEnd = textBuffer.indexOf("\n");
    if (lineEnd < 0) break;
    const line = textBuffer.slice(0, lineEnd).replace(/\r$/, "");
    textBuffer = textBuffer.slice(lineEnd + 1);
    if (!line.trim()) continue;
    try {
      void handle(JSON.parse(line));
    } catch (err) {
      console.error(err?.message || String(err));
    }
  }
});
