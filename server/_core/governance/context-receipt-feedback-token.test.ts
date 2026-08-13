import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createContextReceiptMemoryFeedbackToken,
  verifyContextReceiptMemoryFeedbackToken,
} from "./context-receipt-feedback-token";

describe("context receipt memory feedback token", () => {
  const previousSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = "context-receipt-test-secret";
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  it("binds feedback to the user, adoption, receipt, and selected memory", () => {
    const signed = createContextReceiptMemoryFeedbackToken({
      userId: 7,
      adoptId: "lgj-test",
      receiptId: "crpt-1",
      memoryRefs: [{ memoryId: "11", version: 2 }, { memoryId: "12", version: 1 }],
      createdAt: "2026-08-13T08:00:00.000Z",
    });
    expect(signed).not.toBeNull();
    expect(verifyContextReceiptMemoryFeedbackToken({
      token: signed!.token,
      userId: 7,
      adoptId: "lgj-test",
      receiptId: "crpt-1",
      memoryId: 11,
      memoryVersion: 2,
      now: new Date("2026-08-14T08:00:00.000Z"),
    })).toBe(true);
    expect(verifyContextReceiptMemoryFeedbackToken({
      token: signed!.token,
      userId: 7,
      adoptId: "lgj-test",
      receiptId: "crpt-1",
      memoryId: 99,
      memoryVersion: 1,
      now: new Date("2026-08-14T08:00:00.000Z"),
    })).toBe(false);
  });

  it("rejects tampered and expired bindings", () => {
    const signed = createContextReceiptMemoryFeedbackToken({
      userId: 7,
      adoptId: "lgj-test",
      receiptId: "crpt-1",
      memoryRefs: [{ memoryId: "11", version: 2 }],
      createdAt: "2026-08-13T08:00:00.000Z",
      ttlDays: 1,
    })!;
    expect(verifyContextReceiptMemoryFeedbackToken({
      token: `${signed.token.slice(0, -1)}x`,
      userId: 7,
      adoptId: "lgj-test",
      receiptId: "crpt-1",
      memoryId: 11,
      memoryVersion: 2,
      now: new Date("2026-08-13T09:00:00.000Z"),
    })).toBe(false);
    expect(verifyContextReceiptMemoryFeedbackToken({
      token: signed.token,
      userId: 7,
      adoptId: "lgj-test",
      receiptId: "crpt-1",
      memoryId: 11,
      memoryVersion: 2,
      now: new Date("2026-08-15T08:00:00.000Z"),
    })).toBe(false);
  });
});
