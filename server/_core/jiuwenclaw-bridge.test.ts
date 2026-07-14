import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { collectRecentWorkspaceFiles, inferMcpServerForJiuwenTool, inferSkillIdFromJiuwenPayload } from "./jiuwenclaw-bridge";

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

  it("does not report a file uploaded before the agent run as generated output", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-workspace-files-"));
    try {
      const cutoff = Date.now();
      const uploaded = path.join(root, "uploaded.txt");
      const generated = path.join(root, "generated.txt");
      writeFileSync(uploaded, "input", "utf8");
      utimesSync(uploaded, new Date(cutoff - 5000), new Date(cutoff - 5000));
      writeFileSync(generated, "output", "utf8");
      utimesSync(generated, new Date(cutoff + 1000), new Date(cutoff + 1000));

      expect(collectRecentWorkspaceFiles(root, cutoff).map((file) => file.name)).toEqual(["generated.txt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
