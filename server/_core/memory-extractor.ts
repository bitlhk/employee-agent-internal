/**
 * memory-extractor.ts - curated memory extraction.
 *
 * Mechanism:
 *   - background review prompt
 *   - memory tool behavior schema
 *   - tool calling returns add/replace/remove actions
 *
 * 平台适配:
 *   - 写入 OpenClaw workspace .md 文件（不写 MySQL）
 *   - 需要 userId → adoptId 的映射
 */

import { addMemory, replaceMemory, removeMemory, readUserMemories } from "./memory-store";

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_BASE = "https://api.deepseek.com";
const MANAGED_MEMORY_ENABLED = !/^(0|false|no|off)$/i.test(
  String(process.env.EA_MANAGED_MEMORY_ENABLED || "true"),
);
// Legacy OpenClaw-compatible extraction remains available only as an explicit
// compatibility switch. EA managed memory is the default and sole writer.
const MEMORY_ENABLED = !MANAGED_MEMORY_ENABLED && (process.env.MEMORY_ENABLED || "false") === "true";
const EXTRACT_INTERVAL = parseInt(process.env.MEMORY_EXTRACT_INTERVAL || "3", 10);

// ── Turn 计数器 ────────────────────────────────────────────────────
const turnCounters = new Map<string, number>();

function shouldExtract(userId: number, agentId: string): boolean {
  const key = `${userId}:${agentId}`;
  const count = (turnCounters.get(key) || 0) + 1;
  if (count >= EXTRACT_INTERVAL) {
    turnCounters.set(key, 0);
    return true;
  }
  turnCounters.set(key, count);
  return false;
}

// ── adoptId 缓存 ──────────────────────────────────────────────────
const adoptIdCache = new Map<number, string>();

async function resolveAdoptId(userId: number): Promise<string | null> {
  if (adoptIdCache.has(userId)) return adoptIdCache.get(userId)!;
  try {
    const { getCurrentClawByUserId } = await import("../db/claw");
    const claw = await getCurrentClawByUserId(userId);
    if (claw?.adoptId) {
      adoptIdCache.set(userId, claw.adoptId);
      return claw.adoptId;
    }
  } catch {}
  return null;
}

// ── 记忆评审提示词 ─────────────────────────────────────────────────

const MEMORY_REVIEW_PROMPT =
  "Review the conversation above and consider saving to memory if appropriate.\n\n" +
  "Focus on:\n" +
  "1. Has the user revealed things about themselves \u2014 their persona, desires, " +
  "preferences, or personal details worth remembering?\n" +
  "2. Has the user expressed expectations about how you should behave, their work " +
  "style, or ways they want you to operate?\n\n" +
  "If something stands out, save it using the memory tool. " +
  "If nothing is worth saving, just say 'Nothing to save.' and stop.";

// ── memory tool schema ────────────────────────────────────────────

const MEMORY_TOOL_DEF = {
  type: "function" as const,
  function: {
    name: "memory",
    description:
      "Save durable information to persistent memory that survives across sessions. " +
      "Memory is injected into future turns, so keep it compact and focused on facts " +
      "that will still matter later.\n\n" +
      "WHEN TO SAVE (do this proactively, do not wait to be asked):\n" +
      "- User corrects you or says 'remember this' / 'do not do that again'\n" +
      "- User shares a preference, habit, or personal detail (name, role, timezone)\n" +
      "- You discover something about the environment (OS, tools, project structure)\n" +
      "- You learn a convention, API quirk, or workflow specific to this user\n" +
      "- You identify a stable fact that will be useful again in future sessions\n\n" +
      "PRIORITY: User preferences and corrections > environment facts > procedural knowledge. " +
      "The most valuable memory prevents the user from having to repeat themselves.\n\n" +
      "Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO state.\n\n" +
      "TWO TARGETS:\n" +
      "- 'user': who the user is -- name, role, preferences, communication style, pet peeves\n" +
      "- 'memory': your notes -- environment facts, project conventions, tool quirks, lessons learned\n\n" +
      "ACTIONS: add (new entry), replace (update existing -- old_text identifies it), " +
      "remove (delete -- old_text identifies it).\n\n" +
      "SKIP: trivial/obvious info, things easily re-discovered, raw data dumps, and temporary task state.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "replace", "remove"] },
        target: { type: "string", enum: ["memory", "user"] },
        content: { type: "string", description: "The entry content. Required for add and replace." },
        old_text: { type: "string", description: "Short unique substring identifying the entry to replace or remove." },
      },
      required: ["action", "target"],
    },
  },
};

