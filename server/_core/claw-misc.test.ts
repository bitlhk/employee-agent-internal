import express from "express";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import type { Server } from "http";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./context", () => ({
  createContext: vi.fn(),
}));

import { createContext } from "./context";

function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to bind test server"));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

describe("claw misc admin routes", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("requires an admin session before AI skill review reads package data", async () => {
    const { registerMiscRoutes } = await import("./claw-misc");
    vi.mocked(createContext).mockResolvedValue({ req: {} as any, res: {} as any, user: null });

    const app = express();
    app.use(express.json());
    registerMiscRoutes(app);
    const { server, url } = await listen(app);

    try {
      const res = await fetch(`${url}/api/claw/admin/ai-review-skill`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skillMarketId: 1 }),
      });

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "admin only" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reads JiuwenSwarm history from the current agent sessions directory only", async () => {
    const previousHome = process.env.JIUWENCLAW_HOME;
    const previousServiceId = process.env.JIUWENCLAW_SERVICE_ID;
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-jiuwen-history-"));
    try {
      process.env.JIUWENCLAW_HOME = root;
      process.env.JIUWENCLAW_SERVICE_ID = "linggan_test";
      const { listJiuwenChatHistorySessions, resolveJiuwenHistorySession } = await import("./claw-misc");

      const writeSession = (
        adoptId: string,
        conversationId: string,
        userText: string,
        assistantText: string,
        historyName: "history.json" | "history.jsonl",
        epoch = 0,
      ) => {
        const sessionId = `sess_${adoptId}_web_${conversationId}_e${epoch}`;
        const timestamp = 1779000000 + epoch * 10;
        const dir = path.join(root, "service_linggan_test", `agent_jiuwen_${adoptId}`, "agent", "sessions", sessionId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({
          session_id: sessionId,
          channel_id: "web",
          created_at: timestamp,
          last_message_at: timestamp + 1,
          title: userText,
        }), "utf8");
        writeFileSync(path.join(dir, historyName), [
          JSON.stringify({ id: `${sessionId}:u`, role: "user", request_id: `${sessionId}:r`, timestamp, content: userText }),
          JSON.stringify({ id: `${sessionId}:think`, role: "assistant", request_id: `${sessionId}:r`, timestamp: timestamp + 0.5, event_type: "chat.reasoning", content: "hidden thinking" }),
          JSON.stringify({ id: `${sessionId}:a`, role: "assistant", request_id: `${sessionId}:r`, timestamp: timestamp + 1, event_type: "chat.final", content: assistantText }),
        ].join("\n"), "utf8");
        return sessionId;
      };

      const alphaSessionId = writeSession("lgj-alpha", "conv_alpha", "你好 alpha", "alpha 回复", "history.jsonl");
      const alphaLatestSessionId = writeSession("lgj-alpha", "conv_alpha", "继续 alpha", "alpha 新回复", "history.jsonl", 1);
      const betaSessionId = writeSession("lgj-beta", "conv_beta", "你好 beta", "beta 回复", "history.json");

      const alphaSessions = listJiuwenChatHistorySessions({ adoptId: "lgj-alpha", dbAgentId: "", limit: 10 });
      expect(alphaSessions).toHaveLength(1);
      expect(alphaSessions[0]).toMatchObject({
        conversationId: "conv_alpha",
        sessionKey: alphaLatestSessionId,
        title: "你好 alpha",
        messageCount: 4,
      });
      expect(alphaSessions[0].searchText).toContain("alpha 回复");
      expect(alphaSessions[0].searchText).toContain("alpha 新回复");
      expect(alphaSessions[0].searchText).not.toContain("hidden thinking");
      expect(alphaSessions[0].searchText).not.toContain("beta 回复");

      const resolvedAlpha = resolveJiuwenHistorySession({ adoptId: "lgj-alpha", dbAgentId: "", sessionKey: alphaLatestSessionId });
      expect(resolvedAlpha?.sessionId).toBe(alphaLatestSessionId);
      expect(resolvedAlpha?.segments.map((segment) => segment.sessionId).sort()).toEqual([alphaSessionId, alphaLatestSessionId].sort());
      expect(resolveJiuwenHistorySession({ adoptId: "lgj-alpha", dbAgentId: "", sessionKey: betaSessionId })).toBeNull();
    } finally {
      if (previousHome === undefined) delete process.env.JIUWENCLAW_HOME;
      else process.env.JIUWENCLAW_HOME = previousHome;
      if (previousServiceId === undefined) delete process.env.JIUWENCLAW_SERVICE_ID;
      else process.env.JIUWENCLAW_SERVICE_ID = previousServiceId;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hydrates JiuwenSwarm tool calls from embedded assistant history", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-jiuwen-tool-history-"));
    try {
      const { extractJiuwenChatMessages } = await import("./claw-misc");
      const historyFile = path.join(root, "history.json");
      writeFileSync(historyFile, [
        JSON.stringify({ id: "u1", role: "user", request_id: "r1", timestamp: 1779000000, content: "获取我的客户信息" }),
        JSON.stringify({
          id: "a1",
          role: "assistant",
          request_id: "r1",
          timestamp: 1779000001,
          content: "先加载工具",
          tool_calls: [{
            id: "call-load",
            type: "function",
            function: {
              arguments: JSON.stringify({
                tool_names: [
                  "mcp_demo_server__context_probe",
                  "mcp_demo_server__lookup_customer",
                ],
              }),
            },
          }],
        }),
        JSON.stringify({
          id: "a2",
          role: "assistant",
          request_id: "r1",
          timestamp: 1779000002,
          content: "查询客户",
          tool_calls: [{
            id: "call-customers",
            type: "function",
            function: {
              name: "mcp_demo_server__lookup_customer",
              arguments: "{}",
            },
          }],
        }),
      ].join("\n"), "utf8");

      const messages = extractJiuwenChatMessages(historyFile, 20);
      const assistant = messages.find((message) => message.role === "assistant" && message.toolCalls?.length);
      expect(assistant?.toolCalls?.map((tool) => tool.name)).toEqual([
        "load_tools",
        "mcp_demo_server__lookup_customer",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps distinct JiuwenSwarm final sections around tool execution", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-jiuwen-multi-final-"));
    try {
      const { extractJiuwenChatMessages } = await import("./claw-misc");
      const historyFile = path.join(root, "history.jsonl");
      writeFileSync(historyFile, [
        JSON.stringify({ id: "u1", role: "user", request_id: "r1", timestamp: 1779000000, content: "查询客户" }),
        JSON.stringify({ id: "a1", role: "assistant", request_id: "r1", timestamp: 1779000001, event_type: "chat.final", content: "正在查询授权数据源。" }),
        JSON.stringify({
          id: "tool1",
          role: "assistant",
          request_id: "r1",
          timestamp: 1779000002,
          event_type: "chat.tool_call",
          tool_call: { name: "lookup_customer", arguments: "{}", tool_call_id: "call-1" },
        }),
        JSON.stringify({ id: "result1", role: "assistant", request_id: "r1", timestamp: 1779000003, event_type: "chat.tool_result", tool_call_id: "call-1", result: "ok" }),
        JSON.stringify({ id: "a2", role: "assistant", request_id: "r1", timestamp: 1779000004, event_type: "chat.final", content: "查询完成，客户状态正常。" }),
      ].join("\n"), "utf8");

      const assistant = extractJiuwenChatMessages(historyFile, 20).find((message) => message.role === "assistant");
      expect(assistant?.text).toBe("正在查询授权数据源。\n\n查询完成，客户状态正常。");
      expect(assistant?.toolCalls?.[0]).toMatchObject({ name: "lookup_customer", status: "done", result: "ok" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not expose runtime workspace paths from JiuwenSwarm history", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-jiuwen-public-path-"));
    try {
      const { extractJiuwenChatMessages } = await import("./claw-misc");
      const historyFile = path.join(root, "history.jsonl");
      const privatePath = "/home/ubuntu/.jiuwenswarm/service_linggan/agent_jiuwen_lgj-test/agent/jiuwenclaw_workspace/output/report.html";
      writeFileSync(historyFile, [
        JSON.stringify({ id: "u1", role: "user", request_id: "r1", timestamp: 1779000000, content: "生成报告" }),
        JSON.stringify({
          id: "tool1",
          role: "assistant",
          request_id: "r1",
          timestamp: 1779000001,
          event_type: "chat.tool_call",
          tool_call: { name: "write_file", arguments: JSON.stringify({ file_path: privatePath }), tool_call_id: "call-write" },
        }),
        JSON.stringify({
          id: "result1",
          role: "assistant",
          request_id: "r1",
          timestamp: 1779000002,
          event_type: "chat.tool_result",
          tool_call_id: "call-write",
          result: `created ${privatePath}`,
        }),
        JSON.stringify({ id: "a1", role: "assistant", request_id: "r1", timestamp: 1779000003, event_type: "chat.final", content: `已生成 ${privatePath}` }),
      ].join("\n"), "utf8");

      const assistant = extractJiuwenChatMessages(historyFile, 20).find((message) => message.role === "assistant");
      expect(assistant?.text).toBe("已生成 workspace/output/report.html");
      expect(assistant?.toolCalls?.[0]?.arguments).toContain("workspace/output/report.html");
      expect(assistant?.toolCalls?.[0]?.result).toBe("created workspace/output/report.html");
      expect(JSON.stringify(assistant)).not.toContain("/home/ubuntu");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores uploaded attachment cards while keeping runtime paths out of user text", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-jiuwen-upload-history-"));
    try {
      const { extractJiuwenChatMessages } = await import("./claw-misc");
      const historyFile = path.join(root, "history.jsonl");
      writeFileSync(historyFile, JSON.stringify({
        id: "u-upload",
        role: "user",
        request_id: "request-upload",
        timestamp: 1779000000,
        content: [
          "这篇论文你看得懂吗",
          "",
          "[已上传附件]",
          "- 量子线路.pdf (328.0 KB) -> workspace path: prompt_attachment/quantum.pdf",
          "",
          "需要读取附件内容时，请使用上面的 workspace path。",
        ].join("\n"),
      }), "utf8");

      const user = extractJiuwenChatMessages(historyFile, 20, "lgj-test").find((message) => message.role === "user");
      expect(user?.text).toBe("这篇论文你看得懂吗");
      expect(user?.attachments).toEqual([{
        name: "量子线路.pdf",
        size: 328 * 1024,
        path: "prompt_attachment/quantum.pdf",
        adoptId: "lgj-test",
      }]);
      expect(JSON.stringify(user)).not.toContain("workspace path");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores persisted generated files as downloadable history attachments", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-jiuwen-history-artifacts-"));
    try {
      const sessionDir = path.join(root, "service_linggan", "agent_jiuwen_lgj-test", "agent", "sessions", "sess_lgj-test_web_conv_e0");
      mkdirSync(sessionDir, { recursive: true });
      const historyFile = path.join(sessionDir, "history.jsonl");
      writeFileSync(historyFile, [
        JSON.stringify({ id: "u1", role: "user", request_id: "request-files", timestamp: 1779000000, content: "生成报告" }),
        JSON.stringify({ id: "a1", role: "assistant", request_id: "request-files", timestamp: 1779000001, event_type: "chat.final", content: "报告已生成" }),
      ].join("\n"), "utf8");
      writeFileSync(path.join(sessionDir, ".ea-generated-files.json"), JSON.stringify({
        version: 1,
        runs: {
          "request-files": {
            adoptId: "lgj-test",
            requestId: "request-files",
            updatedAt: "2026-07-14T00:00:00.000Z",
            files: [{ name: "report.pdf", size: 2048, path: "output/report.pdf" }],
          },
        },
      }), "utf8");

      const { extractJiuwenChatMessages } = await import("./claw-misc");
      const assistant = extractJiuwenChatMessages(historyFile, 20, "lgj-test").find((message) => message.role === "assistant");
      const artifactCall = assistant?.toolCalls?.find((tool) => tool.name === "[产出文件]");
      expect(artifactCall).toMatchObject({
        adoptId: "lgj-test",
        outputFiles: [{ name: "report.pdf", size: 2048, wsPath: "output/report.pdf" }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores generated files when history and workspace use separate runtime roots", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-jiuwen-split-runtime-"));
    try {
      const sessionDir = path.join(root, "agent", "sessions", "sess_lgj-test_web_conv_e0");
      const workspaceDir = path.join(root, "service_linggan", "agent_jiuwen_lgj-test", "agent", "jiuwenclaw_workspace");
      const outputFile = path.join(workspaceDir, "output", "report.html");
      mkdirSync(sessionDir, { recursive: true });
      mkdirSync(path.dirname(outputFile), { recursive: true });
      writeFileSync(outputFile, "<h1>Report</h1>", "utf8");
      const historyFile = path.join(sessionDir, "history.jsonl");
      writeFileSync(historyFile, [
        JSON.stringify({ id: "u1", role: "user", request_id: "request-files", timestamp: 1779000000, content: "生成报告" }),
        JSON.stringify({
          id: "tool1",
          role: "assistant",
          request_id: "request-files",
          timestamp: 1779000001,
          event_type: "chat.tool_call",
          tool_call: {
            name: "write_file",
            arguments: JSON.stringify({ file_path: outputFile }),
            tool_call_id: "call-write",
          },
        }),
        JSON.stringify({ id: "a1", role: "assistant", request_id: "request-files", timestamp: 1779000002, event_type: "chat.final", content: "报告已生成" }),
      ].join("\n"), "utf8");

      const { extractJiuwenChatMessages } = await import("./claw-misc");
      const assistant = extractJiuwenChatMessages(historyFile, 20, "lgj-test", workspaceDir)
        .find((message) => message.role === "assistant");
      const artifactCall = assistant?.toolCalls?.find((tool) => tool.name === "[产出文件]");
      expect(artifactCall).toMatchObject({
        adoptId: "lgj-test",
        outputFiles: [{ name: "report.html", size: 15, wsPath: "output/report.html" }],
      });
      expect(JSON.stringify(artifactCall)).not.toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
