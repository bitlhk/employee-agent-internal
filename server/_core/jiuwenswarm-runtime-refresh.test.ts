import { describe, expect, it } from "vitest";
import { buildJiuwenCapabilityRefreshRequest } from "./jiuwenswarm-runtime-refresh";

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
