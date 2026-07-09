import { describe, expect, it } from "vitest";
import { inferMcpServerForJiuwenTool, inferSkillIdFromJiuwenPayload } from "./jiuwenclaw-bridge";

describe("jiuwenclaw bridge audit helpers", () => {
  it("maps business tool names to MCP server ids", () => {
    expect(inferMcpServerForJiuwenTool("mcp_demo_server__lookup_customer")).toBe("demo_server");
    expect(inferMcpServerForJiuwenTool("mcp_market_data__get_quote")).toBe("market_data");
  });

  it("does not classify unknown runtime tools as MCP business tools", () => {
    expect(inferMcpServerForJiuwenTool("execute_cmd")).toBeNull();
    expect(inferMcpServerForJiuwenTool("read_file")).toBeNull();
  });

  it("infers skill ids from jiuwenswarm tool arguments", () => {
    expect(inferSkillIdFromJiuwenPayload({ command: "python skills/wealth-manager-assistant/run.py" })).toBe("wealth-manager-assistant");
    expect(inferSkillIdFromJiuwenPayload({ skillId: "insurance-advisor-pro" })).toBe("insurance-advisor-pro");
  });
});
