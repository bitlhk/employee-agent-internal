export type ActiveAgentRuntime = "jiuwenclaw" | "legacy_archived" | "unsupported";

export const OPENCLAW_RUNTIME_RETIRED = true;

export function resolveActiveAgentRuntime(adoptId: unknown): ActiveAgentRuntime {
  const id = String(adoptId || "").trim().toLowerCase();
  if (id.startsWith("lgj-")) return "jiuwenclaw";
  if (id.startsWith("lgc-") || id.startsWith("lgh-")) return "legacy_archived";
  return "unsupported";
}

export function isActiveJiuwenAdoptId(adoptId: unknown): boolean {
  return resolveActiveAgentRuntime(adoptId) === "jiuwenclaw";
}

export function retiredRuntimeMessage(): string {
  return "OpenClaw runtime has been retired. Use a JiuwenSwarm adoption instead.";
}
