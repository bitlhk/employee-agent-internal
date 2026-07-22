import { createServer } from "http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_HEALTH_FRESH_MS,
  agentHealthRouteReason,
  classifyAgentExecutionFailure,
  classifyAgentProbeStatus,
  ensureAgentAvailable,
  friendlyAgentTaskError,
  invalidateAgentHealthSnapshot,
  probeAgentEndpoint,
  resetAgentHealthStateForTests,
} from "./agent-health";

const agent = {
  id: "wind-agent",
  name: "万得金融专家",
  apiUrl: "https://agent.example.com/a2a",
  healthStatus: "unknown",
};

beforeEach(() => resetAgentHealthStateForTests());
afterEach(() => {
  delete process.env.EA_AGENT_ENDPOINT_ALLOWLIST;
});

describe("Agent health guard", () => {
  it("treats reachable HTTP responses as healthy but blocks overload and upstream failures", () => {
    for (const status of [200, 401, 403, 404, 405]) {
      expect(classifyAgentProbeStatus(status)).toMatchObject({ status: "healthy", available: true });
    }
    expect(classifyAgentProbeStatus(429)).toMatchObject({ status: "degraded", available: false });
    expect(classifyAgentProbeStatus(500)).toMatchObject({ status: "degraded", available: false });
    for (const status of [502, 503, 504]) {
      expect(classifyAgentProbeStatus(status)).toMatchObject({ status: "offline", available: false });
    }
  });

  it("reuses a fresh result and probes again after sixty seconds", async () => {
    let now = 1_000;
    const probe = vi.fn().mockResolvedValue({ status: "healthy", available: true, httpStatus: 200 });
    const persist = vi.fn().mockResolvedValue(undefined);
    await ensureAgentAvailable(agent, { now: () => now, probe, persist });
    now += AGENT_HEALTH_FRESH_MS - 1;
    await ensureAgentAvailable(agent, { now: () => now, probe, persist });
    expect(probe).toHaveBeenCalledTimes(1);
    now += 2;
    await ensureAgentAvailable(agent, { now: () => now, probe, persist });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("opens the circuit for a failed probe and returns a concise error", async () => {
    let now = 1_000;
    const probe = vi.fn().mockResolvedValue({ status: "offline", available: false, httpStatus: 503 });
    const persist = vi.fn().mockResolvedValue(undefined);
    await expect(ensureAgentAvailable(agent, { now: () => now, probe, persist }))
      .rejects.toThrow("万得金融专家暂时不可用");
    now += 30_000;
    await expect(ensureAgentAvailable(agent, { now: () => now, probe, persist }))
      .rejects.toThrow("万得金融专家暂时不可用");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith("wind-agent", "offline");
    invalidateAgentHealthSnapshot(agent.id);
    probe.mockResolvedValueOnce({ status: "healthy", available: true, httpStatus: 200 });
    await ensureAgentAvailable(agent, { now: () => now, probe, persist });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("maps task failures and hides upstream HTML", () => {
    expect(classifyAgentExecutionFailure("A2A HTTP 503: <html>down</html>"))
      .toMatchObject({ status: "offline", available: false });
    expect(classifyAgentExecutionFailure(new Error("request timed out")))
      .toMatchObject({ status: "offline", available: false });
    expect(classifyAgentExecutionFailure("A2A HTTP 401: unauthorized"))
      .toMatchObject({ status: "degraded", available: false });
    expect(classifyAgentExecutionFailure("A2A HTTP 400: invalid task")).toBeNull();
    expect(classifyAgentExecutionFailure("business validation failed")).toBeNull();
    expect(friendlyAgentTaskError("A2A HTTP 503: <html>down</html>", "万得金融专家"))
      .toBe("万得金融专家服务暂时不可用（HTTP 503），请稍后重试");
  });

  it("temporarily hides recently offline platform experts and permits half-open retry", () => {
    const now = Date.now();
    const offline = { ...agent, healthStatus: "offline", lastHealthCheck: new Date(now - 30_000) };
    expect(agentHealthRouteReason(offline, now)).toContain("暂时不可用");
    expect(agentHealthRouteReason({ ...offline, lastHealthCheck: new Date(now - 61_000) }, now)).toBe("");
  });

  it("detects a real nginx-style 503 response without running an Agent task", async () => {
    process.env.EA_AGENT_ENDPOINT_ALLOWLIST = "127.0.0.1";
    const server = createServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "text/html" });
      res.end("<html><h1>503 Service Temporarily Unavailable</h1></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    try {
      await expect(probeAgentEndpoint({ ...agent, apiUrl: `http://127.0.0.1:${address.port}/a2a` }))
        .resolves.toMatchObject({ status: "offline", available: false, httpStatus: 503 });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
