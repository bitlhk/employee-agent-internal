import { afterEach, describe, expect, it } from "vitest";
import {
  getCapacitySnapshot,
  resetCapacityForTests,
  tryAcquireCapacity,
  waitForCapacityToDrain,
} from "./operational-capacity";

afterEach(() => resetCapacityForTests());

describe("operational capacity", () => {
  it("fails fast when a lane reaches its configured limit", () => {
    resetCapacityForTests({ chat_http: 1 });
    const release = tryAcquireCapacity("chat_http");
    expect(release).toBeTypeOf("function");
    expect(tryAcquireCapacity("chat_http")).toBeNull();
    expect(getCapacitySnapshot().chat_http).toEqual({ active: 1, limit: 1 });

    release?.();
    expect(getCapacitySnapshot().chat_http.active).toBe(0);
  });

  it("waits for held work to release", async () => {
    const release = tryAcquireCapacity("chat_ws");
    const drained = waitForCapacityToDrain(500);
    setTimeout(() => release?.(), 10);
    await expect(drained).resolves.toBe(true);
  });
});
