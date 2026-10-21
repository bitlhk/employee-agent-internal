import { beforeEach, describe, expect, it, vi } from "vitest";
const runtime = vi.hoisted(() => ({ forward: vi.fn(), owner: vi.fn() }));
vi.mock("../jiuwenclaw-bridge", () => ({
  forwardToJiuwenClaw: runtime.forward,
  isJiuwenClawRuntimeEnabled: () => true,
}));
vi.mock("../../db", () => ({ getClawByAdoptId: runtime.owner }));
import { CollaborationSseSink, isCollaborationTurnCurrent } from "./runtime";
import { collaborationOperationId } from "./operation-id";
import { runSessionId } from "../../db/collaboration-runs";
describe("isolated runtime stream and retry identity", () => {
  it("uses distinct filesystem-safe session identities for every durable turn", () => {
    const id = "4940ae8f-224a-42f7-abca-ed6559e94a9f";
    expect(runSessionId(id, 1)).toBe(`ea_collab_${id}_1`);
    expect(runSessionId(id, 2)).not.toBe(runSessionId(id, 1));
    expect(runSessionId(id, 1)).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
  it("closes an expired, cancelled or replaced model turn so it cannot occupy a dispatch slot indefinitely", () => {
    const current = {
      status: "running" as const,
      leaseToken: "lease",
      leaseUntil: new Date(2000),
    };
    expect(isCollaborationTurnCurrent(current, current, 1000)).toBe(true);
    expect(isCollaborationTurnCurrent(current, current, 2000)).toBe(false);
    expect(
      isCollaborationTurnCurrent(
        current,
        { ...current, status: "waiting" },
        1000
      )
    ).toBe(false);
    expect(
      isCollaborationTurnCurrent(
        current,
        { ...current, leaseToken: "new-lease" },
        1000
      )
    ).toBe(false);
    expect(isCollaborationTurnCurrent(current, null, 1000)).toBe(false);
  });
  beforeEach(() => vi.clearAllMocks());
  it("decodes fragmented SSE and replaces deltas with authoritative final text", () => {
    const sink = new CollaborationSseSink();
    sink.write('data: {"choices":[{"delta":{"content":"par');
    sink.write('t"}}]}\n\n');
    expect(sink.text).toBe("part");
    sink.write('data: {"__final_text":"final"}\n\n');
    sink.end();
    expect(sink.text).toBe("final");
    expect(sink.writableEnded).toBe(true);
    expect(sink.error).toBe(false);
  });
  it("does not convert errors, malformed JSON or DONE into completion evidence", () => {
    const sink = new CollaborationSseSink();
    sink.write(
      'data: broken\n\ndata: [DONE]\n\ndata: {"__stream_error":true,"message":"disconnected"}\n\n'
    );
    expect(sink.error).toBe(true);
    expect(sink.errorMessage).toBe("disconnected");
    expect(sink.text).toBe("");
  });
  it("bounds output memory", () => {
    expect(() =>
      new CollaborationSseSink().write("x".repeat(2_000_001))
    ).toThrow("limit");
  });
  it("derives stable per-goal, per-tool operation IDs and rejects malformed keys", () => {
    const key = "11111111-1111-4111-8111-111111111111";
    expect(collaborationOperationId("a", "prepare", key)).toBe(
      collaborationOperationId("a", "prepare", key)
    );
    expect(collaborationOperationId("b", "prepare", key)).not.toBe(
      collaborationOperationId("a", "prepare", key)
    );
    expect(collaborationOperationId("a", "other", key)).not.toBe(
      collaborationOperationId("a", "prepare", key)
    );
    expect(() =>
      collaborationOperationId("a", "prepare", "-".repeat(36))
    ).toThrow("UUID");
  });
});
