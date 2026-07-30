import { describe, expect, it, vi } from "vitest";
import { createSessionActivityToucher } from "./session-activity";

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("session activity toucher", () => {
  it("coalesces repeated authenticated requests within the interval", async () => {
    let currentTime = 1_000;
    const update = vi.fn(async () => {});
    const toucher = createSessionActivityToucher({
      intervalMs: 300_000,
      now: () => currentTime,
      update,
    });

    toucher.touch(7, new Date(currentTime));
    toucher.touch(7, new Date(currentTime + 1));
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(1);

    currentTime += 300_001;
    toucher.touch(7, new Date(currentTime));
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("keeps different users independent", async () => {
    const update = vi.fn(async () => {});
    const toucher = createSessionActivityToucher({ update });

    toucher.touch(3);
    toucher.touch(4);
    await flushPromises();

    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls.map(([userId]) => userId)).toEqual([3, 4]);
  });

  it("allows a retry after a failed activity update", async () => {
    const onError = vi.fn();
    const update = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce();
    const toucher = createSessionActivityToucher({ update, onError });

    toucher.touch(9);
    await flushPromises();
    toucher.touch(9);
    await flushPromises();

    expect(update).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
