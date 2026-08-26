import { describe, expect, it } from "vitest";
import {
  internalManagedMcpServers,
  listMcpToolGroups,
  roleHomeConnectorStates,
} from "./claw-skills";

describe("managed enterprise MCP status", () => {
  it("projects same-process platform and risk services as live managed MCPs", () => {
    const managed = internalManagedMcpServers({
      allowedServerIds: new Set(["platform_tools", "post_loan_risk_data"]),
      roleTemplate: "post-loan-risk-control",
      checkedAt: "2026-08-26T02:00:00.000Z",
    });
    expect(managed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        serverId: "platform_tools",
        ready: true,
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "evaluate_audit_rule_eligibility" }),
        ]),
      }),
      expect.objectContaining({
        serverId: "post_loan_risk_data",
        ready: true,
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "list_risk_enterprises" }),
          expect.objectContaining({ name: "search_risk_enterprises" }),
        ]),
      }),
    ]));
  });

  it("presents the unified customer service as Customer Insight", () => {
    const payload = listMcpToolGroups({
      allowedServerIds: new Set(["customer_context"]),
      managedServers: [{
        serverId: "customer_context",
        displayName: "客户洞察",
        description: "整合当前岗位获授权的客户信息，为客户分析、服务和业务决策提供依据。",
        category: "内部业务 MCP",
        enabled: true,
        ready: true,
        tools: [{ name: "search_customers", description: "查询客户" }],
        checkedAt: "2026-08-26T02:00:00.000Z",
        error: null,
      }],
    });

    expect(payload.items).toEqual([
      expect.objectContaining({
        id: "customer_context",
        name: "客户洞察",
        children: [expect.objectContaining({
          serverId: "customer_context",
          name: "客户洞察",
          tools: [expect.objectContaining({ name: "search_customers" })],
        })],
      }),
    ]);
  });

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
