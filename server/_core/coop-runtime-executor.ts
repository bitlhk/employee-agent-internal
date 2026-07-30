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

export function getCoopRuntimeExecutor(_runtime?: string | null): CoopRuntimeExecutor {
  return retiredRuntimeExecutor;
}
