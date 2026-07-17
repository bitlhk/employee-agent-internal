import express from "express";
import http from "http";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { clawChatLimiter } from "./security";
import { routeTool, type ToolContext } from "./tool_router";
import {
  buildChatRequestBody,
  INTERNAL_EXEC_TOOL_NAME,
  PLATFORM_EXEC_TOOL_NAME,
  type PermissionProfile,
} from "./tool_schema";
import {
  requireClawOwner, resolveRuntimeAgentId, appendLogAsync,
  readSessionEpoch, bumpSessionEpoch, lookupSessionRegistry,
  upsertSessionRegistry, clearAgentSessionsCache, isPrivateUrl, APP_ROOT,
  buildRuntimeSessionKey, buildSessionRegistryScope,
  OPENCLAW_BASE_HOME, OPENCLAW_JSON_PATH, openClawAgentDir, openClawWorkspaceDir,
  isAuthorizedInternalRequest,
} from "./helpers";
import { ResponseAccumulator } from "./response-accumulator";
// 2026-04-18: eager import 避免首次 HTTP 聊天冷启动挂死（配合 claw-ws-proxy 保持一致）
import { SseStreamWriter } from "./stream-writer";
import { routeMessage } from "./intent-agent";
import { normalizeHttpSseLine } from "./runtime";
import {
  markChatRunComplete,
  markChatRunStarted,
  normalizeClientRunId,
  touchChatRun,
} from "./chat-inflight";
import { restoreDeletedProtectedCoreFiles, snapshotProtectedCoreFiles } from "./core-file-guard";
import { scheduleOpenClawToolAudit } from "./openclaw-tool-audit";
import { listSkillsWithRoleDefaults } from "./skills/role-default-skills";
import { privateMessageLogFields } from "./log-privacy";

type ChatRuntimeMode = "fast" | "plan";

type SelectedSkillContext =
  | {
      ok: true;
      message: string;
      skillId: string;
      label: string;
      skillFile: string;
      metadata: SelectedRuntimeSkill;
    }
  | { ok: false; status: number; error: string };

type SelectedRuntimeSkill = {
  id: string;
  name: string;
  description?: string;
  skillFile: string;
  runtimePath: string;
  sourceKind?: string;
  version?: string;
};

function normalizeSelectedSkillId(value: unknown): string {
  const skillId = String(value || "").trim();
  if (!skillId) return "";
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(skillId)) return "";
  return skillId;
}

async function buildSelectedSkillContext(
  adoptId: string,
  agentId: string,
  roleTemplate: string,
  selectedSkillId: unknown,
  userMessage: string,
): Promise<SelectedSkillContext | null> {
  const skillId = normalizeSelectedSkillId(selectedSkillId);
  if (!skillId) return null;

  const listed = await listSkillsWithRoleDefaults({ adoptId, agentId, roleTemplate });
  if (!listed.ok) {
    return { ok: false, status: 400, error: `技能读取失败：${listed.error.detail}` };
  }

  const skill = listed.value.find((item: any) => String(item?.id || "") === skillId);
  if (!skill) return { ok: false, status: 404, error: "所选技能不存在或不属于当前智能体" };
  if (!skill.enabled || skill.state !== "ready") {
    return { ok: false, status: 400, error: "所选技能未启用或尚未就绪" };
  }

  const runtimePath = String((skill as any)?.sync?.runtimePath || "").trim();
  if (!runtimePath) return { ok: false, status: 400, error: "所选技能尚未同步到运行时" };
  const skillFile = path.join(runtimePath, "SKILL.md");
  if (!existsSync(skillFile)) return { ok: false, status: 400, error: "所选技能运行时文件不存在" };

  const label = String((skill as any)?.source?.displayName || (skill as any)?.displayName || (skill as any)?.label || skillId).trim() || skillId;
  const description = String((skill as any)?.source?.description || (skill as any)?.description || "").trim();
  const metadata: SelectedRuntimeSkill = {
    id: skillId,
    name: label,
    ...(description ? { description } : {}),
    skillFile,
    runtimePath,
    sourceKind: String((skill as any)?.source?.kind || "").trim() || undefined,
    version: String((skill as any)?.source?.version || "").trim() || undefined,
  };
  const message = [
    "【本轮已由用户在输入框选择技能 Chip】",
    `selectedSkillId: ${skillId}`,
    `selectedSkillName: ${label}`,
    description ? `selectedSkillDescription: ${description}` : "",
    `selectedSkillFile: ${skillFile}`,
    "要求：本轮必须优先使用用户选择的技能；不要搜索或安装外部技能。",
    "请按需加载 selectedSkillFile 对应的 SKILL.md，并只在需要时读取相关 references/scripts/examples；不要一次性加载无关材料。",
    "如果用户输入已经足够启动该技能，请直接进入技能流程；如果缺少必要参数，再简短追问。",
    "",
    `用户问题：${userMessage}`,
  ].filter(Boolean).join("\n");
  return { ok: true, message, skillId, label, skillFile, metadata };
}

