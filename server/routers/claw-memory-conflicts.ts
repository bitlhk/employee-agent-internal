import { z } from "zod";
import { protectedProcedure } from "../_core/trpc";
import { auditActor, recordAuditBestEffort } from "../_core/audit-events";
import {
  acceptAgentMemoryConflict,
  rejectAgentMemoryConflict,
} from "../_core/agent-memory-conflicts";
import { assertClawOwnerOrThrow } from "./helpers";

const inputSchema = z.object({
  adoptId: z.string().min(1).max(64),
  memoryId: z.number().int().positive(),
  conflictId: z.number().int().positive(),
});

function auditInput(input: z.infer<typeof inputSchema>, user: Parameters<typeof auditActor>[0], action: string) {
  return recordAuditBestEffort({
    action,
    result: "success",
    severity: "info",
    actorType: "user",
    ...auditActor(user),
    targetType: "agent_memory",
    targetId: String(input.memoryId),
    agentInstanceId: input.adoptId,
    source: "claw_router",
    metadata: { conflictId: input.conflictId },
  });
}

export const acceptMemoryConflictProcedure = protectedProcedure
  .input(inputSchema)
  .mutation(async ({ input, ctx }) => {
    await assertClawOwnerOrThrow(ctx, input.adoptId);
    await acceptAgentMemoryConflict({ userId: Number(ctx.user!.id), ...input });
    await auditInput(input, ctx.user, "memory.conflict.accept");
    return { ok: true };
  });

export const rejectMemoryConflictProcedure = protectedProcedure
  .input(inputSchema)
  .mutation(async ({ input, ctx }) => {
    await assertClawOwnerOrThrow(ctx, input.adoptId);
    await rejectAgentMemoryConflict({ userId: Number(ctx.user!.id), ...input });
    await auditInput(input, ctx.user, "memory.conflict.reject");
    return { ok: true };
  });
