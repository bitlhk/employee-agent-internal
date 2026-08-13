import { z } from "zod";
import { protectedProcedure } from "../_core/trpc";
import { feedbackOnUsedAgentMemory } from "../_core/agent-memory-context-feedback";
import { auditActor, recordAuditBestEffort } from "../_core/audit-events";
import { assertClawOwnerOrThrow } from "./helpers";

export const contextMemoryFeedbackProcedure = protectedProcedure
  .input(z.object({
    adoptId: z.string().min(1).max(64),
    memoryId: z.number().int().positive(),
    receiptId: z.string().trim().min(1).max(96),
    feedbackToken: z.string().trim().min(32).max(4096),
    action: z.enum(["correct", "update", "ignore"]),
    content: z.string().trim().min(4).max(800).optional(),
  }).superRefine((value, ctx) => {
    if (value.action === "update" && !value.content) {
      ctx.addIssue({ code: "custom", path: ["content"], message: "请填写更新后的岗位记忆" });
    }
  }))
  .mutation(async ({ input, ctx }) => {
    await assertClawOwnerOrThrow(ctx, input.adoptId);
    const memory = await feedbackOnUsedAgentMemory({
      userId: Number(ctx.user!.id),
      adoptId: input.adoptId,
      memoryId: input.memoryId,
      receiptId: input.receiptId,
      feedbackToken: input.feedbackToken,
      action: input.action,
      content: input.content,
    });
    await recordAuditBestEffort({
      action: `memory.context_receipt.${input.action}`,
      result: "success",
      severity: "info",
      actorType: "user",
      ...auditActor(ctx.user),
      targetType: "agent_memory",
      targetId: String(input.memoryId),
      agentInstanceId: input.adoptId,
      source: "claw_router",
      metadata: { receiptId: input.receiptId },
    });
    return { ok: true, memory };
  });
