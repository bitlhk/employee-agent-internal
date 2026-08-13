import { createHash } from "node:crypto";
import {
  addAgentMemoryEvidence,
  getAgentMemoryById,
  updateAgentMemoryObservation,
  type AgentMemoryRecord,
} from "../db";
import { updateAgentMemory } from "./agent-memory";
import { verifyContextReceiptMemoryFeedbackToken } from "./governance/context-receipt-feedback-token";

function sourceHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function feedbackOnUsedAgentMemory(input: {
  userId: number;
  adoptId: string;
  memoryId: number;
  receiptId: string;
  feedbackToken: string;
  action: "correct" | "update" | "ignore";
  content?: string;
}): Promise<AgentMemoryRecord> {
  if (!verifyContextReceiptMemoryFeedbackToken({
    token: input.feedbackToken,
    userId: input.userId,
    adoptId: input.adoptId,
    receiptId: input.receiptId,
    memoryId: input.memoryId,
  })) throw new Error("本次依据凭证无效或已过期，请重新执行任务");
  const existing = await getAgentMemoryById(input.userId, input.adoptId, input.memoryId);
  if (!existing || existing.status !== "active") throw new Error("本次使用的岗位记忆不存在或已失效");
  if (input.action === "ignore") return existing;
  if (input.action === "update") {
    if (!input.content) throw new Error("请填写更新后的岗位记忆");
    return updateAgentMemory({
      userId: input.userId,
      adoptId: input.adoptId,
      id: input.memoryId,
      content: input.content,
    });
  }
  await addAgentMemoryEvidence({
    memoryId: existing.id,
    userId: input.userId,
    adoptId: input.adoptId,
    sourceType: "feedback",
    channel: "context-receipt",
    requestId: input.receiptId,
    sourceHash: sourceHash(`context-receipt:${input.receiptId}:${existing.id}:correct`),
    metadata: { receiptId: input.receiptId, action: "correct" },
  });
  await updateAgentMemoryObservation({
    id: existing.id,
    content: existing.content,
    kind: existing.kind,
    source: existing.source,
    confidence: Math.min(100, existing.confidence + 5),
    status: "active",
    expiresAt: existing.expiresAt ? new Date(existing.expiresAt) : null,
  });
  return await getAgentMemoryById(input.userId, input.adoptId, input.memoryId) || existing;
}
