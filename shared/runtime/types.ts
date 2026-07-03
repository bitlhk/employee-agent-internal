// Frontend-facing runtime-shaped events after platform wire adaptation.
// Do not confuse this with server/_core/runtime/types.ts RuntimeEvent, which
// represents raw OpenClaw-side facts before frontend enrichment.
export type ChatRuntimeFinishReason = "stop" | "length" | "tool_calls" | "function_call";

export type ChatRuntimeEvent =
  | { type: "delta"; content: string }
  | { type: "thinking"; content: string }
  | {
      type: "tool_call";
      phase: "start" | "result";
      toolCallId: string;
      name?: string;
      args?: string;
      result?: string;
      isError?: boolean;
      executor?: string;
      truncated?: boolean;
      outputFiles?: unknown;
      adoptId?: string;
      gateway?: boolean;
    }
  | {
      type: "command_output";
      phase: "delta" | "end";
      toolCallId?: string;
      output?: string;
    }
  | {
      type: "item_status";
      kind?: string;
      tool?: string;
      step?: number;
      total?: number;
      label?: string;
      elapsedMs?: number;
      text?: string;
    }
  | { type: "lifecycle_end" }
  | { type: "chat_final" }
  | { type: "stream_done" }
  | { type: "finish_reason"; reason: ChatRuntimeFinishReason }
  | { type: "error"; message: string };
