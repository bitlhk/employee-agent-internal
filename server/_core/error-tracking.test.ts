import express from "express";
import type { Server } from "http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({
  createSecurityLog: vi.fn().mockResolvedValue(undefined),
  createIpManagement: vi.fn().mockResolvedValue(undefined),
  isIpBlacklisted: vi.fn().mockResolvedValue(false),
  getSystemConfigNumber: vi.fn().mockResolvedValue(-1),
}));

import {
  resetErrorTrackingStateForTests,
  shouldBlockIp,
  track4xxError,
  trackResponseErrors,
} from "./error-tracking";

function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("failed to bind test server"));
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

describe("4xx error tracking", () => {
  beforeEach(() => resetErrorTrackingStateForTests());
  afterEach(() => resetErrorTrackingStateForTests());

  it("counts one JSON response once instead of counting both json and send", async () => {
    const app = express();
    app.use(trackResponseErrors);
    app.get("/invalid", (_req, res) => res.status(404).json({ error: "missing" }));
    const { server, url } = await listen(app);
    try {
      for (let i = 0; i < 10; i++) await fetch(`${url}/invalid`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(shouldBlockIp("127.0.0.1")).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not treat normal platform validation failures as abusive traffic", async () => {
    const req = { path: "/api/claw/cron/add", ip: "203.0.113.10" } as express.Request;
    for (let i = 0; i < 25; i++) await track4xxError(req, {} as express.Response, 400);
    expect(shouldBlockIp("203.0.113.10")).toBe(false);
  });
});
