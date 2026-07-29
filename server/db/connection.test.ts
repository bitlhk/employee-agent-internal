import { describe, expect, it } from "vitest";
import { resolveDbPoolConfig } from "./connection";

describe("database pool configuration", () => {
  it("uses bounded production defaults", () => {
    expect(resolveDbPoolConfig({})).toEqual({
      connectionLimit: 10,
      maxIdle: 2,
      queueLimit: 100,
      connectTimeout: 10_000,
    });
  });

  it("bounds invalid and oversized values", () => {
    expect(resolveDbPoolConfig({
      DB_CONNECTION_LIMIT: "1000",
      DB_MAX_IDLE: "1000",
      DB_QUEUE_LIMIT: "0",
      DB_CONNECT_TIMEOUT_MS: "50",
    })).toEqual({
      connectionLimit: 100,
      maxIdle: 100,
      queueLimit: 1,
      connectTimeout: 1_000,
    });
  });
});
