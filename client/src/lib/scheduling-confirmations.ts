export type SchedulingConfirmation = {
  kind:
    | "draft"
    | "meeting"
    | "reschedule"
    | "cascade"
    | "goal"
    | "request"
    | "availability"
    | "coordination";
  id: string;
  adoptId?: string;
};
const kinds: Record<string, SchedulingConfirmation["kind"]> = {
  start_collaboration_goal: "goal",
  coordinate_meeting_times: "coordination",
  prepare_personal_schedule_write: "draft",
  prepare_meeting_invitation: "meeting",
  prepare_meeting_reschedule: "reschedule",
  prepare_schedule_cascade: "cascade",
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function payload(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 8) return null;
  if (typeof value === "string") {
    try {
      return payload(JSON.parse(value), depth + 1);
    } catch {
      // The pinned runtime can stringify a single Python result wrapper.
      // Decode only this bounded string form; never evaluate code or prose.
      const wrapped = value.match(
        /^\{\s*['"]result['"]\s*:\s*(['"])([\s\S]*)\1\s*\}$/
      );
      if (!wrapped) return null;
      const decoded = wrapped[2].replace(
        /\\(\\|'|"|n|r|t|b|f|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/g,
        (_, escape: string) => {
          const controls: Record<string, string> = {
            n: "\n",
            r: "\r",
            t: "\t",
            b: "\b",
            f: "\f",
          };
          if (escape in controls) return controls[escape];
          if (/^[xuU]/.test(escape)) {
            const point = Number.parseInt(escape.slice(1), 16);
            return point <= 0x10ffff ? String.fromCodePoint(point) : "";
          }
          return escape;
        }
      );
      return payload(decoded, depth + 1);
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.isError === true || row.success === false) return null;
  if (row.jsonrpc === "2.0" && row.result)
    return payload(row.result, depth + 1);
  if (row.result) return payload(row.result, depth + 1);
  if (row.draftId || row.meetingId || row.id || row.goalId || row.actions)
    return row;
  if (row.data) return payload(row.data, depth + 1);
  if (Array.isArray(row.content)) {
    for (const item of row.content) {
      if (item?.type === "text") {
        const result = payload(item.text, depth + 1);
        if (result) return result;
      }
    }
  }
  return null;
}
// Only completed, named tool receipts create controls. Model prose and URLs
// never constitute a confirmation; the server reloads and verifies the owner.
export function schedulingConfirmations(
  tools: Array<{
    name: string;
    result?: string;
    status?: string;
    suppressedOriginalResult?: boolean;
  }>
): SchedulingConfirmation[] {
  const results = new Map<string, SchedulingConfirmation>();
  for (const tool of tools) {
    const name =
      tool.name
        .replace(/^mcp_platform_tools_/, "")
        .split("__")
        .pop() || tool.name;
    if (
      name === "ea_conversation_update" &&
      tool.status === "done" &&
      !tool.suppressedOriginalResult
    ) {
      const data = payload(tool.result);
      for (const action of Array.isArray(data?.actions) ? data.actions : []) {
        if (
          !action ||
          typeof action !== "object" ||
          typeof action.id !== "string"
        )
          continue;
        if (
          ![
            "draft",
            "meeting",
            "reschedule",
            "cascade",
            "goal",
            "request",
            "availability",
            "coordination",
          ].includes(action.kind)
        )
          continue;
        if (
          !(action.kind === "request"
            ? /^\d+$/.test(action.id)
            : uuid.test(action.id))
        )
          continue;
        results.set(`${action.kind}:${action.id}`, {
          kind: action.kind,
          id: action.id,
          adoptId:
            typeof action.adoptId === "string" ? action.adoptId : undefined,
        });
      }
      continue;
    }
    const kind = kinds[name];
    if (
      !kind ||
      tool.status !== "done" ||
      tool.suppressedOriginalResult ||
      !tool.result
    )
      continue;
    const data = payload(tool.result);
    const id =
      kind === "goal"
        ? data?.goalId
        : kind === "coordination"
          ? data?.id
          : kind === "meeting"
            ? data?.meetingId
            : kind === "cascade"
              ? data?.id
              : data?.draftId;
    if (typeof id === "string" && uuid.test(id))
      results.set(`${kind}:${id}`, { kind, id });
  }
  return [...results.values()];
}
