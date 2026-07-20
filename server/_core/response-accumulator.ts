/**
 * response-accumulator.ts — SSE 响应文本缓冲 + 记忆提取触发
 */

import { maybeExtractMemory } from "./memory-extractor";
import { buildMemoryBlock } from "./memory-store";

const MAX_BUFFER_CHARS = 8000;

export class ResponseAccumulator {
  private userId: number;
  private agentId: string;
  private userMessage: string;
  private buffer: string = "";
  private toolEvents: string[] = [];
  private flushed: boolean = false;

  constructor(userId: number, agentId: string, userMessage: string) {
    this.userId = userId;
    this.agentId = agentId;
    this.userMessage = userMessage;
  }

  appendDelta(text: string): void {
    if (this.flushed) return;
    if (this.buffer.length < MAX_BUFFER_CHARS) {
      this.buffer += text;
    }
  }

  addToolEvent(toolName: string, status: string): void {
    if (this.toolEvents.length < 20) {
      this.toolEvents.push(`${toolName}: ${status}`);
    }
  }

  flush(): void {
    if (this.flushed) return;
    this.flushed = true;

    const reply = this.buffer.trim();
    const fullReply = this.toolEvents.length > 0
      ? reply + "\n\n[Tools: " + this.toolEvents.join(", ") + "]"
      : reply;

    maybeExtractMemory(this.userId, this.agentId, this.userMessage, fullReply);
  }

  getBuffer(): string {
    return this.buffer;
  }
}

/**
 * 构建包含用户记忆的 system prompt（供各 agent 分支使用）
 * 需要 adoptId，通过 userId 解析
 */
export async function injectMemory(userId: number, basePrompt: string): Promise<string> {
  const managedMemoryEnabled = !/^(0|false|no|off)$/i.test(
    String(process.env.EA_MANAGED_MEMORY_ENABLED || "true"),
  );
  if (managedMemoryEnabled || (process.env.MEMORY_ENABLED || "false") !== "true") return basePrompt;
  if (!userId || userId <= 0) return basePrompt;

  try {
    // resolve adoptId
    const { getCurrentClawByUserId } = await import("../db/claw");
    const claw = await getCurrentClawByUserId(userId);
    if (!claw?.adoptId) return basePrompt;

    const memBlock = buildMemoryBlock(claw.adoptId);
    if (!memBlock) return basePrompt;
    return basePrompt + memBlock;
  } catch (e: any) {
    console.warn("[MEMORY] inject error:", e?.message?.slice(0, 80));
    return basePrompt;
  }
}
