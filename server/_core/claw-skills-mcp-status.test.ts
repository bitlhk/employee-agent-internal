import { describe, expect, it } from "vitest";
import { listMcpToolGroups, roleHomeConnectorStates } from "./claw-skills";

describe("managed enterprise MCP status", () => {
  it("uses the managed Chinese display name and health snapshot", () => {
    const payload = listMcpToolGroups({
      allowedServerIds: new Set(["insurance_customer_profile"]),
      managedServers: [{
        serverId: "insurance_customer_profile",
        displayName: "保险客户画像",
        description: "查询保险客户画像与客户基础信息。",
        category: "内部业务 MCP",
        enabled: true,
        ready: true,
        tools: [{ name: "list_customer_profiles", description: "查询客户列表" }],
        checkedAt: "2026-08-11T09:30:00.000Z",
        error: null,
      }],
    });

    expect(payload.items).toEqual([
      expect.objectContaining({
        id: "insurance_customer_profile",
        name: "保险客户画像",
        status: "available",
        liveStatus: "live",
        children: [expect.objectContaining({
          name: "保险客户画像",
          configured: true,
          enabled: true,
          status: "available",
          liveStatus: "live",
          tools: [expect.objectContaining({ name: "list_customer_profiles", source: "live" })],
        })],
      }),
    ]);
  });

  it("keeps a managed service unavailable when its latest health check failed", () => {
    const payload = listMcpToolGroups({
      allowedServerIds: new Set(["insurance_product_exam_points"]),
      managedServers: [{
        serverId: "insurance_product_exam_points",
        displayName: "保险产品考点",
        description: "查询保险产品详情与培训考点。",
        category: "内部业务 MCP",
        enabled: true,
        ready: false,
        tools: [],
        checkedAt: "2026-08-11T09:30:00.000Z",
        error: "upstream unavailable",
      }],
    });

    expect(payload.items[0]).toMatchObject({
      name: "保险产品考点",
      status: "disabled",
      liveStatus: "unavailable",
      children: [expect.objectContaining({
        configured: true,
        status: "disabled",
        liveStatus: "unavailable",
        liveError: "upstream unavailable",
      })],
    });
  });

  it("projects connector health into the shared role-home readiness contract", () => {
    expect(roleHomeConnectorStates({
      items: [{
        children: [
          { serverId: "ready", configured: true, status: "available", liveStatus: "live", enabledForAgent: true },
          { serverId: "degraded", configured: true, status: "disabled", liveStatus: "unavailable", enabledForAgent: true },
          { serverId: "blocked", configured: true, status: "available", liveStatus: "live", enabledForAgent: false },
        ],
      }],
    })).toEqual([
      { serverId: "ready", status: "READY" },
      { serverId: "degraded", status: "DEGRADED" },
      { serverId: "blocked", status: "BLOCKED" },
    ]);
  });
});
