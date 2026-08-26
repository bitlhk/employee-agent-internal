import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../db", () => ({
  getDb: vi.fn(async () => ({
    insert: () => ({
      values: (value: Record<string, unknown>) => ({
        onDuplicateKeyUpdate: async () => {
          const existing = state.rows.findIndex(row => row.receiptId === value.receiptId);
          const row = { ...value, createdAt: new Date("2026-08-26T08:00:00.000Z") };
          if (existing >= 0) state.rows[existing] = row;
          else state.rows.push(row);
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => state.rows.map(row => ({
              sessionId: row.sessionId,
              adoptionId: row.adoptionId,
              toolName: row.toolName,
              resultFingerprint: row.resultFingerprint,
              trustedMetadataJson: row.trustedMetadataJson,
              createdAt: row.createdAt,
            })),
          }),
        }),
      }),
    }),
  })),
}));

import { attachContextReceipt, buildContextReceipt } from "./context-receipt";
import {
  contextReceiptResultFingerprint,
  persistTrustedContextReceiptResult,
  restoreTrustedContextReceiptInToolResult,
  restoreTrustedContextReceiptsInHistory,
} from "./context-receipt-store";

function resultWithReceipt(text = "EA_TEST_CONTEXT:{\"status\":\"ready\"}") {
  const receipt = buildContextReceipt({
    taskId: "TEST-GT-01",
    principalFingerprint: "a".repeat(64),
    provided: { knowledge: [], businessData: [], memory: [], capabilities: [] },
    readiness: {
      status: "READY",
      requestedOutcome: "test",
      allowedOutcomes: ["test"],
      deniedOutcomes: [],
      reasons: [],
      remediation: [],
      decisionFingerprint: "b".repeat(64),
    },
    now: new Date("2026-08-26T08:00:00.000Z"),
  });
  return {
    receipt,
    result: attachContextReceipt({ content: [{ type: "text", text }] }, receipt),
    text,
  };
}

describe("trusted Context Receipt transport store", () => {
  beforeEach(() => {
    state.rows.length = 0;
  });

  it("uses the same result fingerprint before and after enterprise runtime normalization", () => {
    const { result, text } = resultWithReceipt();
    expect(contextReceiptResultFingerprint(result)).toBe(
      contextReceiptResultFingerprint({ raw_output: { result: text } }),
    );
  });

  it("restores EA-owned metadata for a matching session and tool result", async () => {
    const { result, receipt, text } = resultWithReceipt();
    expect(await persistTrustedContextReceiptResult({
      result,
      sessionId: "session-a",
      adoptionId: "lgj-test",
      toolName: "prepare_test_context",
    })).toBe(true);

    const restored = await restoreTrustedContextReceiptInToolResult({
      sessionId: "session-a",
      payload: {
        tool_name: "prepare_test_context",
        result: `{\"result\":${JSON.stringify(text)}}`,
        raw_output: { result: text },
      },
    });
    expect((restored.raw_output as any)?._meta?.eaMetadataIssuer).toBe("employee-agent");
    expect((restored.raw_output as any)?._meta?.eaContextReceipt?.receiptId).toBe(receipt.receiptId);
  });

  it("does not restore a receipt across sessions", async () => {
    const { result, text } = resultWithReceipt();
    await persistTrustedContextReceiptResult({
      result,
      sessionId: "session-a",
      toolName: "prepare_test_context",
    });
    const restored = await restoreTrustedContextReceiptInToolResult({
      sessionId: "session-b",
      payload: { tool_name: "prepare_test_context", raw_output: { result: text } },
    });
    expect((restored.raw_output as any)?._meta).toBeUndefined();
  });

  it("uses the trusted Agent identity when the managed MCP request has no session header", async () => {
    const { result, receipt, text } = resultWithReceipt();
    await persistTrustedContextReceiptResult({
      result,
      sessionId: "",
      adoptionId: "lgj-test",
      toolName: "prepare_test_context",
    });
    const restored = await restoreTrustedContextReceiptInToolResult({
      sessionId: "runtime-session",
      adoptionId: "lgj-test",
      payload: { tool_name: "prepare_test_context", raw_output: { result: text } },
    });
    expect((restored.raw_output as any)?._meta?.eaContextReceipt?.receiptId).toBe(receipt.receiptId);

    const otherAgent = await restoreTrustedContextReceiptInToolResult({
      sessionId: "other-session",
      adoptionId: "lgj-other",
      payload: { tool_name: "prepare_test_context", raw_output: { result: text } },
    });
    expect((otherAgent.raw_output as any)?._meta).toBeUndefined();
  });

  it("restores matching enterprise history records without changing unrelated results", async () => {
    const { result, receipt, text } = resultWithReceipt();
    await persistTrustedContextReceiptResult({
      result,
      sessionId: "session-a",
      toolName: "prepare_test_context",
    });
    const records = await restoreTrustedContextReceiptsInHistory([
      { event_type: "chat.tool_result", tool_name: "prepare_test_context", raw_output: { result: text } },
      { event_type: "chat.tool_result", tool_name: "other_tool", raw_output: { result: "other" } },
    ], "session-a") as Array<Record<string, any>>;
    expect(records[0]?.raw_output?._meta?.eaContextReceipt?.receiptId).toBe(receipt.receiptId);
    expect(records[1]?.raw_output?._meta).toBeUndefined();
  });
});
