import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import {
  buildJiuwenAgentServerChatRequest,
  buildJiuwenFinalSnapshot,
  buildJiuwenTextDelta,
  collectRecentWorkspaceFiles,
  formatJiuwenTextSectionDelta,
  inferMcpServerForJiuwenTool,
  inferSkillIdFromJiuwenPayload,
  pickJiuwenText,
} from "./jiuwenclaw-bridge";

describe("jiuwenclaw bridge audit helpers", () => {
  it("separates post-tool text without adding duplicate blank lines", () => {
    expect(formatJiuwenTextSectionDelta("查询完成。", true)).toBe("\n\n查询完成。");
    expect(formatJiuwenTextSectionDelta("\n\n查询完成。", true)).toBe("\n\n查询完成。");
    expect(formatJiuwenTextSectionDelta("继续输出", false)).toBe("继续输出");
  });

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

  it("extracts final text nested in an AgentServer completion payload", () => {
    expect(pickJiuwenText({ payload: { event_type: "chat.final", content: "模型不支持图片理解" } })).toBe(
      "模型不支持图片理解",
    );
  });

  it("publishes chat.final as an authoritative Markdown snapshot", () => {
    const markdown = "## 结果\n\n| # | 名称 |\n|---|---|\n| 1 | 示例 |";
    expect(buildJiuwenFinalSnapshot(markdown, "/tmp/workspace")).toEqual({
      __final_text: markdown,
    });
  });

  it("labels streamed text as a delta instead of guessing from its prefix", () => {
    expect(buildJiuwenTextDelta("#")).toEqual({
      __text_mode: "delta",
      choices: [{ delta: { content: "#" }, index: 0 }],
    });
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

  it("does not expose JiuwenSwarm context offload files as generated output", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-workspace-context-"));
    try {
      const cutoff = Date.now();
      const contextDir = path.join(root, "context", "session_context", "offload");
      mkdirSync(contextDir, { recursive: true });
      writeFileSync(path.join(contextDir, "MessageSummaryOffloader.json"), "{}", "utf8");
      const report = path.join(root, "risk-report.md");
      writeFileSync(report, "report", "utf8");
      utimesSync(report, new Date(cutoff + 1000), new Date(cutoff + 1000));

      expect(collectRecentWorkspaceFiles(root, cutoff).map((file) => file.path)).toEqual(["risk-report.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes uploaded workspace images to AgentServer as structured media", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-workspace-image-"));
    try {
      const uploadDir = path.join(root, "prompt_attachment");
      mkdirSync(uploadDir, { recursive: true });
      const imagePath = path.join(uploadDir, "risk.png");
      writeFileSync(imagePath, "png-data", "utf8");
      const message = [
        "请看一下图片。",
        "",
        "[已上传附件]",
        "- risk.png (8 B) -> workspace path: prompt_attachment/risk.png",
        "",
        "需要读取附件内容时，请使用上面的 workspace path。",
      ].join("\n");

      const request = buildJiuwenAgentServerChatRequest({
        requestId: "request-image",
        serviceId: "linggan",
        agentId: "jiuwen_lgj-test",
        sessionId: "session-image",
        channelId: "lgj-test",
        message,
        workspaceDir: root,
        model: "glm-5.2",
      });

      expect(request.params.media_items).toEqual([{
        type: "image",
        filename: "risk.png",
        path: imagePath,
        mime_type: "image/png",
        size_bytes: 8,
      }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
