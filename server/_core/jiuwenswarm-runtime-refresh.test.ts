import { afterEach, describe, expect, it, vi } from "vitest";
import { buildJiuwenCapabilityRefreshRequest, refreshJiuwenRuntimeCapabilities } from "./jiuwenswarm-runtime-refresh";
import { WebSocketServer } from "ws";
import { once } from "node:events";

afterEach(() => vi.unstubAllEnvs());

describe("enterprise capability refresh", () => {
  it("preserves the standalone reload protocol when enterprise is disabled", async () => {
    vi.stubEnv("EA_ENTERPRISE_RUNTIME_ENABLED", "false");
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing socket address");
    vi.stubEnv("JIUWENCLAW_AGENTSERVER_WS_URL", `ws://127.0.0.1:${address.port}`);
    const requests: any[] = [];
    server.on("connection", (socket) => socket.on("message", (data) => {
      const request = JSON.parse(String(data));
      requests.push(request);
      socket.send(JSON.stringify({ request_id: request.request_id, status: "succeeded", is_final: true }));
    }));
    try {
      const getBinding = vi.fn();
      await refreshJiuwenRuntimeCapabilities("lgj-personal", { getBinding });
      expect(getBinding).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: "agent.reload_config", channel: "lgj-personal" });
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("publishes enterprise assets without contacting the standalone reload socket", async () => {
    vi.stubEnv("EA_ENTERPRISE_RUNTIME_ENABLED", "true");
    vi.stubEnv("JIUWENCLAW_AGENTSERVER_WS_URL", "invalid://must-not-be-used");
    const getBinding = vi.fn().mockResolvedValue({ runtimeProfile: "enterprise", status: "ready" });
    const refreshEnterpriseAssets = vi.fn().mockResolvedValue({ status: "ready", desiredAssetRevision: 42, publishedAssetRevision: 42 });
    await refreshJiuwenRuntimeCapabilities("lgj-test", { getBinding, refreshEnterpriseAssets });
    expect(refreshEnterpriseAssets).toHaveBeenCalledWith("lgj-test");
  });

  it("does not report stale enterprise assets as a successful refresh or fall back", async () => {
    vi.stubEnv("EA_ENTERPRISE_RUNTIME_ENABLED", "true");
    vi.stubEnv("JIUWENCLAW_AGENTSERVER_WS_URL", "invalid://must-not-be-used");
    const getBinding = vi.fn().mockResolvedValue({ runtimeProfile: "enterprise_canary", status: "ready" });
    const refreshEnterpriseAssets = vi.fn().mockResolvedValue({ status: "ready", desiredAssetRevision: 42, publishedAssetRevision: 41 });
    await expect(refreshJiuwenRuntimeCapabilities("lgj-test", { getBinding, refreshEnterpriseAssets })).rejects.toThrow("not ready");
  });
});

describe("buildJiuwenCapabilityRefreshRequest", () => {
  it("reloads agent capabilities in place for the target channel", () => {
    const request = buildJiuwenCapabilityRefreshRequest("lgj-test", "refresh-1");

    expect(request).toMatchObject({
      request_id: "refresh-1",
      identity_origin: "system",
      channel: "lgj-test",
      method: "agent.reload_config",
      is_stream: false,
      params: {
        target_channel_id: "lgj-test",
        reload_scopes: ["agent_runtime"],
      },
    });
    expect(request).not.toHaveProperty("session_id");
  });
});