// ── 核心提取 ───────────────────────────────────────────────────────

async function doExtract(
  adoptId: string,
  agentId: string,
  userMessage: string,
  assistantReply: string,
): Promise<void> {
  if (!DEEPSEEK_API_KEY) return;

  // 构建消息：只发送当前轮、现有记忆和 review prompt。
  const existing = readUserMemories(adoptId);
  const existingBlock: string[] = [];
  if (existing.user.length > 0) {
    existingBlock.push(`[Current USER memory: ${existing.user.join(" | ")}]`);
  }
  if (existing.memory.length > 0) {
    existingBlock.push(`[Current MEMORY: ${existing.memory.join(" | ")}]`);
  }

  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    ...(existingBlock.length > 0
      ? [{ role: "system" as const, content: existingBlock.join("\n") }]
      : []),
    { role: "user", content: userMessage.slice(0, 2000) },
    { role: "assistant", content: assistantReply.slice(0, 3000) },
    { role: "user", content: MEMORY_REVIEW_PROMPT },
  ];

  const resp = await fetch(`${DEEPSEEK_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages,
      tools: [MEMORY_TOOL_DEF],
      temperature: 0.3,
      max_tokens: 512,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    console.warn(`[MEMORY-EXTRACTOR] DeepSeek ${resp.status}`);
    return;
  }

  const data = await resp.json() as any;
  const choice = data?.choices?.[0];

  // 检查 tool calls
  const toolCalls = choice?.message?.tool_calls;
  if (!toolCalls || toolCalls.length === 0) {
    console.log("[MEMORY-EXTRACTOR] nothing to save");
    return;
  }

  // 执行 tool calls
  for (const tc of toolCalls.slice(0, 3)) {
    if (tc.function?.name !== "memory") continue;
    try {
      const args = JSON.parse(tc.function.arguments);
      const action = args.action;
      const target = args.target === "user" ? "user" : "memory";
      const content = String(args.content || "").trim();
      const oldText = String(args.old_text || "").trim();

      let r: { success: boolean; error?: string } | undefined;
      if (action === "add" && content) {
        r = addMemory(adoptId, target, content);
      } else if (action === "replace" && oldText && content) {
        r = replaceMemory(adoptId, target, oldText, content);
      } else if (action === "remove" && oldText) {
        r = removeMemory(adoptId, target, oldText);
      }

      if (r?.success) {
        console.log(`[MEMORY-EXTRACTOR] ${action} OK: ${target} "${(content || oldText).slice(0, 40)}"`);
      } else if (r) {
        console.log(`[MEMORY-EXTRACTOR] ${action} skip: ${r.error}`);
      }
    } catch (e: any) {
      console.warn(`[MEMORY-EXTRACTOR] tool call failed: ${e?.message?.slice(0, 60)}`);
    }
  }
}

// ── 公开接口 ────────────────────────────────────────────────────────

export function maybeExtractMemory(
  userId: number,
  agentId: string,
  userMessage: string,
  assistantReply: string,
): void {
  if (!MEMORY_ENABLED) return;
  if (!userId || userId <= 0) return;
  if (!assistantReply || assistantReply.length < 10) return;
  if (!shouldExtract(userId, agentId)) return;

  // fire-and-forget
  setImmediate(async () => {
    try {
      const adoptId = await resolveAdoptId(userId);
      if (!adoptId) {
        console.log("[MEMORY-EXTRACTOR] no adoptId for user", userId);
        return;
      }
      await doExtract(adoptId, agentId, userMessage, assistantReply);
    } catch (e: any) {
      console.warn("[MEMORY-EXTRACTOR] uncaught:", e?.message?.slice(0, 100));
    }
  });
}
