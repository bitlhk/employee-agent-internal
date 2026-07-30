import { describe, expect, it } from "vitest";
import { buildMcpStatusResponse } from "./mcp-status-response";

const rawPayload = {
  items: [{
    id: "wind",
    name: "Wind",
    children: [
      { serverId: "wind-stock", name: "股票" },
      { serverId: "wind-fund", name: "基金" },
    ],
  }],
  totals: {
    groups: 1,
    configuredServers: 2,
    availableServers: 2,
    invocations: 8,
  },
};

describe("MCP status response", () => {
  it("maps authorized selection and live health into one bounded response", () => {
    const response = buildMcpStatusResponse({
      rawPayload,
      selection: {
        authorizedServerIds: ["wind-stock", "wind-fund"],
        enabledServerIds: ["wind-stock"],
        disabledServerIds: ["wind-fund"],
        grantModeByServerId: { "wind-stock": "default" },
      },
      customRows: [],
      liveStatuses: {
        "wind-stock": {
          serverId: "wind-stock",
          status: "live",
          tools: [{ name: "quote", description: "行情" }],
          checkedAt: "2026-07-30T00:00:00.000Z",
        },
      },
      roleTemplate: "wealth-manager",
      liveTtlMs: 45_000,
      checkedAt: "2026-07-30T00:00:01.000Z",
    }) as any;

    expect(response.items[0].activeCount).toBe(1);
    expect(response.items[0].children).toEqual([
      expect.objectContaining({ serverId: "wind-stock", enabledForAgent: true, grantMode: "default" }),
      expect.objectContaining({ serverId: "wind-fund", enabledForAgent: false, grantMode: "optional" }),
    ]);
    expect(response.allowedServerIds).toEqual(["wind-stock", "wind-fund"]);
    expect(response.totals.activeServers).toBe(1);
    expect(response.live).toMatchObject({
      ttlMs: 45_000,
      checkedAt: "2026-07-30T00:00:01.000Z",
      serverStatuses: {
        "wind-stock": {
          status: "live",
          toolCount: 1,
          error: null,
        },
      },
    });
  });

  it("adds custom connections without applying built-in selection mapping to their group", () => {
    const response = buildMcpStatusResponse({
      rawPayload,
      selection: {
        authorizedServerIds: ["wind-stock", "wind-fund"],
        enabledServerIds: ["wind-stock"],
        disabledServerIds: ["wind-fund"],
        grantModeByServerId: {},
      },
      customRows: [
        {
          id: 41,
          publicId: "mcp_public",
          userId: 7,
          adoptId: "lgj-owner",
          name: "企业查询",
          description: "查询企业资料",
          transport: "streamable-http",
          endpointUrl: "https://mcp.example.com",
          authType: "none",
          authConfigEncrypted: null,
          headersEncrypted: null,
          selectedToolNames: ["company_search", "risk_events"],
          enabled: 1,
          healthStatus: "ready",
          lastTestedAt: new Date("2026-07-30T01:00:00.000Z"),
          lastError: null,
          createdAt: new Date("2026-07-30T00:00:00.000Z"),
          updatedAt: new Date("2026-07-30T00:00:00.000Z"),
        },
        {
          id: 42,
          publicId: "mcp_disabled",
          userId: 7,
          adoptId: "lgj-owner",
          name: "待修复连接",
          description: null,
          transport: "streamable-http",
          endpointUrl: "https://disabled.example.com",
          authType: "none",
          authConfigEncrypted: null,
          headersEncrypted: null,
          selectedToolNames: null,
          enabled: 0,
          healthStatus: "error",
          lastTestedAt: null,
          lastError: "connection failed",
          createdAt: new Date("2026-07-30T00:00:00.000Z"),
          updatedAt: new Date("2026-07-30T00:00:00.000Z"),
        },
      ] as any,
      liveStatuses: {},
      roleTemplate: "general-assistant",
      liveTtlMs: 45_000,
    }) as any;

    expect(response.items).toHaveLength(2);
    expect(response.items[1]).toMatchObject({ id: "custom-user-mcp" });
    expect(response.allowedServerIds).toEqual([
      "wind-stock",
      "wind-fund",
      "custom_user_41",
      "custom_user_42",
    ]);
    expect(response.enabledServerIds).toContain("custom_user_41");
    expect(response.disabledServerIds).toContain("custom_user_42");
    expect(response.totals).toMatchObject({
      groups: 2,
      configuredServers: 4,
      availableServers: 3,
      activeServers: 2,
    });
    expect(response.live.serverStatuses).toMatchObject({
      custom_user_41: { status: "live", toolCount: 2 },
      custom_user_42: {
        status: "unavailable",
        toolCount: 0,
        checkedAt: null,
        error: "connection failed",
      },
    });
  });
});
