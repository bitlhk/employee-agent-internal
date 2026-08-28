import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callCustomMcpTool: vi.fn(),
  callInternalMcpTool: vi.fn(),
}));

vi.mock("./custom-mcp-client", () => ({
  callCustomMcpTool: mocks.callCustomMcpTool,
}));
vi.mock("./internal-mcp-client", () => ({
  callInternalMcpTool: mocks.callInternalMcpTool,
}));

import {
  callWealthProductSourceTool,
  wealthProductSourceTransport,
} from "./wealth-product-source-client";

describe("wealth product source client", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the governed HTTPS client for the canonical remote source", async () => {
    mocks.callCustomMcpTool.mockResolvedValue({ content: [] });
    const result = await callWealthProductSourceTool({
      endpointUrl:
        "https://mcp.demo.linggan.top/wealth/product-data/mcp",
      toolName: "wealth_assistant_product_search",
      args: { page: 1, pageSize: 10 },
      agentId: "agent-1",
      adoptId: "lgj-1",
    });
    expect(result).toEqual({ content: [] });
    expect(mocks.callCustomMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointUrl:
          "https://mcp.demo.linggan.top/wealth/product-data/mcp",
        authType: "none",
      }),
      "wealth_assistant_product_search",
      { page: 1, pageSize: 10 }
    );
    expect(mocks.callInternalMcpTool).not.toHaveBeenCalled();
  });

  it("keeps the loopback adapter as a rollback path", async () => {
    mocks.callInternalMcpTool.mockResolvedValue({ content: [] });
    await callWealthProductSourceTool({
      endpointUrl: "http://127.0.0.1:18007/mcp",
      toolName: "wealth_assistant_product_search",
      args: {},
      agentId: "agent-1",
      adoptId: "lgj-1",
      sessionId: "session-1",
    });
    expect(mocks.callInternalMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointUrl: "http://127.0.0.1:18007/mcp",
        agentId: "agent-1",
        adoptId: "lgj-1",
        sessionId: "session-1",
      })
    );
    expect(mocks.callCustomMcpTool).not.toHaveBeenCalled();
  });

  it("rejects remote plaintext product sources", () => {
    expect(() =>
      wealthProductSourceTransport("http://116.204.117.91:8768/mcp")
    ).toThrow("canonical HTTPS or loopback HTTP");
  });
});
