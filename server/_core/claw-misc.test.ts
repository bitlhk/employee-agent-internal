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

      const writeSession = (adoptId: string, conversationId: string, userText: string, assistantText: string, historyName: "history.json" | "history.jsonl") => {
        const sessionId = `sess_${adoptId}_web_${conversationId}_e0`;
        const dir = path.join(root, "service_linggan_test", `agent_jiuwen_${adoptId}`, "agent", "sessions", sessionId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({
          session_id: sessionId,
          channel_id: "web",
          created_at: 1779000000,
          last_message_at: 1779000001,
          title: userText,
        }), "utf8");
        writeFileSync(path.join(dir, historyName), [
          JSON.stringify({ id: `${sessionId}:u`, role: "user", request_id: `${sessionId}:r`, timestamp: 1779000000, content: userText }),
          JSON.stringify({ id: `${sessionId}:think`, role: "assistant", request_id: `${sessionId}:r`, timestamp: 1779000000.5, event_type: "chat.reasoning", content: "hidden thinking" }),
          JSON.stringify({ id: `${sessionId}:a`, role: "assistant", request_id: `${sessionId}:r`, timestamp: 1779000001, event_type: "chat.final", content: assistantText }),
        ].join("\n"), "utf8");
        return sessionId;
      };

      const alphaSessionId = writeSession("lgj-alpha", "conv_alpha", "你好 alpha", "alpha 回复", "history.jsonl");
      const betaSessionId = writeSession("lgj-beta", "conv_beta", "你好 beta", "beta 回复", "history.json");

      const alphaSessions = listJiuwenChatHistorySessions({ adoptId: "lgj-alpha", dbAgentId: "", limit: 10 });
      expect(alphaSessions).toHaveLength(1);
      expect(alphaSessions[0]).toMatchObject({
        conversationId: "conv_alpha",
        sessionKey: alphaSessionId,
        title: "你好 alpha",
        messageCount: 2,
      });
      expect(alphaSessions[0].searchText).toContain("alpha 回复");
      expect(alphaSessions[0].searchText).not.toContain("hidden thinking");
      expect(alphaSessions[0].searchText).not.toContain("beta 回复");

      expect(resolveJiuwenHistorySession({ adoptId: "lgj-alpha", dbAgentId: "", sessionKey: alphaSessionId })?.sessionId).toBe(alphaSessionId);
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
});
