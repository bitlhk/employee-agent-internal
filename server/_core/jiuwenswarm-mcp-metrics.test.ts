import { describe, expect, it } from "vitest";
import { metricsRegistry } from "./observability/metrics";
import {
  extractSearchOptimizationStats,
  inferMcpServerForJiuwenTool,
  recordJiuwenMcpMetricEvent,
} from "./jiuwenswarm-mcp-metrics";

describe("JiuwenSwarm MCP metrics", () => {
  it("infers MCP server ids from supported Jiuwen tool-name formats", () => {
    expect(inferMcpServerForJiuwenTool("mcp_demo_server__lookup_customer")).toBe("demo_server");
    expect(inferMcpServerForJiuwenTool("mcp_market_data__get_quote")).toBe("market_data");
    expect(
      inferMcpServerForJiuwenTool("mcp_wealth_assistant_customer_wealth_assistant_customer_list"),
    ).toBe("wealth_assistant_customer");
    expect(inferMcpServerForJiuwenTool("mcp_platform_tools_create_scheduled_task")).toBe("platform_tools");
    expect(inferMcpServerForJiuwenTool("mcp_custom_user_42_lookup_customer")).toBe("custom_user_42");
  });

  it("does not classify unknown runtime tools as MCP business tools", () => {
    expect(inferMcpServerForJiuwenTool("execute_cmd")).toBeNull();
    expect(inferMcpServerForJiuwenTool("read_file")).toBeNull();
  });

  it("records a bounded MCP lifecycle without tool-name labels", async () => {
    const metricText = async () => String(await metricsRegistry.getSingleMetricAsString("ea_mcp_calls_total"));
    const sampleValue = (text: string) => {
      const match = text.match(/ea_mcp_calls_total\{kind="custom",outcome="success"\}\s+(\d+)/);
      return Number(match?.[1] || 0);
    };
    const before = sampleValue(await metricText());
    const common = {
      agentId: "jiuwen_lgj-test",
      sessionId: "session-test",
      requestId: "request-test",
    };

    expect(recordJiuwenMcpMetricEvent({
      ...common,
      tool: {
        isResult: false,
        callId: "call-1",
        toolName: "mcp_custom_user_42__lookup_customer",
        isError: false,
      },
    })).toBe(true);
    expect(recordJiuwenMcpMetricEvent({
      ...common,
      tool: {
        isResult: true,
        callId: "call-1",
        toolName: "mcp_custom_user_42__lookup_customer",
        isError: false,
      },
    })).toBe(true);

    expect(sampleValue(await metricText())).toBe(before + 1);
  });

  it("records search duration and compaction without exposing tool names", async () => {
    const common = {
      agentId: "jiuwen_lgj-search",
      sessionId: "session-search",
      requestId: "request-search",
    };
    recordJiuwenMcpMetricEvent({
      ...common,
      tool: {
        isResult: false,
        callId: "call-search",
        toolName: "mcp_wind_financial_docs_get_financial_news",
        isError: false,
      },
    });
    recordJiuwenMcpMetricEvent({
      ...common,
      tool: {
        isResult: true,
        callId: "call-search",
        toolName: "mcp_wind_financial_docs_get_financial_news",
        isError: false,
        resultPayload: '{"_ea_search_optimized":{"original_chars":24290},"items":[]}',
      },
    });

    const metrics = await metricsRegistry.metrics();
    expect(metrics).toContain('ea_search_tool_calls_total{outcome="success"}');
    expect(metrics).toContain("ea_search_result_optimizations_total 1");
    expect(extractSearchOptimizationStats("plain result")).toBeNull();
  });
});
