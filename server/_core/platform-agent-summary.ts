export function summarizePlatformAgents(data: unknown): string {
  const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const agents = Array.isArray(record.agents) ? record.agents as Array<Record<string, unknown>> : [];
  if (agents.length === 0) return "No external Agents are available for this employee agent.";
  const lines = agents.map((agent) => {
    const ready = agent.routeReady ? "ready" : `not ready: ${agent.reason || "unknown"}`;
    const capabilities = Array.isArray(agent.capabilities) && agent.capabilities.length
      ? ` capabilities=${agent.capabilities.join(",")}`
      : "";
    const description = String(agent.description || "").trim();
    return `- ${agent.id}: ${agent.name} (${ready}; protocol=${agent.adapterProtocol || "unknown"}${capabilities})${description ? ` ${description}` : ""}`;
  });
  return [
    "Available external Agents:",
    ...lines,
    "",
    "Selection rule: use local skills/MCP for lightweight lookup, verification, or short explanations; use an external Agent for complete specialist analysis, batch work, formal reports, long-running tasks, or explicit user requests to call that Agent.",
  ].join("\n");
}
