#!/usr/bin/env node
import { createServer } from "node:http";

const HOST = process.env.HELLO_BUSINESS_TOOL_HOST || "127.0.0.1";
const PORT = Number(process.env.HELLO_BUSINESS_TOOL_PORT || 17999);

const TOOLS = [
  {
    name: "hello_business_lookup",
    description: "Return a demo business lookup result for the provided query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Lookup query" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

function jsonRpc(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function send(res, payload) {
  const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method !== "POST" || req.url !== "/mcp") {
    res.writeHead(404);
    res.end("not found");
    return;
  }

  let msg;
  try {
    msg = await readJson(req);
  } catch {
    send(res, jsonRpcError(null, -32700, "Invalid JSON"));
    return;
  }

  const { id, method, params } = msg;
  if (method === "initialize") {
    send(
      res,
      jsonRpc(id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "hello-business-tool", version: "0.1.0" },
      }),
    );
    return;
  }

  if (method === "tools/list") {
    send(res, jsonRpc(id, { tools: TOOLS }));
    return;
  }

  if (method === "tools/call") {
    const name = String(params?.name || "");
    const query = String(params?.arguments?.query || "").trim();
    if (name !== "hello_business_lookup") {
      send(res, jsonRpcError(id, -32601, `Unknown tool: ${name}`));
      return;
    }
    send(
      res,
      jsonRpc(id, {
        content: [
          {
            type: "text",
            text: `Demo business result for query: ${query || "(empty)"}`,
          },
        ],
      }),
    );
    return;
  }

  send(res, jsonRpcError(id, -32601, `Unsupported method: ${method}`));
});

server.listen(PORT, HOST, () => {
  console.log(`hello-business-tool listening on http://${HOST}:${PORT}`);
});
