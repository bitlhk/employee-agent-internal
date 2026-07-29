import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginServerDrain,
  getServerLifecycleSnapshot,
  markServerReady,
  resetServerLifecycleForTests,
  trackedRequestMiddleware,
  waitForRequestsToDrain,
} from "./operational-lifecycle";

class FakeResponse extends EventEmitter {
  statusCode = 200;
  headers = new Map<string, string>();
  payload: unknown;

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(payload: unknown): this {
    this.payload = payload;
    this.emit("finish");
    return this;
  }
}

afterEach(() => resetServerLifecycleForTests());

describe("operational lifecycle", () => {
  it("tracks an existing request until it finishes", async () => {
    markServerReady();
    const response = new FakeResponse();
    const next = vi.fn();
    trackedRequestMiddleware({} as never, response as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(getServerLifecycleSnapshot().activeRequests).toBe(1);

    beginServerDrain("test");
    const drained = waitForRequestsToDrain(500);
    response.emit("finish");
    await expect(drained).resolves.toBe(true);
    expect(getServerLifecycleSnapshot().activeRequests).toBe(0);
  });

  it("rejects new work after draining starts", () => {
    markServerReady();
    beginServerDrain("SIGTERM");
    const response = new FakeResponse();
    const next = vi.fn();
    trackedRequestMiddleware({} as never, response as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(503);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(response.payload).toMatchObject({ code: "SERVER_DRAINING" });
  });
});
