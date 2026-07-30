// RuntimeEvent is the stable transport contract consumed by the desktop bridge.
// Transport inferences such as upstream EOF and client_close intentionally stay
// outside this union.
export type RuntimeFinishReason = "stop" | "length" | "tool_calls" | "function_call";

export type RuntimeEvent =
  | { type: "delta"; content: string }
  | { type: "chat_snapshot"; content: string }
  | { type: "thinking"; content: string }
  | {
      type: "tool_call";
      phase: "start" | "result";
      toolCallId?: string;
      name?: string;
      args?: unknown;
      result?: unknown;
      isError?: boolean;
    }
  | {
      type: "command_output";
      phase: "delta" | "end";
      toolCallId?: string;
      output?: string;
    }
  | { type: "item_status"; progressText: string }
  | { type: "lifecycle_end" }
  | { type: "chat_final"; content?: string }
  | { type: "stream_done" }
  | { type: "finish_reason"; reason: RuntimeFinishReason }
  | { type: "error"; message: string };