type OpenAiToolCallAccumulator = {
  index: number;
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

function routeableToolName(name: string) {
  return name === PLATFORM_EXEC_TOOL_NAME ? INTERNAL_EXEC_TOOL_NAME : name;
}

function mergeOpenAiToolCallDeltas(
  target: Map<number, OpenAiToolCallAccumulator>,
  toolCalls: unknown,
) {
  if (!Array.isArray(toolCalls)) return false;
  for (const raw of toolCalls) {
    if (!raw || typeof raw !== "object") continue;
    const call = raw as any;
    const index = Number.isFinite(Number(call.index)) ? Number(call.index) : target.size;
    const existing = target.get(index) ?? {
      index,
      id: "",
      type: "function" as const,
      function: { name: "", arguments: "" },
    };
    if (typeof call.id === "string" && call.id) existing.id = call.id;
    if (call.type === "function") existing.type = "function";
    const fn = call.function && typeof call.function === "object" ? call.function : {};
    if (typeof fn.name === "string" && fn.name) existing.function.name = fn.name;
    if (typeof fn.arguments === "string") existing.function.arguments += fn.arguments;
    target.set(index, existing);
  }
  return true;
}

function normalizeChatRuntimeMode(value: unknown): ChatRuntimeMode {
  return String(value || "").trim().toLowerCase() === "plan" ? "plan" : "fast";
}

export function registerChatStreamRoutes(app: express.Express) {
  app.post("/api/claw/jiuwen/permission-answer", clawChatLimiter, async (req, res) => {
    let { adoptId, requestId, action, selectedOption, source, channel, conversationId, epochLabel, runtimeMode } = req.body || {};
    if (!adoptId || !requestId) {
      res.status(400).json({ error: "adoptId and requestId required" });
      return;
    }
    if (!String(adoptId).startsWith("lgj-")) {
      res.status(400).json({ error: "permission answer only supports JiuwenSwarm agents" });
      return;
    }

    let claw: any;
    if (isAuthorizedInternalRequest(req)) {
      const { getClawByAdoptId } = await import("../db");
      claw = await getClawByAdoptId(String(adoptId));
      if (!claw) { res.status(404).json({ error: "NOT_FOUND" }); return; }
    } else {
      claw = await requireClawOwner(req, res, String(adoptId));
      if (!claw) return;
    }

    const normalizedAction = String(action || selectedOption || "").trim();
    const answerLabel =
      normalizedAction === "allow_once" || normalizedAction === "approve" || normalizedAction === "本次允许"
        ? "本次允许"
        : normalizedAction === "allow_always" || normalizedAction === "总是允许"
          ? "总是允许"
          : "拒绝";

    const { answerJiuwenPermission } = await import("./jiuwenclaw-bridge");
    const result = await answerJiuwenPermission(
      {
        adoptId: String(claw.adoptId),
        agentId: String(claw.agentId || `jiuwen_${String(claw.adoptId)}`),
        userId: Number(claw.userId),
      },
      {
        permissionRequestId: String(requestId),
        selectedOption: answerLabel,
        source: String(source || "permission_interrupt"),
        channel,
        conversationId,
        epochLabel,
        runtimeMode: normalizeChatRuntimeMode(runtimeMode),
      },
    );

    if (!result.ok) {
      res.status(502).json({ error: result.error, text: result.text || "" });
      return;
    }
    res.json({ ok: true, text: result.text || "", selectedOption: answerLabel });
  });

  // POST /api/claw/chat-stream  { adoptId, message }
  // 直连 Gateway /v1/chat/completions SSE，用 Node http 模块透传（避免 fetch 缓冲问题）
  app.post("/api/claw/chat-stream", clawChatLimiter, async (req, res) => {
    const routeEnterMs = Date.now();
    let { adoptId, message, model, pendingToolContext, epochLabel, channel, conversationId, runtimeMode, selectedSkillId, cancelPendingPermission } = req.body || {};
    const clientRunId = normalizeClientRunId(req.body?.clientRunId);
    const normalizedRuntimeMode = normalizeChatRuntimeMode(runtimeMode);
    if (!adoptId || !message) {
      res.status(400).json({ error: "adoptId and message required" });
      return;
    }

    // 内部 bridge 调用跳过 auth（通过 X-Internal-Key 头）
    let claw: any;
    if (isAuthorizedInternalRequest(req)) {
      const { getClawByAdoptId } = await import("../db");
      claw = await getClawByAdoptId(String(adoptId));
      if (!claw) { res.status(404).json({ error: "NOT_FOUND" }); return; }
    } else {
      claw = await requireClawOwner(req, res, String(adoptId));
      if (!claw) return;
    }

    // ── JiuwenClaw runtime branch (lgj-*) ──────────────────────────
    // lgj-* is the JiuwenClaw lane. lgh-* remains reserved for legacy
    // archived instances; lgc-* keeps the existing OpenClaw path.
    if (String(adoptId).startsWith("lgj-")) {
      const msgStrForRuntime = String(message || "").slice(0, 4000);
      if (msgStrForRuntime.trim().length === 0) {
        res.status(400).json({ error: "message is empty" });
        return;
      }
      const selectedSkill = await buildSelectedSkillContext(
        String(claw.adoptId),
        String(claw.agentId || `jiuwen_${String(claw.adoptId)}`),
        String(claw.roleTemplate || "general-assistant"),
        selectedSkillId,
        msgStrForRuntime,
      );
      if (selectedSkill && !selectedSkill.ok) {
        res.status(selectedSkill.status).json({ error: selectedSkill.error });
        return;
      }
      const requestedModelId = String(model || "").trim();
      const {
        JIUWEN_AUTO_MODEL_ID,
        listSelectableJiuwenModels,
        resolveAutomaticSelectableJiuwenModel,
      } = await import("./jiuwenswarm-model-admin");
      let selectableModels;
      try {
        selectableModels = await listSelectableJiuwenModels();
      } catch {
        res.status(503).json({ error: "模型目录暂时不可用，请稍后重试" });
        return;
      }
      let selectedModel = requestedModelId === JIUWEN_AUTO_MODEL_ID
        ? resolveAutomaticSelectableJiuwenModel(selectableModels)
        : requestedModelId
          ? selectableModels.find((item) => item.id === requestedModelId)
          : undefined;
      if (requestedModelId && !selectedModel) {
        res.status(400).json({ error: "所选模型已不可用，请刷新模型列表后重试" });
        return;
      }
      if (!selectedModel) {
        const { getClawProfileSettings } = await import("../db");
        const settings = await getClawProfileSettings(Number(claw.id));
        const preferredModelId = String((settings as any)?.model || "").trim();
        selectedModel = preferredModelId === JIUWEN_AUTO_MODEL_ID
          ? resolveAutomaticSelectableJiuwenModel(selectableModels)
          : selectableModels.find((item) => item.id === preferredModelId);
        selectedModel ||= resolveAutomaticSelectableJiuwenModel(selectableModels);
      }
      if (!selectedModel) {
        res.status(503).json({ error: "尚未配置可用的 Agent 模型" });
        return;
      }
      const effectiveJiuwenModel = selectedModel.runtimeModelId;
      const { forwardToJiuwenClaw, buildJiuwenAgentId, buildJiuwenSessionId } = await import("./jiuwenclaw-bridge");
      const jiuwenClaw = {
        adoptId: String(claw.adoptId),
        agentId: String(claw.agentId || `jiuwen_${String(claw.adoptId)}`),
        userId: Number(claw.userId),
      };
      const jiuwenAgentId = buildJiuwenAgentId(jiuwenClaw);
      const jiuwenSessionId = buildJiuwenSessionId(jiuwenClaw, jiuwenAgentId, {
        channel,
        conversationId,
        epochLabel,
      });
      const selectedSkillMessageLimit = Math.max(1200, Number(process.env.SELECTED_SKILL_MESSAGE_MAX_CHARS || 4000) || 4000);
      const runtimeMessageBody = selectedSkill?.ok ? selectedSkill.message.slice(0, selectedSkillMessageLimit) : msgStrForRuntime;
      const runtimeMessage = runtimeMessageBody;
      if (selectedSkill?.ok) {
        appendLogAsync("jiuwenclaw-exec.log", {
          ts: new Date().toISOString(),
          event: "selected_skill_injected",
          adoptId: String(claw.adoptId),
          agentId: String(claw.agentId || `jiuwen_${String(claw.adoptId)}`),
          userId: Number(claw.userId),
          clientRunId,
          selectedSkillId: selectedSkill.skillId,
          selectedSkillName: selectedSkill.label,
          selectedSkillFile: selectedSkill.skillFile,
          model: effectiveJiuwenModel,
          injectionMode: "manifest",
        });
      }
      await forwardToJiuwenClaw(
        jiuwenClaw,
        runtimeMessage,
        res,
        {
          model: effectiveJiuwenModel,
          req,
          channel,
          conversationId,
          epochLabel,
          clientRunId,
          runtimeMode: normalizedRuntimeMode,
          cancelPendingPermission,
          selectedSkills: selectedSkill?.ok ? [selectedSkill.metadata] : [],
        },
      );
      return;
    }

    if (String(adoptId).startsWith("lgh-")) {
      return res.status(410).json({ error: "LEGACY_RUNTIME_ARCHIVED", message: "Legacy runtime has been archived. Use a JiuwenClaw adoption instead." });
    }

    // 安全校验：agentId 必须符合预期格式，防止 shell 注入
    const AGENT_ID_RE = /^trial_lgc-[a-z0-9]{4,30}$/;
    if (!AGENT_ID_RE.test(String(claw.agentId || ""))) {
      res.status(400).json({ error: "invalid agent" });
      return;
    }

    // 安全校验：message 长度限制（二次确认，防绕过）
    const msgStr = String(message || "").slice(0, 4000);
    if (msgStr.trim().length === 0) {
      res.status(400).json({ error: "message is empty" });
      return;
    }

    const isSessionResetCmd = ["/new", "/reset"].includes(msgStr.trim());
    if (isSessionResetCmd) {
      // Reset must target the same session key used by normal chat. Since Lingxia
      // uses epoch-based keys after the first reset (agent:<id>:main:eN), resetting
      // only agent:<id>:main leaves the active context intact. The reliable reset
      // contract is: best-effort reset current key, bump epoch, clear local/OpenClaw
      // session caches, and let the next send create agent:<id>:main:e{next}.
      const dbAgentId = String((claw as any).agentId || "").trim();
      const trialAgentId = `trial_${String(adoptId)}`;
      const remoteHomeReset = OPENCLAW_BASE_HOME;
      const trialAgentDirReset = openClawAgentDir(trialAgentId);
      const runtimeAgentIdReset = existsSync(trialAgentDirReset) ? trialAgentId : dbAgentId;
      const currentEpoch = readSessionEpoch(String(adoptId));
      const sessionScope = buildSessionRegistryScope(channel, conversationId);
      const currentSessionKey = lookupSessionRegistry(String(adoptId), runtimeAgentIdReset, currentEpoch, sessionScope)
        || buildRuntimeSessionKey({ runtimeAgentId: runtimeAgentIdReset, channel, conversationId, epoch: currentEpoch });
      const legacyMainSessionKey = buildRuntimeSessionKey({ runtimeAgentId: runtimeAgentIdReset });
      const resetKeys = Array.from(new Set(
        sessionScope === "main"
          ? [currentSessionKey, legacyMainSessionKey].filter(Boolean)
          : [currentSessionKey].filter(Boolean)
      ));
      const gatewayResetResults: Array<{ key: string; ok: boolean; error?: string }> = resetKeys.map((key) => ({
        key,
        ok: false,
        error: "scheduled",
      }));

      // Do not block the reset UX on OpenClaw CLI latency. The epoch bump below is
      // the authoritative reset boundary; sessions.reset is best-effort cleanup for
      // the old Gateway keys and can safely finish in the background.
      void (async () => {
        try {
          const { execFile } = await import("child_process");
          const { promisify } = await import("util");
          const execFileAsync = promisify(execFile);
          const remoteHostReset = process.env.CLAW_REMOTE_HOST || "127.0.0.1";
          const gatewayPortReset = parseInt(process.env.CLAW_GATEWAY_PORT || "18789", 10);
          const gatewayTokenReset = process.env.CLAW_GATEWAY_TOKEN || "";
          const results: Array<{ key: string; ok: boolean; error?: string }> = [];

          for (const key of resetKeys) {
            try {
              await execFileAsync("openclaw", [
                "gateway", "call", "sessions.reset",
                "--url", `ws://${remoteHostReset}:${gatewayPortReset}`,
                "--token", gatewayTokenReset,
                "--params", JSON.stringify({ key, reason: "new" }),
                "--json",
              ], { timeout: 3000, encoding: "utf8" });
              results.push({ key, ok: true });
            } catch (e: any) {
              const message = String(e?.message || e);
              results.push({ key, ok: false, error: message.slice(0, 240) });
            }
          }

          console.log("[reset] gateway sessions.reset background completed", { adoptId, results });
        } catch (e: any) {
          console.warn("[reset] gateway reset setup failed in background", e?.message || e);
        }
      })();

      const epoch = bumpSessionEpoch(String(adoptId));
      const nextSessionKey = buildRuntimeSessionKey({ runtimeAgentId: runtimeAgentIdReset, channel, conversationId, epoch });
      clearAgentSessionsCache(runtimeAgentIdReset, remoteHomeReset);
      console.log("[reset] session reset completed", {
        adoptId,
        runtimeAgentId: runtimeAgentIdReset,
        sessionScope,
        previousEpoch: currentEpoch,
        nextEpoch: epoch,
        currentSessionKey,
        nextSessionKey,
        gatewayResetResults,
      });
      res.status(200).json({ ok: true, reset: true, epoch, previousSessionKey: currentSessionKey, sessionKey: nextSessionKey, gatewayResetResults });
      return;
    }

    // /help command: return help text locally
    if (msgStr.trim().toLowerCase() === "/help" || msgStr.trim().toLowerCase() === "/commands") {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      const helpText = "## \u53ef\u7528\u547d\u4ee4\n\n" +
        "| \u547d\u4ee4 | \u8bf4\u660e |\n|---|---|\n" +
        "| `/help` | \u67e5\u770b\u53ef\u7528\u547d\u4ee4 |\n" +
        "| `/status` | \u67e5\u770b\u5f53\u524d\u72b6\u6001 |\n" +
        "| `/tools` | \u67e5\u770b\u53ef\u7528\u5de5\u5177 |\n" +
        "| `/model` | \u5207\u6362\u6a21\u578b |\n" +
        "| `/dreaming status` | \u67e5\u770b\u68a6\u5883\u8bb0\u5fc6\u72b6\u6001 |\n" +
        "| `/context` | \u67e5\u770b\u4e0a\u4e0b\u6587\u4fe1\u606f |\n" +
        "| `/usage` | \u67e5\u770b\u7528\u91cf\u7edf\u8ba1 |\n" +
        "| `/whoami` | \u67e5\u770b\u5f53\u524d\u8eab\u4efd |\n" +
        "| `/new` | \u5f00\u542f\u65b0\u4f1a\u8bdd |\n" +
        "| `/reset` | \u91cd\u7f6e\u4f1a\u8bdd\u4e0a\u4e0b\u6587 |\n" +
        "| `/think` | \u6df1\u5ea6\u601d\u8003\u6a21\u5f0f |\n" +
        "| `/fast` | \u5feb\u901f\u6a21\u5f0f |\n" +
        "| `/compact` | \u538b\u7f29\u4e0a\u4e0b\u6587 |\n" +
        "| `/tasks` | \u67e5\u770b\u4efb\u52a1\u5217\u8868 |\n\n" +
        "> \ud83d\udca1 \u4e5f\u53ef\u4ee5\u76f4\u63a5\u7528\u81ea\u7136\u8bed\u8a00\u8ddf\u6211\u5bf9\u8bdd\uff0c\u6211\u4f1a\u81ea\u52a8\u8c03\u7528\u5408\u9002\u7684\u5de5\u5177\u3002";
      const chunk = { choices: [{ delta: { content: helpText }, index: 0 }] };
      res.write("data: " + JSON.stringify(chunk) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // /dreaming 命令拦截
    const dreamingMatch = msgStr.trim().match(/^\/dreaming(?:\s+(status|on|off|help))?$/);
    if (dreamingMatch) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      try {
        const dbAgentId = String((claw as any).agentId || "").trim();
        const trialAgentId = `trial_${String(adoptId)}`;
        const trialAgentDir = openClawAgentDir(trialAgentId);
        const runtimeAgentId = existsSync(trialAgentDir) ? trialAgentId : dbAgentId;
        const { execSync } = await import("child_process");
        const raw = execSync("openclaw memory status --json 2>/dev/null || openclaw memory status 2>/dev/null", { timeout: 8000, encoding: "utf8" });
        let agentBlock = "";
        try {
          const parsed = JSON.parse(raw);
          const agents = Array.isArray(parsed) ? parsed : parsed?.agents ?? [];
          const entry = agents.find((e: any) => e.agentId === runtimeAgentId);
          if (entry) {
            const dr = entry.dreaming || {};
            const lines = [
              "\ud83c\udf19 **Dreaming \u72b6\u6001** (" + runtimeAgentId + ")\n",
              "- \u72b6\u6001: " + (dr.enabled ? "\u2705 \u5df2\u542f\u7528" : "\u274c \u672a\u542f\u7528"),
            ];
            if (dr.frequency) lines.push("- \u9891\u7387: `" + dr.frequency + "`");
            lines.push("- \u77ed\u671f\u8bb0\u5fc6: " + (entry.recallStore?.entries ?? 0) + " \u6761");
            lines.push("- \u5df2\u63d0\u5347: " + (entry.recallStore?.promoted ?? 0) + " \u6761");
            lines.push("- \u7d22\u5f15: " + (entry.indexed?.files ?? 0) + "/" + (entry.indexed?.totalFiles ?? 0) + " \u6587\u4ef6");
            lines.push("\n\ud83d\udca1 \u68a6\u5883\u7cfb\u7edf\u6bcf\u5929\u51cc\u6668 3:00 \u81ea\u52a8\u8fd0\u884c\uff0c\u5c06\u77ed\u671f\u8bb0\u5fc6\u63d0\u70bc\u4e3a\u957f\u671f\u8bb0\u5fc6\u3002");
            agentBlock = lines.join("\n");
          }
        } catch {
          // fallback: parse text output
          const blocks = raw.split("\n\n");
          const matched = blocks.find((b: string) => b.includes(runtimeAgentId));
          agentBlock = matched ? matched.trim() : raw.slice(0, 800);
        }
        if (!agentBlock) agentBlock = "\u672a\u627e\u5230\u5f53\u524d\u4ee3\u7406\u7684\u8bb0\u5fc6\u72b6\u6001\u3002\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002";
        const chunk = { choices: [{ delta: { content: agentBlock }, index: 0 }] };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write("data: [DONE]\n\n");
      } catch (e: any) {
        const errChunk = { choices: [{ delta: { content: "\u67e5\u8be2 Dreaming \u72b6\u6001\u5931\u8d25: " + (e?.message || "unknown") }, index: 0 }] };
        res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
      }
      res.end();
      return;
    }

    // ── 斜杠命令白名单：非白名单的 / 开头消息去掉斜杠再透传 ──
    const ALLOWED_SLASH = new Set([
      "/help", "/commands", "/status", "/tools",
      "/whoami", "/id", "/context", "/usage", "/tasks",
      "/dreaming",
      "/new", "/reset",
      "/think", "/fast", "/stop", "/compact",
      "/btw",
      "/model",
    ]);
    const trimmedMsg = msgStr.trim();
    if (trimmedMsg.startsWith("/")) {
      const slashCmd = trimmedMsg.split(/\s/)[0].toLowerCase();
      if (!ALLOWED_SLASH.has(slashCmd)) {
        // 非白名单斜杠命令：去掉开头的 / 再透传，避免触发 Gateway 原生命令
        appendLogAsync("claw-blocked-slash.log", {
          ts: new Date().toISOString(),
          adoptId: String(adoptId),
          userId: Number((claw as any).userId || 0),
          blocked: slashCmd,
          original: trimmedMsg.slice(0, 200),
        });
        // 将 /xxx 转为普通文本透传，用户不受影响
        message = trimmedMsg.slice(1);
      }
    }

    // SSRF 防护：拦截 message 里直接包含内网 URL 的尝试
    const urlPattern = /https?:\/\/([^\s"'<>]+)/gi;
    const urlMatches = msgStr.match(urlPattern) || [];
    for (const u of urlMatches) {
      if (isPrivateUrl(u)) {
        res.status(400).json({ error: "不支持访问内网地址" });
        return;
      }
    }

    // 最小执行审计：记录谁在什么智能体上发起了什么请求（消息截断）
    appendLogAsync("claw-exec.log", {
      ts: new Date().toISOString(),
      event: "chat_stream_request",
      adoptId: String(adoptId),
      agentId: String((claw as any).agentId || ""),
      userId: Number((claw as any).userId || 0),
      permissionProfile: String((claw as any).permissionProfile || "starter"),
      ...privateMessageLogFields(message),
      runtimeMode: normalizedRuntimeMode,
    });


    const remoteHost = process.env.CLAW_REMOTE_HOST || "127.0.0.1";
    const remoteHome = OPENCLAW_BASE_HOME;
    const dedupEpoch = readSessionEpoch(String(adoptId));
    const dedupDbAgentId = String((claw as any).agentId || "").trim();
    const dedupTrialAgentId = `trial_${String(adoptId)}`;
    const dedupTrialAgentDir = openClawAgentDir(dedupTrialAgentId);
    const dedupRuntimeAgentId = existsSync(dedupTrialAgentDir) ? dedupTrialAgentId : dedupDbAgentId;
    const sessionScope = buildSessionRegistryScope(channel, conversationId);
    let dedupSessionKey = lookupSessionRegistry(String(adoptId), dedupRuntimeAgentId, dedupEpoch, sessionScope);
    if (!dedupSessionKey) {
      dedupSessionKey = buildRuntimeSessionKey({ runtimeAgentId: dedupRuntimeAgentId, channel, conversationId, epoch: dedupEpoch, epochLabel });
      upsertSessionRegistry(String(adoptId), dedupRuntimeAgentId, dedupSessionKey, dedupEpoch, sessionScope);
    }
    const dedupStart = markChatRunStarted({
      sessionKey: dedupSessionKey,
      clientRunId,
      transport: "http",
      message: msgStr,
    });
    if (dedupStart?.status === "in_flight") {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      res.write(`data: ${JSON.stringify({
        __in_flight: true,
        transport: "http",
        sessionKey: dedupSessionKey,
        sessionScope,
        clientRunId,
        runId: dedupStart.run.runId,
        startedAt: dedupStart.run.startedAt,
        lastEventAt: dedupStart.run.lastEventAt,
        reason: "duplicate_http_fallback",
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    // ── 平台意图路由：打分 → 分类 → 执行（统一 StreamWriter）──
    {
      const sseWriter = new SseStreamWriter(res);
      sseWriter.init();
      const handled = await routeMessage(String(adoptId), msgStr, sseWriter);
      if (handled) {
        markChatRunComplete(dedupSessionKey, clientRunId, "platform_handled");
        return;
      }
      // 未命中：继续走 Agent，但 SSE headers 已发，后续 Gateway 代理不需要再发
    }

    const gatewayPort = parseInt(process.env.CLAW_GATEWAY_PORT || "18789", 10);
    const gatewayToken = process.env.CLAW_GATEWAY_TOKEN || "";
    const rawProfile = String((claw as any).permissionProfile || "starter");
    const permissionProfile: PermissionProfile =
      rawProfile === "plus" || rawProfile === "internal" ? rawProfile : "starter";

    // 前端传入的模型 ID，白名单校验后通过 x-openclaw-model header 生效
    const ALLOWED_CLAW_MODELS = new Set(["openai/gpt-5.5", "glm5/glm-5.1", "modelarts-maas/glm-5.1", "maas/deepseek-v4-flash"]);
    const reqModel = (typeof model === "string" && model.trim()) ? model.trim() : "";
    let primaryModel = "";
    try {
      const cfg = JSON.parse(readFileSync(OPENCLAW_JSON_PATH, "utf8") || "{}");
      primaryModel = String(cfg?.agents?.defaults?.model?.primary || "").trim();
    } catch {}
    const backendModel = (reqModel && ALLOWED_CLAW_MODELS.has(reqModel) && reqModel !== primaryModel) ? reqModel : "";

    // 品牌配置：从 DB 读取 AI 身份
    let brandSystemPrompt: string | undefined;
    try {
      const { getBrandConfig } = await import("./brand");
      const brand = await getBrandConfig();
      brandSystemPrompt = brand.systemPrompt;
    } catch {}
    if (normalizedRuntimeMode === "plan") {
      const planModePrompt = "Runtime mode: plan. For complex requests, spend more effort on decomposition and verification before finalizing the answer. Keep any visible plan concise and continue to execute the user's request.";
      brandSystemPrompt = [brandSystemPrompt, planModePrompt].filter(Boolean).join("\n\n");
    }

    // Phase 2 方案 D：如果上一轮是 agent 回复，用户端传来 pendingToolContext
    //   将之注入 gateway messages 数组，openclaw 可读到 agent 结论做 follow-up
    const bodyObj = buildChatRequestBody({
      message,
      permissionProfile,
      brandSystemPrompt,
      pendingToolContext: pendingToolContext && typeof pendingToolContext === "object"
        ? {
            agentName: String(pendingToolContext.agentName || "agent").slice(0, 64),
            content: String(pendingToolContext.content || "").slice(0, 8000),
          }
        : null,
    });
    let body = JSON.stringify(bodyObj);
    const debugOpenClawChat = /^(1|true|yes)$/i.test(String(process.env.DEBUG_OPENCLAW_CHAT || ""));
    if (debugOpenClawChat && pendingToolContext && typeof pendingToolContext === "object") {
      console.log("[CTX-INJECT] adoptId=" + adoptId + " agentName=" + String(pendingToolContext.agentName || "").slice(0, 40) + " contentLen=" + String(pendingToolContext.content || "").length);
    }

    if (debugOpenClawChat) {
      try {
        const bodyParsed = JSON.parse(body);
        console.log("[DEBUG] tools in body:", JSON.stringify(bodyParsed.tools || "none"));
        console.log("[DEBUG] permissionProfile:", permissionProfile);
      } catch(e) {}
    }

    const startedAt = Date.now();
    const gatewayRequestStartMs = Date.now();
    let upstreamFirstChunkMs: number | null = null;
    let upstreamBytes = 0;
    let upstreamPreview = "";

    // SSE 响应头（intent-agent 可能已设过，重复设置无害）
    if (!res.headersSent) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
    }
    res.write(`data: ${JSON.stringify({ __perf: { routeEnterMs, gatewayRequestStartMs } })}\n\n`);

    // ── 平台级记忆：缓冲响应用于偏好提取 ──
    const chatUserId = Number((claw as any).userId || 0);
    const memAcc = new ResponseAccumulator(chatUserId, 'main-chat', msgStr);

    // 用 Node 原生 http 模块直接管道，零缓冲
    const httpMod = await import("http");
        const epoch = readSessionEpoch(String(adoptId));
        const dbAgentId = String((claw as any).agentId || "").trim();
        const trialAgentId = `trial_${String(adoptId)}`;
        const trialAgentDir = openClawAgentDir(trialAgentId);
        const runtimeAgentId = existsSync(trialAgentDir) ? trialAgentId : dbAgentId;

        // ── Session key 计算 ─────────────────────────────────────────
        // 三种来源：
        //   1) epochLabel（显式 label 隔离，协作子任务/会话嵌入场景用）
        //      → sessionKey = agent:{agent}:main:{safeLabel}，不走 registry，每次稳定
        //      → 跟主聊天的 e{epoch} 物理隔离，不污染主聊天 sandbox/记忆
        //   2) 注册表命中（epoch 复用已存在的 session key）
        //   3) 数字 epoch fallback（标准主聊天路径）
        let sessionKey: string;
        const found = lookupSessionRegistry(String(adoptId), runtimeAgentId, epoch, sessionScope);
        if (found) {
          sessionKey = found;
        } else {
          // 关键修复：sessionKey 由 runtime + channel + conversation 决定。
          // 缺省 channel/conversation 保持历史 main；网页新窗口走 web:{conversationId}。
          sessionKey = buildRuntimeSessionKey({ runtimeAgentId, channel, conversationId, epoch, epochLabel });
          upsertSessionRegistry(String(adoptId), runtimeAgentId, sessionKey, epoch, sessionScope);
        }

const options = {
      hostname: remoteHost,
      port: gatewayPort,
      path: "/v1/chat/completions",
      method: "POST",
	      timeout: 0,
	      headers: {
	        "Content-Type": "application/json",
	        "Authorization": `Bearer ${gatewayToken}`,
	        "x-openclaw-agent-id": runtimeAgentId,
        "x-openclaw-session-key": sessionKey,
        ...(backendModel ? { "x-openclaw-model": backendModel } : {}),
      },
    };

    // ── 工具代理层：拦截高危 tool_call，走 routeTool ────────────────
    const remoteHomeLocal = OPENCLAW_BASE_HOME;
    const workspaceDir = openClawWorkspaceDir(runtimeAgentId);
    const toolCtx: ToolContext = {
      adoptId: String(adoptId),
      agentId: runtimeAgentId,
      userId: Number((claw as any).userId || 0),
      permissionProfile: String((claw as any).permissionProfile || "starter") as ToolContext["permissionProfile"],
      sessionKey,
      workspaceDir,
      sendEvent: (event: string, data: object) => writeEvent(event, data),  // 传入 SSE 写函数，供 routeTool 发送进度事件
    };
    const coreFileSnapshot = snapshotProtectedCoreFiles(workspaceDir);
    const restoreCoreFiles = (phase: string) => {
      restoreDeletedProtectedCoreFiles(coreFileSnapshot, {
        adoptId: String(adoptId),
        agentId: runtimeAgentId,
        sessionKey,
        phase,
      });
    };
    const suppressedToolResults = new Set<string>();
    let lastSSEEventAt = Date.now(); // 任意 SSE 事件的最后时间戳
    let lastContentDeltaAt = Date.now(); // 最后一次收到 content delta 的时间
    let recentContentBuffer = ""; // 最近的文本片段（用于推断工具类型）
    let activeToolHeartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let activeToolName = ""; // 当前执行中工具名
    let gatewayToolDetected = false; // 是否已检测到 Gateway 内部工具执行

    // ── SSE 截断诊断（2026-04-28 示例客户复现 P0）──
    // 完整设计见 memory: project_sse_truncation_diag
    let sawUpstreamDone = false;                                          // 见到 upstream "[DONE]"
    let sawFinishReason: "stop" | "length" | "tool_calls" | "function_call" | null = null;
    let proxyResAbortedFlag = false;
    let proxyResCloseFired = false;
    let proxyResEndedFlag = false;                                        // proxyRes 已正常 end —— close 在 end 后触发不算异常
    let proxyResErrorObj: Error | null = null;
    let endReason: "natural" | "aborted" | "close" | "error" | "client_close" = "natural";
    let lastChunkAt = 0;
    let clientClosedFlag = false;
    let chatCompletionId: string | null = null;                           // 上游 chat completion id（批次 2 reconcile 锚点之一）
    let finalized = false;                                                // 单一 finalize guard，防 end/error 双写 [DONE]

    // 记录任意 SSE 事件，更新 lastEventAt
    const touchLastEvent = () => { lastSSEEventAt = Date.now(); };

    // 根据最近文本推断 Gateway 正在执行的内部工具
    const inferGatewayTool = (text: string): string | null => {
      const t = text.toLowerCase();
      if (/搜索|search|查找|查询|查.*一下|查清|looking.?up|searching|找.*一下|帮.*找|让我.*查|让我.*找|看看.*最新|了解.*最新/i.test(t)) return "web_search";
      if (/fetch|抓取|获取网页|访问.*网|打开.*链接|reading.*url/i.test(t)) return "web_fetch";
      if (/记忆|memory|回忆|之前.*说|earlier.*mention|上次.*聊/i.test(t)) return "memory_search";
      if (/阅读|read.*file|查看.*文件|读取/i.test(t)) return "read";
      return null; // 无法推断具体工具时不显示（Gateway 静默大概率是搜索）
    };

    // Gateway 内部工具空白检测
    let lastAnyDeltaAt = Date.now(); // 最后一次收到任何 delta
    let gatewayGapInterval: ReturnType<typeof setInterval> | null = null;
    const GAP_THRESHOLD_MS = 6000; // 6 秒无任何 delta → 触发
    const INITIAL_GRACE_MS = 3000; // 请求开始后 3 秒内不检测（连接建立阶段）
    const startGatewayGapDetection = () => {
      if (gatewayGapInterval) return;
      gatewayGapInterval = setInterval(() => {
        if (res.writableEnded) { stopGatewayGapDetection(); return; }
        // 请求刚开始的前几秒不检测
        if (Date.now() - startedAt < INITIAL_GRACE_MS) return;
        const gap = Date.now() - lastAnyDeltaAt;
        // 仅在非 exec tool_call 期间检测
        if (activeToolName) return;
        if (gap >= GAP_THRESHOLD_MS && !gatewayToolDetected) {
          const inferred = inferGatewayTool(recentContentBuffer);
          gatewayToolDetected = true;
          const toolId = `gw_${Date.now()}`;
          writeEvent("tool_call", { id: toolId, name: inferred, arguments: "{}", _gateway: true });
        }
      }, 2000);
    };

    const stopGatewayGapDetection = () => {
      if (gatewayGapInterval) { clearInterval(gatewayGapInterval); gatewayGapInterval = null; }
      if (gatewayToolDetected) {
        // Gateway 工具执行结束：发送 tool_result（标记为 gateway 内部完成）
        writeEvent("tool_result", {
          tool_call_id: `gw_done`,
          result: "",
          is_error: false,
          _gateway: true,
          executor: "gateway",
        });
        gatewayToolDetected = false;
      }
    };

    // 发送 agent_status heartbeat
    const sendHeartbeat = () => {
      if (activeToolName) {
        writeEvent("agent_status", {
          kind: "heartbeat",
          tool: activeToolName,
          elapsedMs: Date.now() - startedAt,
        });
      }
    };

    // 启动工具心跳：每 10 秒检查一次，10 秒无任何事件则发 heartbeat
    const startToolHeartbeat = (name: string) => {
      activeToolName = name;
      if (activeToolHeartbeatInterval) clearInterval(activeToolHeartbeatInterval);
      activeToolHeartbeatInterval = setInterval(() => {
        if (Date.now() - lastSSEEventAt >= 10_000) {
          sendHeartbeat();
        }
      }, 10_000);
    };

    // 停止心跳
    const stopToolHeartbeat = () => {
      if (activeToolHeartbeatInterval) {
        clearInterval(activeToolHeartbeatInterval);
        activeToolHeartbeatInterval = null;
      }
      activeToolName = "";
    };

    const writeEvent = (event: string, data: object) => {
      if (!res.writableEnded) {
        touchLastEvent();
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    const writeData = (data: object) => {
      if (!res.writableEnded) {
        touchLastEvent();
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    };

    // ── 全局 SSE keepalive：每 8 秒发一个 SSE comment，防止 Nginx/LB/浏览器超时断链 ──
    // 覆盖场景：模型思考阶段、工具执行结束到下一个 token 之间的静默期
    const sseKeepaliveInterval = setInterval(() => {
      if (!res.writableEnded) {
        // SSE comment 格式（: 开头），客户端不处理，但能保持连接活跃
        res.write(": keepalive\n\n");
      }
    }, 8000);

	    const openAiToolCalls = new Map<number, OpenAiToolCallAccumulator>();
	    let openAiToolLoopCount = 0;
	    const MAX_OPENAI_TOOL_LOOPS = 3;
	    let activeProxyReq: ReturnType<typeof http.request> | null = null;

	    const executePlatformToolCalls = async (calls: OpenAiToolCallAccumulator[]) => {
	      const toolMessages: any[] = [];
	      const assistantToolCalls = calls.map((call, idx) => {
	        const id = call.id || `call_${Date.now()}_${idx}`;
	        const name = call.function.name || PLATFORM_EXEC_TOOL_NAME;
	        return {
	          id,
	          type: "function" as const,
	          function: {
	            name,
	            arguments: call.function.arguments || "{}",
	          },
	        };
	      });

	      for (const call of assistantToolCalls) {
	        const routedName = routeableToolName(call.function.name);
	        const req = {
	          id: call.id,
	          name: routedName,
	          arguments: call.function.arguments || "{}",
	        };
	        writeEvent("tool_call", { id: req.id, name: req.name, arguments: req.arguments });
	        const TOOL_EXEC_TIMEOUT_MS = 300_000;
	        startToolHeartbeat(req.name);
	        try {
	          const result = await Promise.race([
	            routeTool(toolCtx, req),
	            new Promise<never>((_, reject) =>
	              setTimeout(() => reject(new Error("tool_timeout")), TOOL_EXEC_TIMEOUT_MS)
	            ),
	          ]);
	          stopToolHeartbeat();
	          suppressedToolResults.add(result.toolCallId);
	          writeEvent("tool_result", {
	            tool_call_id:             result.toolCallId,
	            result:                   result.output,
	            is_error:                 !result.ok,
	            exitCode:                 result.exitCode,
	            truncated:                result.truncated,
	            durationMs:               result.meta.durationMs,
	            suppressedOriginalResult: result.suppressedOriginalResult,
	            auditId:                  result.auditId,
	            requestId:                toolCtx.adoptId,
	            executor:                 result.executor,
	            policyDenyReason:         result.policyDenyReason,
	            outputFiles:              result.outputFiles ?? [],
	          });
	          toolMessages.push({
	            role: "tool",
	            tool_call_id: call.id,
	            name: call.function.name,
	            content: result.output || "",
	          });
	        } catch (err: any) {
	          const isTimeout = err?.message === "tool_timeout";
	          const output = isTimeout
	            ? `[执行超时] 工具 "${req.name}" 运行超过 5 分钟被系统中断，请尝试减少任务规模或重试。`
	            : `[工具执行异常] ${err?.message ?? String(err)}`;
	          stopToolHeartbeat();
	          writeEvent("tool_result", {
	            tool_call_id: req.id,
	            result: output,
	            is_error: true,
	            exitCode: isTimeout ? 124 : 1,
	            truncated: false,
	            durationMs: TOOL_EXEC_TIMEOUT_MS,
	            suppressedOriginalResult: true,
	            executor: "timeout",
	            policyDenyReason: isTimeout ? "tool_timeout" : "execution_error",
	            requestId: toolCtx.adoptId,
	          });
	          toolMessages.push({
	            role: "tool",
	            tool_call_id: call.id,
	            name: call.function.name,
	            content: output,
	          });
	        }
	      }

	      return { assistantToolCalls, toolMessages };
	    };

	    const startGatewayRequest = (requestBody: string) => {
	      const requestOptions = {
	        ...options,
	        headers: {
	          ...options.headers,
	          "Content-Length": Buffer.byteLength(requestBody),
	        },
	      };
	      const proxyReq = httpMod.request(requestOptions, async (proxyRes) => {
	        activeProxyReq = proxyReq;
	      let buffer = "";
      // 启动 Gateway 内部工具空白检测
      // startGatewayGapDetection(); // disabled — HTTP gap detection unreliable, will replace with WSS

      // ── 异常 finalize 助手（2026-04-28）──
      // proxyRes 异常路径（aborted/error/close-without-end）走这里收口
      // 防止前端 SSE 流挂住、防止漏写日志
      // proxyRes.on("end") 走自己的正常 finalize 路径（在下面）
      const triggerAbnormalFinalize = (kindForLog: string) => {
        if (finalized) return;
        finalized = true;
        if (endReason === "natural") endReason = (kindForLog as any);
        markChatRunComplete(sessionKey, clientRunId, kindForLog === "error" ? "http_error" : "http_abnormal");

        try { memAcc.flush(); } catch {}
        stopToolHeartbeat();
        stopGatewayGapDetection();
        clearInterval(sseKeepaliveInterval);

        const flagMode = String(process.env.SSE_TRUNCATE_DETECT || "off").toLowerCase();
        const userIdNum = Number((claw as any).userId || 0);
        const allowlist = String(process.env.SSE_TRUNCATE_DETECT_USERS || "")
          .split(",").map(s => s.trim()).filter(Boolean).map(Number);
        const flagOn = flagMode === "on" || (flagMode === "allowlist" && allowlist.includes(userIdNum));

        if (!res.writableEnded) {
          if (flagOn) {
            res.write(`data: ${JSON.stringify({
              __stream_truncated: true,
              adoptId: String(adoptId),
              sessionKey,
              endReason,
              chatCompletionId,
              streamEndMs: Date.now(),  // 异常路径砍流时间（GPT 约束 #2）
              startedAt,                // 流起始时间——recover 时间窗下界
              triggeredBy: kindForLog,
            })}\n\n`);
          } else {
            // off 模式保持兼容：发 __stream_end（旧行为遇到这种 case 也是 silent end）
            res.write(`data: ${JSON.stringify({ __stream_end: true })}\n\n`);
          }
          res.write("data: [DONE]\n\n");
          res.end();
        }

        appendLogAsync("claw-exec-detail.log", {
          ts: new Date().toISOString(),
          event: "chat_stream_response_abnormal",
          adoptId: String(adoptId),
          agentId: String((claw as any).agentId || ""),
          runtimeAgentId,
          sessionKey,
          userId: Number((claw as any).userId || 0),
          permissionProfile: String((claw as any).permissionProfile || "starter"),
          statusCode: Number(proxyRes.statusCode || 0),
          durationMs: Date.now() - startedAt,
          upstreamFirstChunkMs,
          upstreamBytes,
          preview: upstreamPreview.slice(0, 1000),
          endReason,
          proxyResComplete: proxyRes.complete,
          proxyResDestroyed: proxyRes.destroyed,
          proxyResAborted: proxyResAbortedFlag,
          proxyResCloseFired,
          proxyResEnded: proxyResEndedFlag,
          proxyResError: proxyResErrorObj?.message ?? null,
          sawUpstreamDone,
          sawFinishReason,
          chatCompletionId,
          lastChunkAt,
          clientClosed: clientClosedFlag,
          flag: process.env.SSE_TRUNCATE_DETECT || "off",
          triggeredBy: kindForLog,
        });
        restoreCoreFiles(`stream_${kindForLog}`);
      };

      // ── SSE 截断诊断 listener（2026-04-28）──
      // close 不一定是异常：正常 end 后也会 emit close。判异常看 ended/proxyRes.complete/sawUpstreamDone 组合
      proxyRes.on("aborted", () => {
        proxyResAbortedFlag = true;
        if (endReason === "natural") endReason = "aborted";
        console.log("[BIZ-STREAM] proxyRes aborted, complete=", proxyRes.complete, "bytes=", upstreamBytes);
        triggerAbnormalFinalize("aborted");
      });
      proxyRes.on("close", () => {
        proxyResCloseFired = true;
        // 真异常关闭：close && !proxyResEndedFlag（end 后的 close 是正常清理）
        const abnormal = !proxyResEndedFlag;
        console.log("[BIZ-STREAM] proxyRes close, complete=", proxyRes.complete, "destroyed=", proxyRes.destroyed, "abnormal=", abnormal);
        if (abnormal) triggerAbnormalFinalize("close_abnormal");
      });
      proxyRes.on("error", (err: Error) => {
        proxyResErrorObj = err;
        if (endReason === "natural") endReason = "error";
        console.log("[BIZ-STREAM] proxyRes error", err?.message);
        triggerAbnormalFinalize("error");
      });

      proxyRes.on("data", async (chunk: Buffer) => {
        lastChunkAt = Date.now();
        if (upstreamFirstChunkMs === null) {
          upstreamFirstChunkMs = Date.now();
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ __perf: { upstreamFirstChunkMs } })}\n\n`);
          }
        }
        upstreamBytes += chunk.length;
        if (upstreamPreview.length < 1200) {
          upstreamPreview += chunk.toString("utf8").slice(0, 1200 - upstreamPreview.length);
        }

        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          let line = rawLine;

          if (line.startsWith(":")) {
            if (!res.writableEnded) res.write(line + "\n");
            continue;
          }

          let eventName = "";
          if (line.startsWith("event: ")) {
            eventName = line.slice(7).trim();
            const dataLineIdx = lines.indexOf(rawLine) + 1;
            if (dataLineIdx < lines.length) {
              line = lines[dataLineIdx];
            } else {
              continue;
            }
          }

          if (!line.startsWith("data: ")) continue;
          const dataStr = line.slice(6).trim();
          const runtimeEvents = normalizeHttpSseLine(line, eventName);
          let sawStreamDoneEvent = false;
          if (runtimeEvents.length > 0) touchChatRun(sessionKey, clientRunId, "http_event");
          for (const evt of runtimeEvents) {
            switch (evt.type) {
              case "stream_done":
                sawUpstreamDone = true;
                sawStreamDoneEvent = true;
                break;
              case "finish_reason":
                sawFinishReason = evt.reason;
                break;
              case "delta":
                lastAnyDeltaAt = Date.now();
                memAcc.appendDelta(evt.content);
                lastContentDeltaAt = Date.now();
                recentContentBuffer = (recentContentBuffer + evt.content).slice(-200);
                // 收到 content 说明 Gateway 工具执行完毕
                if (gatewayToolDetected) stopGatewayGapDetection();
                break;
              case "thinking":
                lastAnyDeltaAt = Date.now();
                break;
              default:
                break;
            }
	          }
	          if (sawStreamDoneEvent) {
	            if (!(sawFinishReason === "tool_calls" && openAiToolCalls.size > 0)) {
	              writeData({ __done: true });
	            }
	            continue;
	          }

          try {
            const chunk = JSON.parse(dataStr);

            // 完成态跟踪（2026-04-28 SSE 截断诊断）
            // 只在标准 OpenAI chunk 上抓 id（含 choices 数组），避免误抓 tool_call 自带 id
	            if (!chatCompletionId && Array.isArray(chunk?.choices) && typeof chunk?.id === "string") {
	              chatCompletionId = chunk.id;
	            }

	            const firstChoice = Array.isArray(chunk?.choices) ? chunk.choices[0] : null;
	            const delta = firstChoice && typeof firstChoice === "object" ? (firstChoice as any).delta : null;
	            const capturedOpenAiToolCall = mergeOpenAiToolCallDeltas(openAiToolCalls, delta?.tool_calls);
	            const openAiToolCallFinish = firstChoice && typeof firstChoice === "object"
	              && (firstChoice as any).finish_reason === "tool_calls";
	            if (capturedOpenAiToolCall || openAiToolCallFinish) {
	              continue;
	            }

	            // ── tool_call：通过 routeTool 统一处理（带 5 分钟超时）──────────
	            if (eventName === "tool_call") {
	              const req = {
	                id: String(chunk.id || ""),
	                name: routeableToolName(String(chunk.name || "")),
	                arguments: String(chunk.arguments || "{}"),
	              };
              // 先把 tool_call 转发给前端，让 UI 显示工具调用卡片
              writeEvent("tool_call", { id: req.id, name: req.name, arguments: req.arguments });
              const TOOL_EXEC_TIMEOUT_MS = 300_000; // 5 分钟超时
              startToolHeartbeat(req.name); // 开始心跳追踪
              let result;
              try {
                result = await Promise.race([
                  routeTool(toolCtx, req),
                  new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error("tool_timeout")), TOOL_EXEC_TIMEOUT_MS)
                  ),
                ]);
              } catch (err: any) {
                const isTimeout = err?.message === "tool_timeout";
                stopToolHeartbeat(); // 失败也停心跳
                writeEvent("tool_result", {
                  tool_call_id: req.id,
                  result: isTimeout
                    ? `[执行超时] 工具 "${req.name}" 运行超过 5 分钟被系统中断，请尝试减少任务规模或重试。`
                    : `[工具执行异常] ${err?.message ?? String(err)}`,
                  is_error: true,
                  exitCode: isTimeout ? 124 : 1,
                  truncated: false,
                  durationMs: TOOL_EXEC_TIMEOUT_MS,
                  suppressedOriginalResult: true,
                  executor: "timeout",
                  policyDenyReason: isTimeout ? "tool_timeout" : "execution_error",
                  requestId: toolCtx.adoptId,
                });
                continue;
              }
              stopToolHeartbeat(); // 执行完毕，停心跳
              suppressedToolResults.add(result.toolCallId);
              writeEvent("tool_result", {
                tool_call_id:             result.toolCallId,
                result:                   result.output,
                is_error:                 !result.ok,
                exitCode:                 result.exitCode,
                truncated:                result.truncated,
                durationMs:               result.meta.durationMs,
                suppressedOriginalResult: result.suppressedOriginalResult,
                auditId:                  result.auditId,
                requestId:                toolCtx.adoptId,
                executor:                 result.executor,
                policyDenyReason:         result.policyDenyReason,
                outputFiles:              result.outputFiles ?? [],
              });
              continue;
            }

            // ── tool_result：跳过已由 routeTool 注入的 ─────────────────
            if (eventName === "tool_result") {
              const toolCallId = String(chunk.tool_call_id || "");
              if (suppressedToolResults.has(toolCallId)) continue;
              writeEvent("tool_result", chunk);
              continue;
            }

            // ── 其他所有事件透传 ────────────────────────────────────────
            if (eventName) {
              writeEvent(eventName, chunk);
            } else {
              writeData(chunk);
            }
          } catch {
            if (!res.writableEnded) {
              try { res.write(line + "\n"); } catch {}
            }
          }
        }
      });

	      proxyRes.on("end", async () => {
	        proxyResEndedFlag = true;
	        if (finalized) { console.log("[BIZ-STREAM] proxyRes end after finalized, skip"); return; }
	        if (sawFinishReason === "tool_calls" && openAiToolCalls.size > 0 && openAiToolLoopCount < MAX_OPENAI_TOOL_LOOPS) {
	          openAiToolLoopCount += 1;
	          const calls = Array.from(openAiToolCalls.values()).sort((a, b) => a.index - b.index);
	          openAiToolCalls.clear();
	          appendLogAsync("claw-exec-detail.log", {
	            ts: new Date().toISOString(),
	            event: "openai_tool_calls_followup",
	            adoptId: String(adoptId),
	            agentId: String((claw as any).agentId || ""),
	            runtimeAgentId,
	            sessionKey,
	            count: calls.length,
	            loop: openAiToolLoopCount,
	            names: calls.map((call) => call.function.name || ""),
	          });
	          const { assistantToolCalls, toolMessages } = await executePlatformToolCalls(calls);
	          bodyObj.messages.push({
	            role: "assistant",
	            content: null,
	            tool_calls: assistantToolCalls,
	          });
	          bodyObj.messages.push(...toolMessages);
	          body = JSON.stringify(bodyObj);
	          sawFinishReason = null;
	          sawUpstreamDone = false;
	          startGatewayRequest(body);
	          return;
	        }
	        finalized = true;
        markChatRunComplete(sessionKey, clientRunId, "http_done");
        memAcc.flush();
          console.log("[BIZ-STREAM] proxyRes ended");
        stopToolHeartbeat(); // 清理心跳 interval
        stopGatewayGapDetection(); // 清理 Gateway 空白检测
        const streamEndMs = Date.now();
        scheduleOpenClawToolAudit({
          runtimeAgentId,
          sessionKey,
          adoptId: String(adoptId),
          userId: Number((claw as any).userId || 0),
          startedAtMs: startedAt,
          endedAtMs: streamEndMs,
          channel,
          transport: "http",
          req,
        });
        if (!res.writableEnded) {
          // 扫描 workspace 目录（递归 + 含根目录），只推本次流期间新生成的文件
          // 关键：技能/exec 写到根目录的 .html 等产物也要被发现，不只是 output/
          try {
            const wsDir = toolCtx.workspaceDir;
            if (wsDir && existsSync(wsDir)) {
              const allFiles: Array<{ name: string; size: number; path: string }> = [];
              // 跳过这些系统/缓存目录，避免扫描太深
              const SKIP_DIRS = new Set(["skills", "memory", "node_modules", ".git", ".dreams", "dist", "build", ".openclaw"]);
              const scanDir = (dir: string, relBase: string, depth: number) => {
                if (depth > 3) return; // 限制递归深度
                try {
                  for (const entry of readdirSync(dir)) {
                    if (entry.startsWith(".")) continue;
                    if (depth === 0 && SKIP_DIRS.has(entry)) continue;
                    const full = `${dir}/${entry}`;
                    const rel = relBase ? `${relBase}/${entry}` : entry;
                    try {
                      const s = statSync(full);
                      if (s.isFile()) {
                        // 只返回本次流开始后新生成的文件
                        if (s.mtimeMs >= startedAt) {
                          allFiles.push({ name: entry, size: s.size, path: rel });
                        }
                      } else if (s.isDirectory()) {
                        scanDir(full, rel, depth + 1);
                      }
                    } catch {}
                  }
                } catch {}
              };
              scanDir(wsDir, "", 0);
              const sorted = allFiles.sort((a, b) => b.path.localeCompare(a.path));
              if (sorted.length > 0) {
                res.write("event: workspace_files\ndata: " + JSON.stringify({ adoptId: String(adoptId), files: sorted }) + "\n\n");
              }
            }
          } catch {}
          res.write(`data: ${JSON.stringify({ __perf: { streamEndMs } })}\n\n`);

          // ── 完成态三档判定（2026-04-28 SSE 截断诊断）──
          // Feature flag: SSE_TRUNCATE_DETECT
          //   off（默认）→ 旧行为，always __stream_end（不影响线上）
          //   allowlist → 仅 SSE_TRUNCATE_DETECT_USERS 列表中的 userId 走新逻辑
          //   on → 全量
          const flagMode = String(process.env.SSE_TRUNCATE_DETECT || "off").toLowerCase();
          const userIdNum = Number((claw as any).userId || 0);
          const allowlist = String(process.env.SSE_TRUNCATE_DETECT_USERS || "")
            .split(",").map(s => s.trim()).filter(Boolean).map(Number);
          const flagOn =
            flagMode === "on" ||
            (flagMode === "allowlist" && allowlist.includes(userIdNum));

          const upstreamCompleted = sawUpstreamDone || sawFinishReason === "stop";
          const lengthLimited = !upstreamCompleted && sawFinishReason === "length";
          // truncated 排除 client_close（用户主动断不算 bug）
          const truncated = !upstreamCompleted && !lengthLimited && !clientClosedFlag;

          if (flagOn && truncated) {
            res.write(`data: ${JSON.stringify({
              __stream_truncated: true,
              adoptId: String(adoptId),
              sessionKey,
              endReason,
              chatCompletionId,
              streamEndMs,         // 服务端砍流时间——批次 2 recover 锚点（GPT 约束 #2）
              startedAt,           // 服务端流起始时间——recover 时间窗下界
            })}\n\n`);
          } else if (flagOn && lengthLimited) {
            res.write(`data: ${JSON.stringify({ __stream_end_length: true })}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify({ __stream_end: true })}\n\n`);
          }
          res.write("data: [DONE]\n\n");
          res.end();  // 关闭 SSE 流
        }
        // 日志增强（永远 on，不依赖 feature flag）—— 批次 1 段 1
        appendLogAsync("claw-exec-detail.log", {
          ts: new Date().toISOString(),
          event: "chat_stream_response",
          adoptId: String(adoptId),
          agentId: String((claw as any).agentId || ""),
          runtimeAgentId,
          sessionKey,
          userId: Number((claw as any).userId || 0),
          permissionProfile: String((claw as any).permissionProfile || "starter"),
          statusCode: Number(proxyRes.statusCode || 0),
          durationMs: streamEndMs - startedAt,
          upstreamFirstChunkMs,
          upstreamBytes,
          preview: upstreamPreview.slice(0, 1000),
          // SSE diag 字段
          endReason,
          proxyResComplete: proxyRes.complete,
          proxyResDestroyed: proxyRes.destroyed,
          proxyResAborted: proxyResAbortedFlag,
          proxyResCloseFired,
          proxyResEnded: proxyResEndedFlag,
          proxyResError: proxyResErrorObj?.message ?? null,
          sawUpstreamDone,
          sawFinishReason,
          chatCompletionId,
          lastChunkAt,
          clientClosed: clientClosedFlag,
          flag: process.env.SSE_TRUNCATE_DETECT || "off",
	        });
	        restoreCoreFiles("stream_done");
	      });
	      });

	      proxyReq.on("timeout", () => { console.log("[BIZ-STREAM] proxyReq TIMEOUT"); });
	      proxyReq.on("error", (err) => {
	        if (endReason === "natural") endReason = "error";
	        proxyResErrorObj = err;
	        stopToolHeartbeat();
	        stopGatewayGapDetection();
	        if (finalized) return;
	        finalized = true;
	        markChatRunComplete(dedupSessionKey, clientRunId, "http_error");
	        if (!res.writableEnded) {
	          res.write(`data: ${JSON.stringify({ __stream_error: true, error: err.message })}\n\n`);
	          res.write("data: [DONE]\n\n");
	          res.end();
	        }
	        restoreCoreFiles("stream_request_error");
	      });

	      proxyReq.write(requestBody);
	      proxyReq.on("close", () => {
	        if (finalized) clearInterval(sseKeepaliveInterval);
	      });
	      proxyReq.end();
	      return proxyReq;
	    };

	    // 客户端断开时取消当前上游请求
	    // 关键：finalized 时短路返回——正常完成路径上 res.end() 会让 underlying socket 关闭。
	    req.on("close", () => {
	      if (finalized) {
	        clearInterval(sseKeepaliveInterval);
	        return;
	      }
	      clientClosedFlag = true;
	      if (endReason === "natural") endReason = "client_close";
	      stopToolHeartbeat();
	      stopGatewayGapDetection();
	      clearInterval(sseKeepaliveInterval);
	      activeProxyReq?.destroy();
	      restoreCoreFiles("stream_client_close");
	    });

	    startGatewayRequest(body);
	  });

}
