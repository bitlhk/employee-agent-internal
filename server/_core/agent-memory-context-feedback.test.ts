import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memory = {
  id: 11, userId: 7, adoptId: "lgj-test", roleTemplate: "wealth-manager", scope: "role",
  kind: "preference", status: "active", canonicalKey: "customer.liquidity", content: "客户关注流动性",
  source: "explicit", confidence: 80, evidenceCount: 1, version: 2,
  lastObservedAt: "2026-08-13T08:00:00.000Z", lastUsedAt: null, expiresAt: null,
  createdAt: "2026-08-01T08:00:00.000Z", updatedAt: "2026-08-13T08:00:00.000Z",
} as const;
const mocks = vi.hoisted(() => ({
  addOnce: vi.fn(),
  get: vi.fn(),
  versions: vi.fn(),
  update: vi.fn(),
}));
vi.mock("../db", () => ({
  addAgentMemoryEvidenceOnce: mocks.addOnce,
  getAgentMemoryById: mocks.get,
  listAgentMemoryVersions: mocks.versions,
}));
vi.mock("./agent-memory", () => ({ updateAgentMemory: mocks.update }));

import { feedbackOnUsedAgentMemory } from "./agent-memory-context-feedback";
import { createContextReceiptMemoryFeedbackToken } from "./governance/context-receipt-feedback-token";

describe("context receipt memory feedback", () => {
  const previousSecret = process.env.JWT_SECRET;
  beforeEach(() => {
    process.env.JWT_SECRET = "memory-feedback-idempotency-test-secret";
    mocks.get.mockReset().mockResolvedValue(memory);
    mocks.addOnce.mockReset();
    mocks.versions.mockReset();
    mocks.update.mockReset();
  });
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  it("raises confidence only when the receipt feedback evidence is consumed first", async () => {
    mocks.addOnce
      .mockResolvedValueOnce({ inserted: true, evidenceCount: 2 })
      .mockResolvedValueOnce({ inserted: false, evidenceCount: 2 });
    const signed = createContextReceiptMemoryFeedbackToken({
      userId: 7, adoptId: "lgj-test", receiptId: "crpt_1",
      memoryRefs: [{ memoryId: "11", version: 2 }], createdAt: new Date().toISOString(),
    })!;
    const input = {
      userId: 7, adoptId: "lgj-test", memoryId: 11, memoryVersion: 2,
      receiptId: "crpt_1", feedbackToken: signed.token, action: "correct" as const,
    };
    expect((await feedbackOnUsedAgentMemory(input)).status).toBe("applied");
    expect((await feedbackOnUsedAgentMemory(input)).status).toBe("already_consumed");
    expect(mocks.addOnce).toHaveBeenCalledTimes(2);
  });

  it("rejects feedback after the referenced memory version changes", async () => {
    const signed = createContextReceiptMemoryFeedbackToken({
      userId: 7, adoptId: "lgj-test", receiptId: "crpt_1",
      memoryRefs: [{ memoryId: "11", version: 2 }], createdAt: new Date().toISOString(),
    })!;
    mocks.get.mockResolvedValue({ ...memory, version: 3 });
    await expect(feedbackOnUsedAgentMemory({
      userId: 7, adoptId: "lgj-test", memoryId: 11, memoryVersion: 2,
      receiptId: "crpt_1", feedbackToken: signed.token, action: "correct",
    })).rejects.toThrow(/已经更新/);
  });
});
