import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import {
  capacityQueueGuard,
  getCapacitySnapshot,
  resetCapacityForTests,
  tryAcquireCapacity,
  waitForCapacityToDrain,
} from "./operational-capacity";

afterEach(() => resetCapacityForTests());

describe("operational capacity", () => {
  it("queues a short chat burst and dispatches in FIFO order", async () => {
    resetCapacityForTests({ chat_http: 1 });
    const guard = capacityQueueGuard("chat_http", { maxQueued: 1, maxWaitMs: 5_000 });
    const calls: string[] = [];
    const request = () => Object.assign(new EventEmitter(), { destroyed: false });
    const response = () => Object.assign(new EventEmitter(), {
      destroyed: false,
      headersSent: false,
      statusCode: 200,
      body: undefined as unknown,
      setHeader() {},
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { this.body = body; this.headersSent = true; return this; },
    });
    const firstReq = request();
    const firstRes = response();
    const secondReq = request();
    const secondRes = response();
    const rejectedReq = request();
    const rejectedRes = response();

    guard(firstReq as any, firstRes as any, () => calls.push("first"));
    guard(secondReq as any, secondRes as any, () => calls.push("second"));
    guard(rejectedReq as any, rejectedRes as any, () => calls.push("rejected"));

    expect(calls).toEqual(["first"]);
    expect(rejectedRes.statusCode).toBe(503);
    firstRes.emit("finish");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toEqual(["first", "second"]);
    secondRes.emit("finish");
  });

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
