import express from "express";
import { parseAdoptId, parseNonEmptyString, sendError, handleRouteError } from "./schemas";
import { clawChatLimiter } from "./security";
import { sandboxExec, sandboxHealthCheck } from "./sandbox";
import { requireClawOwner } from "./helpers";

export function registerSandboxRoutes(app: express.Express) {

  // ── Sandbox Exec (plus isolated exec) ──────────────────────────────
  app.get("/api/claw/sandbox/health", async (_req, res) => {
    const health = await sandboxHealthCheck();
    return res.json(health);
  });

  app.post("/api/claw/sandbox/exec", clawChatLimiter, async (req, res) => {
    try {
      const { adoptId, command, timeoutMs, env } = (req.body || {}) as any;

      // 1. validate params（ApiError 抛出会被 handleRouteError 转成 400）
      const validAdoptId = parseAdoptId(adoptId);
      const validCommand = parseNonEmptyString(command, "command");
      if (validCommand.length > 4096) {
        return sendError(res, "BAD_REQUEST", "command too long");
      }

      // 2. auth + ownership via requireClawOwner
      const adoption = await requireClawOwner(req, res, validAdoptId);
      if (!adoption) return;

      // 3. plus profile check
      const profile = (adoption as any).permissionProfile || "starter";
      if (profile !== "plus" && profile !== "internal") {
        return sendError(res, "FORBIDDEN", "sandbox_exec requires plus profile");
      }

      // 5. exec
      const result = await sandboxExec({
        adoptId: validAdoptId,
        command: validCommand,
        timeoutMs: typeof timeoutMs === "number" ? Math.min(timeoutMs, 30000) : undefined,
        env: env && typeof env === "object" ? env : undefined,
      });
      return res.json({ ok: true, ...result });

    } catch (err: any) {
      console.error("[sandbox/exec] error:", err);
      return handleRouteError(res, err);
    }
  });

}
