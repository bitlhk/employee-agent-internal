import { describe, expect, it } from "vitest";
import { BoundedWorkQueue, WorkQueueFullError } from "./bounded-work-queue";

describe("BoundedWorkQueue", () => {
  it("bounds active work and rejects beyond the queue limit", async () => {
    const queue = new BoundedWorkQueue("install", 1, 1);
    let releaseFirst = () => {};
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const order: string[] = [];

    const first = queue.run(async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
      return 1;
    });
    const second = queue.run(async () => {
      order.push("second");
      return 2;
    });

    expect(queue.snapshot()).toMatchObject({ active: 1, queued: 1 });
    expect(() => queue.run(async () => 3)).toThrow(WorkQueueFullError);
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(queue.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });
});
