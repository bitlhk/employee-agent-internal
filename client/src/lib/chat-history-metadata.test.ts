import { describe, expect, it } from "vitest";
import { mergeCachedAssistantMetadata } from "./chat-history-metadata";

const textKey = (message: { text?: string }) => String(message.text || "").trim();

describe("mergeCachedAssistantMetadata", () => {
  it("restores local citation metadata after canonical history hydration", () => {
    const result = mergeCachedAssistantMetadata(
      [{ role: "assistant", text: "制度回答" }],
      [{
        role: "assistant",
        text: "制度回答",
        knowledgeSources: [{ documentName: "差旅制度.pdf", page: 3 }],
      }],
      textKey,
    );

    expect(result[0].knowledgeSources).toEqual([{ documentName: "差旅制度.pdf", page: 3 }]);
  });

  it("keeps canonical metadata and still restores missing tool calls", () => {
    const result = mergeCachedAssistantMetadata(
      [{
        role: "assistant",
        text: "回答",
        knowledgeSources: [{ documentName: "canonical.pdf" }],
      }],
      [{
        role: "assistant",
        text: "回答",
        knowledgeSources: [{ documentName: "cached.pdf" }],
        toolCalls: [{ name: "search" }],
      }],
      textKey,
    );

    expect(result[0].knowledgeSources).toEqual([{ documentName: "canonical.pdf" }]);
    expect(result[0].toolCalls).toEqual([{ name: "search" }]);
  });
});
