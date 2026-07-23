import { describe, expect, it } from "vitest";
import { flattenComposerConnectors } from "./composer-connectors";

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
        }],
      }],
    });

    expect(connector.name).toBe("贷后风险数据");
    expect(connector.description).toBe("企业贷后风险指标与预警数据查询。");
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
});
