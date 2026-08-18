import { describe, expect, it } from "vitest";
import { flattenComposerConnectors, roleHomeEnterpriseConnectors } from "./composer-connectors";

describe("flattenComposerConnectors", () => {
  it("uses the curated Chinese group name for built-in MCP connections", () => {
    const [connector] = flattenComposerConnectors({
      items: [{
        id: "post_loan_risk_data",
        name: "贷后风险数据",
        description: "企业贷后风险指标与预警数据查询。",
        category: "内部业务 MCP",
        children: [{
          id: "post_loan_risk_data",
          serverId: "post_loan_risk_data",
          name: "Post Loan Risk Data",
          configured: true,
          status: "available",
          enabledForAgent: true,
          grantMode: "optional",
          tools: [{ name: "query_risk_events", description: "查询企业风险事件" }],
        }],
      }],
    });

    expect(connector.name).toBe("贷后风险数据");
    expect(connector.description).toBe("企业贷后风险指标与预警数据查询。");
    expect(connector.tools).toEqual([{ name: "query_risk_events", description: "查询企业风险事件" }]);
  });

  it("uses the user-supplied child name for custom MCP connections", () => {
    const [connector] = flattenComposerConnectors({
      items: [{
        id: "custom-user-mcp",
        name: "自定义 MCP",
        category: "个人连接",
        children: [{
          id: "custom_mcp_42",
          serverId: "custom_mcp_42",
          name: "项目知识库",
          description: "mcp.example.com",
          catalogId: "yingmi",
          configured: true,
          status: "available",
          enabledForAgent: true,
          grantMode: "optional",
        }],
      }],
    });

    expect(connector.name).toBe("项目知识库");
    expect(connector.description).toBe("mcp.example.com");
    expect(connector.source).toBe("personal");
    expect(connector.catalogId).toBe("yingmi");
  });

  it("keeps only configured and enabled role tools for the role home", () => {
    const base = {
      name: "企业工具",
      description: "",
      category: "内部业务 MCP",
      source: "preset" as const,
      configured: true,
      status: "available" as const,
      liveStatus: "live" as const,
      enabledForAgent: true,
      grantMode: "default" as const,
      tools: [],
    };
    const visible = roleHomeEnterpriseConnectors([
      { ...base, serverId: "wealth_customer", name: "财富客户数据" },
      { ...base, serverId: "third_party", name: "未接入目录", configured: false, status: "missing" },
      { ...base, serverId: "disabled_tool", name: "已关闭工具", enabledForAgent: false },
      { ...base, serverId: "enterprise_mcp_gateway", name: "企业连接网关" },
    ]);

    expect(visible.map((connector) => connector.serverId)).toEqual(["wealth_customer"]);
  });
});
