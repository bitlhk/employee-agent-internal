import { describe, expect, it } from "vitest";
import { evaluateSkillMcpReadiness } from "./skill-mcp-readiness";

const requirement = {
  servers: {
    wealth_customer: ["context_probe", "customer_list"],
  },
};

describe("skill MCP readiness", () => {
  it("leaves skills without declared dependencies unchanged", () => {
    const result = evaluateSkillMcpReadiness({
      skillId: "plain-skill",
      requirement: { servers: {} },
      authorizedServerIds: new Set(),
      configuredServers: [],
    });
    expect(result).toMatchObject({ status: "not_required", canProceed: true, servers: [] });
  });

  it("blocks a requirement that the role did not authorize", () => {
    const result = evaluateSkillMcpReadiness({
      skillId: "wealth-manager-assistant",
      requirement,
      authorizedServerIds: new Set(),
      configuredServers: [{ name: "wealth_customer", enabled: true }],
      toolsByServer: { wealth_customer: ["context_probe", "customer_list"] },
    });
    expect(result.status).toBe("blocked");
    expect(result.canProceed).toBe(false);
    expect(result.message).toContain("岗位未授权");
  });

  it("reports an agent-disabled connector separately from role authorization", () => {
    const result = evaluateSkillMcpReadiness({
      skillId: "wealth-manager-assistant",
      requirement,
      authorizedServerIds: new Set(["wealth_customer"]),
      activeServerIds: new Set(),
      configuredServers: [{ name: "wealth_customer", enabled: true }],
      toolsByServer: { wealth_customer: ["context_probe", "customer_list"] },
    });
    expect(result.status).toBe("blocked");
    expect(result.message).toContain("连接 wealth_customer 已关闭");
    expect(result.message).not.toContain("岗位未授权");
  });

  it("blocks missing runtime servers and missing required tools", () => {
    const missingServer = evaluateSkillMcpReadiness({
      skillId: "wealth-manager-assistant",
      requirement,
      authorizedServerIds: new Set(["wealth_customer"]),
      configuredServers: [],
    });
    expect(missingServer.message).toContain("未配置");

    const missingTool = evaluateSkillMcpReadiness({
      skillId: "wealth-manager-assistant",
      requirement,
      authorizedServerIds: new Set(["wealth_customer"]),
      configuredServers: [{ name: "wealth_customer", enabled: true }],
      toolsByServer: { wealth_customer: ["context_probe"] },
    });
    expect(missingTool.message).toContain("customer_list");
  });

  it("fails open only when the runtime catalog itself cannot be checked", () => {
    const result = evaluateSkillMcpReadiness({
      skillId: "wealth-manager-assistant",
      requirement,
      authorizedServerIds: new Set(["wealth_customer"]),
      configuredServers: null,
      catalogError: "connection unavailable",
    });
    expect(result).toMatchObject({ status: "unchecked", canProceed: true });
  });

  it("reports ready only when authorization, server and tools all match", () => {
    const result = evaluateSkillMcpReadiness({
      skillId: "wealth-manager-assistant",
      requirement,
      authorizedServerIds: new Set(["wealth_customer"]),
      configuredServers: [{ name: "wealth_customer", enabled: true }],
      toolsByServer: { wealth_customer: ["context_probe", "customer_list"] },
    });
    expect(result).toMatchObject({ status: "ready", canProceed: true });
    expect(result.servers[0].missingTools).toEqual([]);
  });
});
