import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getBackgroundWorkerSnapshot,
  resetBackgroundWorkersForTests,
  startManagedWorker,
  startManagedWorkerAsync,
  stopManagedWorkers,
} from "./background-workers";

describe("background worker supervisor", () => {
  afterEach(() => resetBackgroundWorkersForTests());

  it("starts workers once and stops them through the shared protocol", async () => {
    const stop = vi.fn();
    const start = vi.fn(() => stop);

    startManagedWorker("recycler", start);
    startManagedWorker("recycler", start);

    expect(start).toHaveBeenCalledTimes(1);
    expect(getBackgroundWorkerSnapshot()).toEqual([
      expect.objectContaining({ name: "recycler", state: "running", error: null }),
    ]);

    await stopManagedWorkers();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(getBackgroundWorkerSnapshot()[0]).toEqual(expect.objectContaining({ state: "stopped" }));
  });

  it("records asynchronous startup failures without rejecting server startup", async () => {
    await startManagedWorkerAsync("cron_delivery", async () => {
      throw new Error("module unavailable");
    });

    expect(getBackgroundWorkerSnapshot()[0]).toEqual(expect.objectContaining({
      name: "cron_delivery",
      state: "failed",
      error: "module unavailable",
    }));
  });
});
