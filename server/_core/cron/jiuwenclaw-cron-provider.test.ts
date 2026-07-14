import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

describe("JiuwenClaw cron run records", () => {
  const appRoot = mkdtempSync(path.join(tmpdir(), "ea-jiuwen-cron-"));
  let provider: typeof import("./jiuwenclaw-cron-provider");

  beforeAll(async () => {
    process.env.APP_ROOT = appRoot;
    vi.resetModules();
    provider = await import("./jiuwenclaw-cron-provider");
  });

  afterAll(() => {
    delete process.env.APP_ROOT;
    rmSync(appRoot, { recursive: true, force: true });
  });

  it("distinguishes a final callback from a preceding running placeholder", () => {
    const running = provider.recordJiuwenCronRun({
      adoptId: "lgj-test",
      taskId: "task-1",
      runId: "run-1",
      status: "running",
    });
    const completed = provider.recordJiuwenCronRun({
      adoptId: "lgj-test",
      taskId: "task-1",
      runId: "run-1",
      status: "ok",
      output: "done",
      deliveryStatus: "pending",
    });
    const repeated = provider.recordJiuwenCronRun({
      adoptId: "lgj-test",
      taskId: "task-1",
      runId: "run-1",
      status: "ok",
      output: "done",
      deliveryStatus: "pending",
    });

    expect(running.duplicate).toBe(false);
    expect(completed.duplicate).toBe(false);
    expect(repeated.duplicate).toBe(true);

    expect(provider.updateJiuwenCronRunDelivery({
      adoptId: "lgj-test",
      taskId: "task-1",
      runId: "run-1",
      deliveryStatus: "ok",
      deliveryTargetMasked: "已绑定",
    })).toBe(true);
  });
});
