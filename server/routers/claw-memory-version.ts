import { z } from "zod";
import { protectedProcedure } from "../_core/trpc";
import { auditActor, recordAuditBestEffort } from "../_core/audit-events";
import { restoreAgentMemoryVersion } from "../_core/agent-memory";
import { assertClawOwnerOrThrow } from "./helpers";

export const restoreMemoryVersionProcedure = protectedProcedure
  .input(z.object({
    adoptId: z.string().min(1).max(64),
    id: z.number().int().positive(),
    version: z.number().int().positive(),
  }))
  .mutation(async ({ input, ctx }) => {
    await assertClawOwnerOrThrow(ctx, input.adoptId);
    const memory = await restoreAgentMemoryVersion({
      userId: Number(ctx.user!.id), adoptId: input.adoptId, id: input.id, version: input.version,
    });
    await recordAuditBestEffort({
      action: "memory.preference.restore", result: "success", severity: "info", actorType: "user",
      ...auditActor(ctx.user), targetType: "agent_memory", targetId: String(memory.id),
      agentInstanceId: input.adoptId, source: "claw_router",
      metadata: { restoredVersion: input.version, currentVersion: memory.version },
    });
    return memory;
  });
