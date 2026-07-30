import { describe, expect, it } from "vitest";
import {
  createMcpLiveStatusResolver,
  parseMcpToolsListPayload,
} from "./mcp-live-status";

function toolsResponse(name: string): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      tools: [
        { name, description: `${name} description` },
        { name: "hidden_tool", description: "not selected" },
      ],
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("MCP live status resolver", () => {
  it("parses JSON and SSE tools/list responses", () => {
    expect(parseMcpToolsListPayload(JSON.stringify({
      result: { tools: [{ name: "lookup", description: "Lookup data" }] },
    }))).toEqual([{ name: "lookup", description: "Lookup data" }]);

    expect(parseMcpToolsListPayload([
      "event: message",
      `data: ${JSON.stringify({ result: { tools: [{ name: "stream_lookup" }] } })}`,
      "",
    ].join("\n"))).toEqual([{ name: "stream_lookup", description: "" }]);
  });

  it("probes different MCP servers concurrently", async () => {
    let started = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const resolver = createMcpLiveStatusResolver({
      fetchImpl: async () => {
        started += 1;
        await gate;
        return toolsResponse(`tool_${started}`);
      },
    });

    const request = resolver.fetchStatuses({
      alpha: { transport: "http", url: "https://alpha.example/mcp" },
      beta: { transport: "http", url: "https://beta.example/mcp" },
      gamma: { transport: "http", url: "https://gamma.example/mcp" },
    }, new Set(["alpha", "beta", "gamma"]));

    expect(started).toBe(3);
    release?.();
    const result = await request;
    expect(Object.keys(result).sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(Object.values(result).every((row) => row.status === "live")).toBe(true);
  });

  it("coalesces concurrent probes for the same server", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const resolver = createMcpLiveStatusResolver({
      fetchImpl: async () => {
        calls += 1;
        await gate;
        return toolsResponse("lookup");
      },
    });
    const servers = {
      alpha: { transport: "http", url: "https://alpha.example/mcp" },
    };
    const allowed = new Set(["alpha"]);

    const first = resolver.fetchStatuses(servers, allowed);
    const second = resolver.fetchStatuses(servers, allowed);
    expect(calls).toBe(1);

    release?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(calls).toBe(1);
  });

  it("returns stale status immediately while one background refresh runs", async () => {
    let currentTime = 1_000;
    let calls = 0;
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const resolver = createMcpLiveStatusResolver({
      now: () => currentTime,
      ttlMs: 10,
      staleMs: 100,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return toolsResponse("old_tool");
        await refreshGate;
        return toolsResponse("new_tool");
      },
    });
    const servers = {
      alpha: {
        transport: "http",
        url: "https://alpha.example/mcp",
        toolFilter: { include: ["old_tool", "new_tool"] },
      },
    };
    const allowed = new Set(["alpha"]);

    const initial = await resolver.fetchStatuses(servers, allowed);
    expect(initial.alpha.tools.map((tool) => tool.name)).toEqual(["old_tool"]);

    currentTime += 11;
    const stale = await resolver.fetchStatuses(servers, allowed);
    expect(stale.alpha.tools.map((tool) => tool.name)).toEqual(["old_tool"]);
    expect(calls).toBe(2);

    const concurrentStale = await resolver.fetchStatuses(servers, allowed);
    expect(concurrentStale.alpha.tools.map((tool) => tool.name)).toEqual(["old_tool"]);
    expect(calls).toBe(2);

    releaseRefresh?.();
    const refreshed = await resolver.fetchStatuses(servers, allowed, { force: true });
    expect(refreshed.alpha.tools.map((tool) => tool.name)).toEqual(["new_tool"]);
    expect(calls).toBe(2);
  });

  it("filters disabled, unauthorized, and non-HTTP servers without a network call", async () => {
    let calls = 0;
    const resolver = createMcpLiveStatusResolver({
      fetchImpl: async () => {
        calls += 1;
        return toolsResponse("unexpected");
      },
    });

    const result = await resolver.fetchStatuses({
      disabled: { transport: "http", url: "https://disabled.example/mcp", disabled: true },
      unauthorized: { transport: "http", url: "https://other.example/mcp" },
      local: { transport: "stdio", command: "node" },
    }, new Set(["disabled", "local"]));

    expect(result).toEqual({
      local: expect.objectContaining({ serverId: "local", status: "unsupported", tools: [] }),
    });
    expect(calls).toBe(0);
  });
});
