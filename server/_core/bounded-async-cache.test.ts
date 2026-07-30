import { describe, expect, it, vi } from "vitest";
import { createBoundedAsyncCache } from "./bounded-async-cache";

describe("bounded async cache", () => {
  it("coalesces concurrent loads and reuses fresh results", async () => {
    let currentTime = 1_000;
    const events: string[] = [];
    const loader = vi.fn(async () => ["value"]);
    const cache = createBoundedAsyncCache<string[]>({
      ttlMs: 2_500,
      now: () => currentTime,
      onEvent: (event) => events.push(event),
    });

    await expect(Promise.all([
      cache.getOrLoad("key", loader),
      cache.getOrLoad("key", loader),
    ])).resolves.toEqual([["value"], ["value"]]);
    await expect(cache.getOrLoad("key", loader)).resolves.toEqual(["value"]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["miss", "coalesced", "hit"]);

    currentTime += 2_501;
    await cache.getOrLoad("key", loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("does not retain rejected loads", async () => {
    const loader = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValueOnce("recovered");
    const cache = createBoundedAsyncCache<string>();

    await expect(cache.getOrLoad("key", loader)).rejects.toThrow("failed");
    await expect(cache.getOrLoad("key", loader)).resolves.toBe("recovered");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("prevents in-flight data from repopulating an invalidated prefix", async () => {
    let resolveFirst: ((value: string) => void) | undefined;
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const cache = createBoundedAsyncCache<string>({ ttlMs: 10_000 });
    const loader = vi.fn<() => Promise<string>>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce("fresh");

    const staleRequest = cache.getOrLoad("agent-1\u0000status", loader);
    cache.invalidatePrefix("agent-1\u0000");
    resolveFirst?.("stale");
    await expect(staleRequest).resolves.toBe("stale");
    await expect(cache.getOrLoad("agent-1\u0000status", loader)).resolves.toBe("fresh");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("prunes expired and oldest entries at the capacity limit", async () => {
    let currentTime = 1_000;
    const cache = createBoundedAsyncCache<string>({
      ttlMs: 1_000,
      maxEntries: 10,
      now: () => currentTime,
    });
    const loaders = Array.from({ length: 12 }, (_, index) => vi.fn(async () => `v${index}`));
    for (let index = 0; index < loaders.length; index += 1) {
      await cache.getOrLoad(`key-${index}`, loaders[index]);
    }

    await cache.getOrLoad("key-0", loaders[0]);
    expect(loaders[0]).toHaveBeenCalledTimes(2);
    await cache.getOrLoad("key-11", loaders[11]);
    expect(loaders[11]).toHaveBeenCalledTimes(1);

    currentTime += 1_001;
    await cache.getOrLoad("key-11", loaders[11]);
    expect(loaders[11]).toHaveBeenCalledTimes(2);
  });

  it("clears cached and in-flight state without retaining stale results", async () => {
    let resolveLoad: ((value: string) => void) | undefined;
    const pending = new Promise<string>((resolve) => {
      resolveLoad = resolve;
    });
    const cache = createBoundedAsyncCache<string>({ ttlMs: 10_000 });
    const loader = vi.fn<() => Promise<string>>()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce("fresh");

    const staleRequest = cache.getOrLoad("key", loader);
    cache.clear();
    resolveLoad?.("stale");
    await expect(staleRequest).resolves.toBe("stale");
    await expect(cache.getOrLoad("key", loader)).resolves.toBe("fresh");
  });
});
