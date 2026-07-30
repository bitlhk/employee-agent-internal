import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InsertAgentTask } from "../../drizzle/schema";

const state = vi.hoisted(() => ({
  databaseAvailable: true,
  selectResults: [] as unknown[][],
  executed: 0,
  inserted: [] as unknown[],
}));

type QueryChain = {
  from: () => QueryChain;
  where: () => QueryChain;
  limit: () => Promise<unknown[]>;
  then: (
    resolve: (value: unknown[]) => unknown,
    reject: (error: unknown) => unknown,
  ) => Promise<unknown>;
};

function queryResult(rows: unknown[]): QueryChain {
  const chain: QueryChain = {
    from: () => chain,
    where: () => chain,
    limit: async () => rows,
    then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) => (
      Promise.resolve(rows).then(resolve, reject)
    ),
  };
  return chain;
}

vi.mock("./connection", () => ({
  getDb: vi.fn(async () => {
    if (!state.databaseAvailable) return null;
    const tx = {
      execute: vi.fn(async () => { state.executed += 1; }),
      select: vi.fn(() => queryResult(state.selectResults.shift() || [])),
      insert: vi.fn(() => ({
        values: vi.fn(async (value) => { state.inserted.push(value); }),
      })),
    };
    return {
      transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    };
  }),
}));

import { reserveAgentTask } from "./agent-task-reservation";

const task: InsertAgentTask = {
  id: "agt_test12345678",
  adoptId: "lgj-owner1",
  userId: 7,
  agentId: "expert-1",
  sourceMessageId: "message-1",
  status: "pending",
  input: "分析材料",
};

const limits = {
  maxConcurrent: 2,
  maxDailyRequests: 10,
  dayStartedAt: new Date("2026-07-30T00:00:00.000Z"),
};

beforeEach(() => {
  state.databaseAvailable = true;
  state.selectResults = [];
  state.executed = 0;
  state.inserted = [];
});

describe("agent task reservation", () => {
  it("inserts inside the expert-row lock when all limits allow it", async () => {
    state.selectResults = [[], [{ count: 1 }], [{ count: 4 }]];

    await expect(reserveAgentTask(task, limits)).resolves.toEqual({ kind: "created" });
    expect(state.executed).toBe(1);
    expect(state.inserted).toEqual([task]);
  });

  it("returns the existing idempotent task before checking quotas", async () => {
    const existing = { ...task, id: "agt_existing1234", status: "running" };
    state.selectResults = [[existing]];

    await expect(reserveAgentTask(task, limits)).resolves.toEqual({
      kind: "existing",
      task: existing,
    });
    expect(state.inserted).toEqual([]);
  });

  it("rejects an atomic reservation when concurrent work reaches the limit", async () => {
    state.selectResults = [[], [{ count: 2 }]];

    await expect(reserveAgentTask(task, limits)).resolves.toEqual({
      kind: "concurrency_exceeded",
    });
    expect(state.inserted).toEqual([]);
  });

  it("rejects an atomic reservation when the daily quota is exhausted", async () => {
    state.selectResults = [[], [{ count: 0 }], [{ count: 10 }]];

    await expect(reserveAgentTask(task, limits)).resolves.toEqual({
      kind: "daily_exceeded",
    });
    expect(state.inserted).toEqual([]);
  });

  it("skips optional checks when their limits and idempotency key are absent", async () => {
    const withoutSource = { ...task, sourceMessageId: null };
    await expect(reserveAgentTask(withoutSource, {
      ...limits,
      maxConcurrent: 0,
      maxDailyRequests: 0,
    })).resolves.toEqual({ kind: "created" });
    expect(state.inserted).toEqual([withoutSource]);
  });

  it("fails closed when the database is unavailable", async () => {
    state.databaseAvailable = false;
    await expect(reserveAgentTask(task, limits)).rejects.toThrow("DB not available");
  });
});
