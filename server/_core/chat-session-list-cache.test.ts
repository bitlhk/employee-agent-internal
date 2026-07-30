import { describe, expect, it, vi } from "vitest";
import { createChatSessionListCache } from "./chat-session-list-cache";

describe("chat session list cache", () => {
  it("coalesces concurrent scans and reuses the short-lived result", async () => {
    let currentTime = 1_000;
    const loader = vi.fn(async () => ["session-1"]);
    const cache = createChatSessionListCache<string[]>({
      ttlMs: 2_500,
      now: () => currentTime,
    });

    const [first, second] = await Promise.all([
      cache.getOrLoad("adopt-1\u0000agent-1\u000050", loader),
      cache.getOrLoad("adopt-1\u0000agent-1\u000050", loader),
    ]);
    expect(first).toEqual(["session-1"]);
    expect(second).toEqual(["session-1"]);
    expect(loader).toHaveBeenCalledTimes(1);

    await cache.getOrLoad("adopt-1\u0000agent-1\u000050", loader);
    expect(loader).toHaveBeenCalledTimes(1);

    currentTime += 2_501;
    await cache.getOrLoad("adopt-1\u0000agent-1\u000050", loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("invalidates every limit variant for one adoption", async () => {
    const cache = createChatSessionListCache<string[]>({ ttlMs: 10_000 });
    const loader = vi.fn(async () => ["session"]);
    await cache.getOrLoad("adopt-1\u0000agent\u000050", loader);
    await cache.getOrLoad("adopt-1\u0000agent\u0000100", loader);
    await cache.getOrLoad("adopt-2\u0000agent\u000050", loader);

    cache.invalidatePrefix("adopt-1\u0000");
    await cache.getOrLoad("adopt-1\u0000agent\u000050", loader);
    await cache.getOrLoad("adopt-1\u0000agent\u0000100", loader);
    await cache.getOrLoad("adopt-2\u0000agent\u000050", loader);

    expect(loader).toHaveBeenCalledTimes(5);
  });

  it("does not retain failed scans", async () => {
    const loader = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error("scan failed"))
      .mockResolvedValueOnce(["recovered"]);
    const cache = createChatSessionListCache<string[]>();

    await expect(cache.getOrLoad("adopt-1", loader)).rejects.toThrow("scan failed");
    await expect(cache.getOrLoad("adopt-1", loader)).resolves.toEqual(["recovered"]);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("does not repopulate stale data after an in-flight invalidation", async () => {
    let resolveFirst: ((value: string[]) => void) | undefined;
    const firstLoad = new Promise<string[]>((resolve) => {
      resolveFirst = resolve;
    });
    const cache = createChatSessionListCache<string[]>({ ttlMs: 10_000 });
    const loader = vi
      .fn<() => Promise<string[]>>()
      .mockReturnValueOnce(firstLoad)
      .mockResolvedValueOnce(["fresh"]);

    const staleRequest = cache.getOrLoad("adopt-1\u0000agent\u000050", loader);
    cache.invalidatePrefix("adopt-1\u0000");
    resolveFirst?.(["stale"]);
    await expect(staleRequest).resolves.toEqual(["stale"]);
    await expect(
      cache.getOrLoad("adopt-1\u0000agent\u000050", loader),
    ).resolves.toEqual(["fresh"]);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("keeps unrelated in-flight loads cacheable when another adoption is invalidated", async () => {
    let resolveFirst: ((value: string[]) => void) | undefined;
    let resolveSecond: ((value: string[]) => void) | undefined;
    const cache = createChatSessionListCache<string[]>({ ttlMs: 10_000 });
    const firstLoad = cache.getOrLoad(
      "adopt-1\u0000agent\u000050",
      () => new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );
    const secondLoad = cache.getOrLoad(
      "adopt-2\u0000agent\u000050",
      () => new Promise((resolve) => {
        resolveSecond = resolve;
      }),
    );

    cache.invalidatePrefix("adopt-1\u0000");
    resolveFirst?.(["stale-1"]);
    resolveSecond?.(["fresh-2"]);
    await expect(Promise.all([firstLoad, secondLoad])).resolves.toEqual([
      ["stale-1"],
      ["fresh-2"],
    ]);

    const firstReload = vi.fn(async () => ["fresh-1"]);
    const secondReload = vi.fn(async () => ["unexpected-2"]);
    await expect(
      cache.getOrLoad("adopt-1\u0000agent\u000050", firstReload),
    ).resolves.toEqual(["fresh-1"]);
    await expect(
      cache.getOrLoad("adopt-2\u0000agent\u000050", secondReload),
    ).resolves.toEqual(["fresh-2"]);
    expect(firstReload).toHaveBeenCalledTimes(1);
    expect(secondReload).not.toHaveBeenCalled();
  });
});
