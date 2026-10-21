import { retiredRuntimeMessage } from "./runtime-policy";

export type CoopRuntimeExecutionArgs = {
  requestId: number;
  targetAdoptId: string;
  claw: unknown;
  collabReq: unknown;
  execScope: unknown;
  scopeSystemPrompt: string;
  userMessage: string;
  onChunk?: (chunk: string) => void;
  onDone?: (status: string, result: string) => void;
};

export type CoopRuntimeExecutor = {
  protocol: string;
  execute(args: CoopRuntimeExecutionArgs): Promise<void>;
};

const retiredRuntimeExecutor: CoopRuntimeExecutor = {
  protocol: "runtime-retired",
  async execute(args) {
    const { updateCollabRequest } = await import("../db");
    const message = retiredRuntimeMessage();
    await updateCollabRequest(args.requestId, {
      status: "failed",
      resultSummary: message,
      completedAt: new Date(),
    } as never);
    args.onDone?.("failed", message);
  },
};

const jiuwenCollaborationExecutor: CoopRuntimeExecutor = {
  protocol: "jiuwenswarm-collaboration-v1",
  async execute(args) {
    const { getCollabRequest } = await import("../db");
    const { queueApprovedCollaboration } = await import("./collaboration/queue");
    const request = await getCollabRequest(args.requestId);
    if (!request || request.targetAdoptId !== args.targetAdoptId) throw new Error("协作执行目标不匹配");
    if (request.sessionId || request.taskType !== "scheduling" || !request.requestKey) return retiredRuntimeExecutor.execute(args);
    await queueApprovedCollaboration(request);
  },
};

export function getCoopRuntimeExecutor(runtime?: string | null, request?: { taskType?: string | null; requestKey?: string | null; sessionId?: string | null }): CoopRuntimeExecutor {
  return request?.taskType === "scheduling" && Boolean(request.requestKey) && !request.sessionId && ["jiuwenswarm", "jiuwenclaw"].includes(String(runtime)) && process.env.EA_COLLABORATION_RUNTIME_ENABLED === "true" && process.env.JIUWENCLAW_RUNTIME_ENABLED === "true" ? jiuwenCollaborationExecutor : retiredRuntimeExecutor;
}
