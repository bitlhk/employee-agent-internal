import { createHash } from "node:crypto";
import {
  addAgentMemoryEvidenceOnce,
  getAgentMemoryById,
  listAgentMemoryVersions,
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
  memoryVersion: number;
  receiptId: string;
  feedbackToken: string;
  action: "correct" | "update" | "hide";
  content?: string;
}): Promise<{ memory: AgentMemoryRecord; status: "applied" | "already_consumed" | "updated" | "hidden" }> {
  if (!verifyContextReceiptMemoryFeedbackToken({
    token: input.feedbackToken,
    userId: input.userId,
    adoptId: input.adoptId,
    receiptId: input.receiptId,
    memoryId: input.memoryId,
    memoryVersion: input.memoryVersion,
  })) throw new Error("本次依据凭证无效或已过期，请重新执行任务");
  const existing = await getAgentMemoryById(input.userId, input.adoptId, input.memoryId);
  if (!existing || existing.status !== "active") throw new Error("本次使用的岗位记忆不存在或已失效");
  if (existing.version !== input.memoryVersion) throw new Error("这条岗位记忆已经更新，请重新执行任务后再反馈");
  if (input.action === "hide") return { memory: existing, status: "hidden" };
  if (input.action === "update") {
    if (!input.content) throw new Error("请填写更新后的岗位记忆");
    const memory = await updateAgentMemory({
      userId: input.userId,
      adoptId: input.adoptId,
      id: input.memoryId,
      content: input.content,
    });
    return { memory, status: "updated" };
  }
  const evidence = await addAgentMemoryEvidenceOnce({
    memoryId: existing.id,
    userId: input.userId,
    adoptId: input.adoptId,
    sourceType: "feedback",
    channel: "context-receipt",
    requestId: input.receiptId,
    sourceHash: sourceHash(`context-receipt:${input.receiptId}:${existing.id}:correct`),
    metadata: { receiptId: input.receiptId, action: "correct" },
  });
  const memory = await getAgentMemoryById(input.userId, input.adoptId, input.memoryId) || existing;
  return { memory, status: evidence.inserted ? "applied" : "already_consumed" };
}

function safePreview(value: string): string {
  return String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
}

export async function previewUsedAgentMemories(input: {
  userId: number;
  adoptId: string;
  receiptId: string;
  feedbackToken: string;
  memories: Array<{ memoryId: number; memoryVersion: number }>;
}) {
  const [versions, current] = await Promise.all([listAgentMemoryVersions({
    userId: input.userId,
    adoptId: input.adoptId,
    memoryIds: input.memories.map((item) => item.memoryId),
  }), Promise.all(input.memories.map((item) => getAgentMemoryById(input.userId, input.adoptId, item.memoryId)))]);
  return input.memories.map((item, index) => {
    if (!verifyContextReceiptMemoryFeedbackToken({
      token: input.feedbackToken,
      userId: input.userId,
      adoptId: input.adoptId,
      receiptId: input.receiptId,
      memoryId: item.memoryId,
      memoryVersion: item.memoryVersion,
    })) throw new Error("本次依据凭证无效或已过期，请重新执行任务");
    const historical = versions.find((candidate) => candidate.memoryId === item.memoryId && candidate.version === item.memoryVersion);
    const active = current[index]?.version === item.memoryVersion ? current[index] : null;
    const version = historical || active;
    if (!version || version.content === "[已忘记]") throw new Error("本次使用的岗位记忆版本不存在或已失效");
    return {
      memoryId: item.memoryId,
      version: item.memoryVersion,
      safePreview: safePreview(version.content),
      sourceType: version.source,
      asOf: "validFrom" in version ? version.validFrom : version.updatedAt,
    };
  });
}
