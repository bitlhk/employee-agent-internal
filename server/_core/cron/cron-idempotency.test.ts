import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob, CronJobInput } from "@shared/types/cron";

const state = vi.hoisted(() => ({
  record: undefined as any,
}));

vi.mock("../../db/cron-job-creations", () => ({
  reserveCronJobCreation: vi.fn(async (input: any) => {
    if (state.record) return { kind: "existing", record: state.record };
    state.record = { ...input, status: "pending", jobId: null, jobJson: null, errorMessage: null };
    return { kind: "created" };
  }),
  getCronJobCreation: vi.fn(async () => state.record),
  completeCronJobCreation: vi.fn(async (input: any) => {
    state.record = {
      ...state.record,
      status: "succeeded",
      jobId: input.jobId,
      jobJson: input.jobJson,
      errorMessage: null,
    };
  }),
  failCronJobCreation: vi.fn(async (input: any) => {
    state.record = { ...state.record, status: "failed", errorMessage: input.errorMessage };
  }),
}));

import {
  createCronJobIdempotently,
  CronCreationConflictError,
} from "./cron-idempotency";

const input: CronJobInput = {
  name: "每日简报",
  prompt: "生成每日市场简报",
  enabled: true,
  schedule: { kind: "cron", cronExpr: "0 9 * * *", display: "每天 09:00" },
  delivery: { targets: [{ channelId: "web", channelLabel: "当前对话" }] },
};

const job = {
  id: "cron-1",
  runtime: "jiuwenclaw",
  name: input.name,
  enabled: true,
  schedule: input.schedule,
  delivery: input.delivery,
  state: { status: "idle", totalRuns: 0, successRuns: 0 },
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
} as CronJob;

beforeEach(() => {
  state.record = undefined;
});

describe("cron creation idempotency", () => {
  it("returns the persisted result without creating a duplicate", async () => {
    const create = vi.fn(async () => job);
    await expect(createCronJobIdempotently({
      adoptId: "lgj-owner",
      idempotencyKey: "request-1",
      input,
      create,
    })).resolves.toEqual({ job, reused: false });
    await expect(createCronJobIdempotently({
      adoptId: "lgj-owner",
      idempotencyKey: "request-1",
      input,
      create,
    })).resolves.toEqual({ job, reused: true });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse of one key for a different request", async () => {
    await createCronJobIdempotently({
      adoptId: "lgj-owner",
      idempotencyKey: "request-1",
      input,
      create: async () => job,
    });
    await expect(createCronJobIdempotently({
      adoptId: "lgj-owner",
      idempotencyKey: "request-1",
      input: { ...input, prompt: "另一个任务" },
      create: async () => job,
    })).rejects.toMatchObject({
      code: "CRON_IDEMPOTENCY_CONFLICT",
      status: 409,
    } satisfies Partial<CronCreationConflictError>);
  });

  it("persists a failed attempt instead of repeating an uncertain create", async () => {
    const create = vi.fn(async () => { throw new Error("runtime timeout"); });
    await expect(createCronJobIdempotently({
      adoptId: "lgj-owner",
      idempotencyKey: "request-1",
      input,
      create,
    })).rejects.toThrow("runtime timeout");
    await expect(createCronJobIdempotently({
      adoptId: "lgj-owner",
      idempotencyKey: "request-1",
      input,
      create,
    })).rejects.toMatchObject({ code: "CRON_CREATION_PREVIOUSLY_FAILED" });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
