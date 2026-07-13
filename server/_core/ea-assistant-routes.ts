import type express from "express";
import { z } from "zod";
import { generateEaSessionTitle, resolveEaAssistantModelConfig } from "./ea-assistant-model";
import { clawChatLimiter } from "./security";
import { resolveRequesterUserId } from "./helpers";

const sessionTitleSchema = z.object({
  messages: z.array(z.object({
    role: z.string().optional(),
    text: z.string().optional(),
  })).min(1).max(12),
});

function compactTitleInput(messages: Array<{ role?: string; text?: string }>) {
  return messages
    .map((message) => {
      const role = message.role === "assistant" ? "助手" : message.role === "user" ? "用户" : "消息";
      const text = String(message.text || "").replace(/\s+/g, " ").trim();
      return text ? `${role}：${text.slice(0, 600)}` : "";
    })
    .filter(Boolean)
    .join("\n")
    .slice(0, 2000);
}

export function registerEaAssistantRoutes(app: express.Express) {
  app.get("/api/ea/assistant/model", async (_req, res) => {
    const config = await resolveEaAssistantModelConfig();
    res.json({
      model: config.model,
      configured: Boolean(config.apiKey),
      timeoutMs: config.timeoutMs,
      disableThinking: config.disableThinking,
    });
  });

  app.post("/api/ea/assistant/session-title", clawChatLimiter, async (req, res) => {
    try {
      const userId = await resolveRequesterUserId(req, res);
      if (!userId) {
        res.status(401).json({ error: "UNAUTHORIZED" });
        return;
      }
      const parsed = sessionTitleSchema.parse(req.body || {});
      const input = compactTitleInput(parsed.messages);
      if (!input) {
        res.status(400).json({ error: "empty_messages" });
        return;
      }
      const result = await generateEaSessionTitle(input);
      res.json({
        title: result.title,
        model: result.model,
        elapsedMs: result.elapsedMs,
      });
    } catch (error: any) {
      if (error?.issues) {
        res.status(400).json({ error: "invalid_request", issues: error.issues });
        return;
      }
      console.warn("[ea-assistant] session title failed", error?.message || error);
      res.status(500).json({ error: "session_title_failed" });
    }
  });
}
