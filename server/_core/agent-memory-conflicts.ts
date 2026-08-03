import {
  acceptAgentMemoryConflictRecord,
  getAgentMemoryById,
  rejectAgentMemoryConflictRecord,
} from "../db";
import { appendLogAsync } from "./helpers";
import { observeMemoryConflict } from "./observability/metrics";
import { reconcileAgentMemoryChange } from "./agent-memory";

export async function acceptAgentMemoryConflict(input: {
  userId: number;
  adoptId: string;
  memoryId: number;
  conflictId: number;
}): Promise<void> {
  const existing = await getAgentMemoryById(input.userId, input.adoptId, input.memoryId);
  if (!existing || !["active", "candidate"].includes(existing.status)) throw new Error("岗位偏好不存在");
  await acceptAgentMemoryConflictRecord(input);
  observeMemoryConflict("accepted");
  await reconcileAgentMemoryChange({
    userId: input.userId,
    adoptId: input.adoptId,
    roleTemplate: existing.roleTemplate,
  });
  appendLogAsync("agent-memory.log", {
    ts: new Date().toISOString(),
    event: "memory_conflict_accepted",
    adoptId: input.adoptId,
    memoryId: input.memoryId,
    conflictId: input.conflictId,
  });
}

export async function rejectAgentMemoryConflict(input: {
  userId: number;
  adoptId: string;
  memoryId: number;
  conflictId: number;
}): Promise<void> {
  await rejectAgentMemoryConflictRecord(input);
  observeMemoryConflict("rejected");
  appendLogAsync("agent-memory.log", {
    ts: new Date().toISOString(),
    event: "memory_conflict_rejected",
    adoptId: input.adoptId,
    memoryId: input.memoryId,
    conflictId: input.conflictId,
  });
}
