import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout, outboundFetchTimeoutMs } from "./fetch-timeout";

describe("fetchWithTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.EA_OUTBOUND_FETCH_TIMEOUT_MS;
  });

  it("aborts an upstream request after the configured timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_input: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })));

    const pending = fetchWithTimeout("https://example.com", {}, 1_000);
    const assertion = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("keeps the timeout active while the response body is being read", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_input: unknown, init?: RequestInit) => Promise.resolve(new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
        },
      }),
    ))));

    const response = await fetchWithTimeout("https://example.com", {}, 1_000);
    const assertion = expect(response.text()).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("uses the default for an invalid configured timeout", () => {
    process.env.EA_OUTBOUND_FETCH_TIMEOUT_MS = "not-a-number";
    expect(outboundFetchTimeoutMs()).toBe(30_000);
  });
});
