import { describe, expect, it, vi } from "vitest";

import {
  isEnterpriseRuntimeArtifactPath,
  resolveRuntimeFileWorkspace,
} from "./runtime-file-workspace";

describe("runtime file workspace resolution", () => {
  it("recognizes only the managed enterprise artifact root", () => {
    expect(isEnterpriseRuntimeArtifactPath("enterprise-artifacts/request/report.md")).toBe(true);
    expect(isEnterpriseRuntimeArtifactPath("enterprise-artifacts\\request\\report.md")).toBe(true);
    expect(isEnterpriseRuntimeArtifactPath("output/enterprise-artifacts/report.md")).toBe(false);
    expect(isEnterpriseRuntimeArtifactPath("enterprise-artifact/report.md")).toBe(false);
  });

  it("keeps ordinary files on the adoption runtime workspace", async () => {
    const resolveEnterpriseRoute = vi.fn();
    const result = await resolveRuntimeFileWorkspace({
      adoptId: "lgj-demo",
      dbAgentId: "jiuwen_demo",
      relativePath: "output/report.md",
      resolveEnterpriseRoute,
    });

    expect(result.runtimeAgentId).toBe("jiuwen_demo");
    expect(resolveEnterpriseRoute).not.toHaveBeenCalled();
  });

  it("uses the enterprise runtime binding for managed artifacts", async () => {
    const resolveEnterpriseRoute = vi.fn(async () => ({
      target: "enterprise" as const,
      route: {
        profile: "enterprise" as const,
        gatewayTarget: "test",
        wsUrl: "ws://test.invalid",
        binding: { runtimeAgentId: "ea_runtime_demo" },
      },
    }));
    const result = await resolveRuntimeFileWorkspace({
      adoptId: "lgj-demo",
      dbAgentId: "jiuwen_demo",
      relativePath: "enterprise-artifacts/request/report.md",
      resolveEnterpriseRoute: resolveEnterpriseRoute as never,
    });

    expect(result.runtimeAgentId).toBe("ea_runtime_demo");
    expect(resolveEnterpriseRoute).toHaveBeenCalledWith("lgj-demo");
  });
});
