import { afterEach, describe, expect, it } from "vitest";
import { buildEnterpriseRuntimeBinding } from "./runtime-agent-bindings";

const previous = { ...process.env };

afterEach(() => {
  process.env = { ...previous };
});

describe("enterprise runtime bindings", () => {
  it("creates deterministic logical placement without a worker address", () => {
    process.env.EA_ENTERPRISE_RUNTIME_SHARDS = "16";
    const first = buildEnterpriseRuntimeBinding({
      adoptionId: "lgj-demo-1",
      agentId: "jiuwen_lgj-demo-1",
      roleTemplate: "insurance-advisor",
      assetSetFingerprint: "a".repeat(64),
    });
    const second = buildEnterpriseRuntimeBinding({
      adoptionId: "lgj-demo-1",
      agentId: "jiuwen_lgj-demo-1",
      roleTemplate: "insurance-advisor",
      assetSetFingerprint: "a".repeat(64),
    });

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      runtimeProfile: "enterprise_canary",
      fallbackProfile: "standalone",
      gatewayTarget: "shanghai_enterprise",
      runtimeBotId: "insurance-advisor",
    });
    expect(first.runtimeGroupId).toMatch(/^ea_s\d+$/u);
    expect(first.runtimeUserId).toMatch(/^ea_user_[a-f0-9]{24}$/u);
    expect(first.runtimeAgentId).toBe(first.runtimeUserId);
    expect(first.serviceId).toBe(`${first.runtimeGroupId}::insurance-advisor`);
    expect(first.workspaceKey).toMatch(/^workspace_[a-f0-9]{32}$/u);
    expect(JSON.stringify(first)).not.toContain("192.168.");
  });

  it("changes only the logical shard when the configured shard count changes", () => {
    process.env.EA_ENTERPRISE_RUNTIME_SHARDS = "8";
    const binding = buildEnterpriseRuntimeBinding({
      adoptionId: "lgj-demo-2",
      agentId: "jiuwen_lgj-demo-2",
      roleTemplate: "wealth-manager",
    });
    const shard = Number(binding.runtimeGroupId.replace("ea_s", ""));
    expect(shard).toBeGreaterThanOrEqual(0);
    expect(shard).toBeLessThan(8);
  });

  it("rejects an invalid shard count", () => {
    process.env.EA_ENTERPRISE_RUNTIME_SHARDS = "0";
    expect(() => buildEnterpriseRuntimeBinding({
      adoptionId: "lgj-demo-3",
      agentId: "jiuwen_lgj-demo-3",
      roleTemplate: "general-assistant",
    })).toThrow(/EA_ENTERPRISE_RUNTIME_SHARDS/);
  });
});
