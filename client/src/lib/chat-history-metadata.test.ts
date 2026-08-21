import { describe, expect, it } from "vitest";
import {
  mergeCachedAssistantMetadata,
  mergeCanonicalAssistantToolCalls,
} from "./chat-history-metadata";

const textKey = (message: { text?: string }) =>
  String(message.text || "").trim();

describe("mergeCachedAssistantMetadata", () => {
  it("restores local citation metadata after canonical history hydration", () => {
    const result = mergeCachedAssistantMetadata(
      [{ role: "assistant", text: "制度回答" }],
      [
        {
          role: "assistant",
          text: "制度回答",
          knowledgeSources: [{ documentName: "差旅制度.pdf", page: 3 }],
        },
      ],
      textKey
    );

    expect(result[0].knowledgeSources).toEqual([
      { documentName: "差旅制度.pdf", page: 3 },
    ]);
  });

  it("keeps canonical metadata and still restores missing tool calls", () => {
    const result = mergeCachedAssistantMetadata(
      [
        {
          role: "assistant",
          text: "回答",
          knowledgeSources: [{ documentName: "canonical.pdf" }],
        },
      ],
      [
        {
          role: "assistant",
          text: "回答",
          knowledgeSources: [{ documentName: "cached.pdf" }],
          toolCalls: [{ name: "search" }],
        },
      ],
      textKey
    );

    expect(result[0].knowledgeSources).toEqual([
      { documentName: "canonical.pdf" },
    ]);
    expect(result[0].toolCalls).toEqual([{ name: "search" }]);
  });

  it("enriches compact history tool calls with a trusted cached receipt", () => {
    const receipt = testReceipt();
    const streamedResult = JSON.stringify({
      content: [{ type: "text", text: "compact" }],
      _meta: { eaMetadataIssuer: "employee-agent", eaContextReceipt: receipt },
    });
    const result = mergeCachedAssistantMetadata(
      [
        {
          role: "assistant",
          text: "制度回答",
          toolCalls: [{ id: "call-1", name: "policy", result: "compact" }],
        },
      ],
      [
        {
          role: "assistant",
          text: "制度回答",
          toolCalls: [
            { id: "call-1", name: "policy", result: streamedResult },
          ],
        },
      ],
      textKey
    );

    expect((result[0].toolCalls?.[0] as { result?: string }).result).toBe(
      streamedResult
    );
  });
});

function testReceipt() {
  return {
    schema: "ea.context-receipt.v1",
    receiptId: "crpt_test",
    taskId: "WM-GT-03",
    taskLabel: "现行政策判断",
    principalFingerprint: "p".repeat(64),
    provided: {
      knowledge: [],
      businessData: [],
      memory: [],
      capabilities: [],
    },
    cited: { knowledgeAssetIds: [] },
    applied: { policyDecisions: [], capabilityExecutions: [] },
    excluded: [],
    readiness: {
      status: "READY",
      requestedOutcome: "answer",
      allowedOutcomes: [],
      deniedOutcomes: [],
      reasons: [],
      remediation: [],
      presentation: { completed: [], unavailable: [], nextSteps: [] },
      decisionFingerprint: "r".repeat(64),
    },
    createdAt: "2026-08-21T00:00:00.000Z",
    receiptFingerprint: "f".repeat(64),
  };
}

describe("mergeCanonicalAssistantToolCalls", () => {
  it("does not replace a trusted streamed receipt with compact canonical history", () => {
    const receipt = testReceipt();
    const streamedResult = JSON.stringify({
      content: [{ type: "text", text: "compact" }],
      _meta: { eaMetadataIssuer: "employee-agent", eaContextReceipt: receipt },
    });

    const result = mergeCanonicalAssistantToolCalls(
      [{ id: "call-1", name: "policy", result: "compact" }],
      [{ id: "call-1", name: "policy", result: streamedResult }]
    );

    expect(result[0].result).toBe(streamedResult);
  });

  it("uses the canonical result when the stream has no trusted receipt", () => {
    const canonicalResult = JSON.stringify({
      _meta: { eaMetadataIssuer: "employee-agent", eaContextReceipt: null },
    });
    const result = mergeCanonicalAssistantToolCalls(
      [{ id: "call-1", name: "policy", result: canonicalResult }],
      [{ id: "call-1", name: "policy", result: "streamed" }]
    );

    expect(result[0].result).toBe(canonicalResult);
  });
});
