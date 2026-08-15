import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  capacityGuard,
  capacityQueueGuard,
  getCapacitySnapshot,
  isLongLivedInternalMcpStreamRequest,
  resetCapacityForTests,
  tryAcquireCapacity,
  waitForCapacityToDrain,
} from "./operational-capacity";

afterEach(() => resetCapacityForTests());

describe("operational capacity", () => {
  it("recognizes only internal MCP GET listeners as long-lived streams", () => {
    expect(isLongLivedInternalMcpStreamRequest({
      method: "GET",
      originalUrl: "/api/internal/platform-tools/mcp?adoptId=lgj-test",
      path: "/internal/platform-tools/mcp",
    })).toBe(true);
    expect(isLongLivedInternalMcpStreamRequest({
      method: "GET",
      originalUrl: "/api/internal/role-mcp/mcp",
      path: "/internal/role-mcp/mcp",
    })).toBe(true);
    expect(isLongLivedInternalMcpStreamRequest({
      method: "POST",
      originalUrl: "/api/internal/platform-tools/mcp",
      path: "/internal/platform-tools/mcp",
    })).toBe(false);
    expect(isLongLivedInternalMcpStreamRequest({
      method: "GET",
      originalUrl: "/api/claw/chat-stream",
      path: "/claw/chat-stream",
    })).toBe(false);
  });

  it("does not charge internal MCP listeners to the short API lane", () => {
    resetCapacityForTests({ api: 1 });
    const guard = capacityGuard("api");
    const next = vi.fn();
    const response = Object.assign(new EventEmitter(), {
      setHeader() {},
      status() { return this; },
      json() { return this; },
    });
    guard({
      method: "GET",
      originalUrl: "/api/internal/custom-mcp/mcp",
      path: "/internal/custom-mcp/mcp",
    } as any, response as any, next);

    expect(next).toHaveBeenCalledOnce();
    expect(getCapacitySnapshot().api.active).toBe(0);
  });

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

  it("dispatches a queued request after its request body stream is consumed", async () => {
    resetCapacityForTests({ chat_http: 1 });
    const guard = capacityQueueGuard("chat_http", { maxQueued: 1, maxWaitMs: 5_000 });
    const calls: string[] = [];
    const response = () => Object.assign(new EventEmitter(), {
      destroyed: false,
      headersSent: false,
      setHeader() {},
      status() { return this; },
      json() { this.headersSent = true; return this; },
    });
    const firstReq = Object.assign(new EventEmitter(), { aborted: false, destroyed: false });
    const queuedReq = Object.assign(new EventEmitter(), { aborted: false, destroyed: false });
    const firstRes = response();
    const queuedRes = response();

    guard(firstReq as any, firstRes as any, () => calls.push("first"));
    guard(queuedReq as any, queuedRes as any, () => calls.push("queued"));
    queuedReq.destroyed = true;
    firstRes.emit("finish");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(calls).toEqual(["first", "queued"]);
    queuedRes.emit("finish");
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
